#!/usr/bin/env python3
"""Prepare experimental assets and build a new local portable component."""
import argparse
from importlib.machinery import SourceFileLoader
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
downloader = SourceFileLoader('asset_downloader', str(HERE / 'download-separation-assets.py')).load_module()
extractor = SourceFileLoader('python_extractor', str(HERE / 'extract-separation-python.py')).load_module()

def main():
    parser = argparse.ArgumentParser(description='Prepare an experimental portable separation component.')
    parser.add_argument('--assets', type=Path, required=True, help='Directory for verified downloads and resumable partial files')
    parser.add_argument('--output', type=Path, required=True, help='New component directory; must not exist')
    args = parser.parse_args()
    requested_output = args.output.expanduser().absolute()
    if requested_output.exists() or requested_output.is_symlink():
        raise FileExistsError(f'输出目录已存在，不会覆盖：{requested_output}')
    assets = args.assets.expanduser().resolve()
    output = requested_output.resolve()
    if output.exists():
        raise FileExistsError(f'输出目录已存在，不会覆盖：{output}')
    if assets == output or assets in output.parents or output in assets.parents:
        raise ValueError('缓存和组件输出必须是相互独立的目录。')
    assets.mkdir(parents=True, exist_ok=True)
    downloader.acquire(assets, downloader.PYTHON_NAME, downloader.PYTHON_URL, downloader.PYTHON_HASH)
    for name, (url, checksum) in downloader.FILES.items():
        downloader.acquire(assets, name, url, checksum)
    with tempfile.TemporaryDirectory(prefix='shiyin-python-extract-') as tmp:
        extraction = Path(tmp) / 'runtime'
        extractor.extract_verified(assets / downloader.PYTHON_NAME, extraction, downloader.PYTHON_HASH)
        subprocess.run([sys.executable, str(HERE / 'build-portable-separation.py'), '--python', str(extraction / 'python'), '--models', str(assets), '--output', str(output)], check=True)
    print(f'实验组件已构建；请在设置中检查并完成分离验收：{output}')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'组件准备未完成：{error}', file=sys.stderr)
        sys.exit(1)
