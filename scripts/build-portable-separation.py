#!/usr/bin/env python3
"""Build a local experimental component using an existing standalone Python and model cache."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from importlib.machinery import SourceFileLoader
assets = SourceFileLoader('separation_installer', str(Path(__file__).with_name('install-separation-component.py'))).load_module().FILES

def main():
    parser = argparse.ArgumentParser(description='Build a test-only portable separation component.')
    parser.add_argument('--python', type=Path, required=True, help='Directory containing the standalone Python 3.12 distribution')
    parser.add_argument('--models', type=Path, required=True, help='Directory containing the previously obtained model files')
    parser.add_argument('--output', type=Path, required=True, help='New output directory, must not already exist')
    args = parser.parse_args()
    source = args.python.expanduser().resolve(strict=True)
    models = args.models.expanduser().resolve(strict=True)
    output = args.output.expanduser().absolute()
    req = Path(__file__).with_name('separation-requirements-portable-macos-arm64.txt').resolve(strict=True)
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise RuntimeError('此实验仅支持 Apple 芯片 Mac。')
    version = subprocess.check_output([str(source / 'bin/python3'), '-c', 'import sys; print("%s.%s" % sys.version_info[:2])'], text=True).strip()
    if version != '3.12':
        raise RuntimeError('请提供独立 Python 3.12。')
    if source == output or source in output.parents or models == output or models in output.parents:
        raise RuntimeError('输出目录不能位于输入目录之内。')
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        output.mkdir(mode=0o700)
    except FileExistsError:
        raise RuntimeError(f'输出目录已存在，不会覆盖：{output}')
    try:
        print('复制独立 Python 并安装固定版本的依赖，可能需要数 GB 空间。', flush=True)
        shutil.copytree(source, output / 'python', symlinks=True)
        python = output / 'python/bin/python3'
        packages = output / 'packages'
        subprocess.run([str(python), '-m', 'pip', 'install', '--prefer-binary', '--target', str(packages), '-r', str(req)], check=True)
        (output / 'models').mkdir()
        for name, (_, digest) in assets.items():
            target = output / 'models' / name
            shutil.copyfile(models / name, target)
            hasher = hashlib.sha256()
            with target.open('rb') as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b''):
                    hasher.update(chunk)
            if hasher.hexdigest() != digest:
                raise RuntimeError(f'文件校验不一致：{name}')
        (output / 'bin').mkdir()
        wrapper = output / 'bin/python'
        wrapper.write_text('#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\nunset PYTHONHOME\nexport PYTHONNOUSERSITE=1\nexport PYTHONPATH="$root/packages"\nexec "$root/python/bin/python3" "$@"\n')
        wrapper.chmod(0o755)
        subprocess.run([str(wrapper), '-c', 'from audio_separator.utils.cli import main; from audio_separator.separator import Separator; import onnxruntime'], check=True, timeout=120)
        subprocess.run([str(wrapper), '-m', 'pip', '--version'], check=True, timeout=30)
        print(f'实验组件已构建：{output}', flush=True)
    except BaseException:
        shutil.rmtree(output)
        raise

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'构建未完成：{error}', file=sys.stderr)
        sys.exit(1)
