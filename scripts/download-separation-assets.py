#!/usr/bin/env python3
"""Download pinned experimental component assets with resumable partial files."""
import argparse
import hashlib
import os
from importlib.machinery import SourceFileLoader
from pathlib import Path
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

FILES = SourceFileLoader('separation_installer', str(Path(__file__).with_name('install-separation-component.py'))).load_module().FILES
PYTHON_NAME = 'cpython-3.12.12+20260127-aarch64-apple-darwin-install_only.tar.gz'
PYTHON_URL = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260127/cpython-3.12.12%2B20260127-aarch64-apple-darwin-install_only.tar.gz'
PYTHON_HASH = '95d7666718239b7b2fc94937453ff6689dc4db0daf42263c21ec1f9f41eefb31'
MODEL_NAME = 'UVR-MDX-NET-Inst_HQ_3.onnx'
MODEL_MIRROR = 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/UVR-MDX-NET-Inst_HQ_3.onnx'
SIZES = {PYTHON_NAME: 17743512, MODEL_NAME: 66759214}

def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()

def _segments(directory, name, urls, total, expected, count=8):
    parts = directory / (name + '.parts')
    if parts.is_symlink(): raise RuntimeError('临时目录是符号链接，已停止。')
    parts.mkdir(exist_ok=True)
    def fetch(index):
        begin, end = total * index // count, total * (index + 1) // count - 1
        path = parts / str(index)
        if path.is_symlink() or (path.exists() and not path.is_file()): raise RuntimeError('下载片段无效。')
        for attempt in range(5):
            have = path.stat().st_size if path.exists() else 0
            if have == end - begin + 1: return
            if have > end - begin + 1: raise RuntimeError('下载片段超过预期大小。')
            with tempfile.NamedTemporaryFile(dir=parts) as data, tempfile.NamedTemporaryFile(dir=parts) as headers:
                command = ['/usr/bin/curl', '--http1.1', '--fail', '--location', '--show-error', '--silent', '--connect-timeout', '20', '--max-time', '60', '--range', f'{begin + have}-{end}', '--dump-header', headers.name, '--output', data.name, urls[attempt % len(urls)]]
                subprocess.run(command, check=False)
                headers.seek(0)
                lines = headers.read().decode('iso-8859-1').splitlines()
                ranges = [line.strip().lower() for line in lines if line.lower().startswith('content-range:')]
                statuses = [line.split() for line in lines if line.startswith('HTTP/')]
                wanted = f'content-range: bytes {begin + have}-{end}/{total}'
                if statuses and len(statuses[-1]) > 1 and statuses[-1][1] == '206' and ranges and ranges[-1] == wanted:
                    data.seek(0)
                    chunk = data.read()
                    if len(chunk) > end - begin + 1 - have: raise RuntimeError('下载响应超过预期大小。')
                    with path.open('ab') as output: output.write(chunk)
            print(f'{name}：片段 {index+1}/{count} 已接收 {path.stat().st_size if path.exists() else 0}/{end-begin+1} 字节', flush=True)
        if not path.exists() or path.stat().st_size != end - begin + 1:
            raise RuntimeError(f'{name} 下载中断，片段已保留，可重新运行。')
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, range(count)))
    partial = directory / (name + '.part')
    if partial.exists() or partial.is_symlink(): raise RuntimeError('单文件临时文件已存在，未覆盖。')
    try:
        with partial.open('xb') as output:
            for i in range(count):
                with (parts / str(i)).open('rb') as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''): output.write(chunk)
        if digest(partial) != expected: raise RuntimeError(f'{name} 校验失败，未启用该文件。')
        os.link(partial, directory / name)
        partial.unlink()
        for i in range(count): (parts / str(i)).unlink()
        try: parts.rmdir()
        except OSError: pass
    except BaseException:
        raise
    print(f'下载并校验成功：{name}', flush=True)

def acquire(directory, name, url, expected):
    target, partial = directory / name, directory / (name + '.part')
    if target.is_symlink():
        raise RuntimeError(f'{name} 是符号链接，未覆盖。')
    if target.exists():
        if not target.is_file() or digest(target) != expected:
            raise RuntimeError(f'{name} 已存在但校验失败，未覆盖。')
        print(f'已校验：{name}', flush=True)
        return
    if partial.is_symlink() or (partial.exists() and not partial.is_file()):
        raise RuntimeError(f'{partial.name} 不是普通文件，已停止。')
    if partial.exists() and digest(partial) == expected:
        os.link(partial, target)
        partial.unlink()
        print(f'已校验完成的临时文件：{name}', flush=True)
        return
    if name in SIZES and not partial.exists():
        urls = [MODEL_MIRROR, url] if name == MODEL_NAME else [url]
        return _segments(directory, name, urls, SIZES[name], expected)
    command = ['/usr/bin/curl', '--fail', '--location', '--show-error', '--silent', '--connect-timeout', '20', '--max-time', '120']
    if partial.exists() and partial.stat().st_size:
        command += ['--continue-at', '-']
    command += ['--output', str(partial), url]
    completed = subprocess.run(command, check=False)
    if completed.returncode:
        raise RuntimeError(f'{name} 未下载完；已保留临时文件，可重新运行以继续。')
    if digest(partial) != expected:
        raise RuntimeError(f'{name} 校验失败；保留临时文件供检查，未启用该文件。')
    # Hard link is exclusive and never replaces an existing file.
    os.link(partial, target)
    partial.unlink()
    print(f'下载并校验成功：{name}', flush=True)

def main():
    parser = argparse.ArgumentParser(description='Prepare pinned experimental separation assets.')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    directory = args.output.expanduser().absolute()
    directory.mkdir(parents=True, exist_ok=True)
    acquire(directory, PYTHON_NAME, PYTHON_URL, PYTHON_HASH)
    for name, (url, checksum) in FILES.items():
        acquire(directory, name, url, checksum)
    print('已准备全部文件；分发条件及独立安装流程仍需核实。')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'准备未完成：{error}', file=sys.stderr)
        sys.exit(1)
