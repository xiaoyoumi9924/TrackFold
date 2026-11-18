#!/usr/bin/env python3
"""Verify and safely unpack the pinned standalone Python into a new directory."""
import argparse
import hashlib
from importlib.machinery import SourceFileLoader
from pathlib import Path
import shutil
import tarfile
import sys

downloader = SourceFileLoader('asset_downloader', str(Path(__file__).with_name('download-separation-assets.py'))).load_module()

def extract_verified(archive, output, expected):
    hasher = hashlib.sha256()
    with archive.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            hasher.update(chunk)
    if hasher.hexdigest() != expected:
        raise ValueError('Python 归档校验失败，未解压。')
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        output.mkdir(mode=0o700)
    except FileExistsError:
        raise FileExistsError(f'目标目录已存在，不会覆盖：{output}')
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            for item in tar:
                if not item.name.startswith('python/') and item.name != 'python':
                    raise ValueError('归档包含非预期路径。')
                tar.extract(item, path=output, filter='data')
        if not (output / 'python/bin/python3').is_file():
            raise ValueError('归档中缺少 Python 运行程序。')
    except BaseException:
        shutil.rmtree(output)
        raise

def main():
    parser = argparse.ArgumentParser(description='Verify and unpack standalone Python for the separation component.')
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    extract_verified(args.archive.expanduser(), args.output.expanduser().absolute(), downloader.PYTHON_HASH)
    print(f'Python 已解压：{args.output / "python"}')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'解压未完成：{error}', file=sys.stderr)
        sys.exit(1)
