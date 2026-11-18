#!/usr/bin/env python3
"""Install an optional component into a new directory; never replace an existing one."""
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import venv

ROOT = Path(os.environ.get('SHIYIN_SEPARATOR_RUNTIME', str(Path.home() / 'Library/Application Support/拾音/separation-runtime'))).expanduser()
REQUIREMENTS = Path(__file__).resolve().with_name('separation-requirements-macos-arm64.txt')
FILES = {
    'UVR-MDX-NET-Inst_HQ_3.onnx': ('https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx', '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc'),
    'mdx_model_data.json': ('https://raw.githubusercontent.com/TRvlvr/application_data/main/mdx_model_data/model_data_new.json', '1aca8f9bcc57233bc714029663a9ec2345d9c7721f91e5e08f46392a879c6a9a'),
    'vr_model_data.json': ('https://raw.githubusercontent.com/TRvlvr/application_data/main/vr_model_data/model_data_new.json', '6a2021b9aa355c10f845b68c73944d47bd9e1fdf37b8a584b14ce8f88b09bb2f'),
    'download_checks.json': ('https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json', 'd3622e1fa19c161d3cf704927711b453d593a3f1eb0f2e0838c3136907935151'),
}

def main():
    if sys.platform != 'darwin' or platform.machine() != 'arm64' or sys.version_info[:2] != (3, 14) or sys.version_info[:3] == (3, 14, 1):
        raise RuntimeError('此试验安装程序需要 Apple 芯片 Mac 和 Python 3.14（不支持 3.14.1）。')
    if not REQUIREMENTS.is_file():
        raise RuntimeError('缺少组件依赖清单。')
    ROOT.parent.mkdir(parents=True, exist_ok=True)
    try:
        ROOT.mkdir(mode=0o700)
    except FileExistsError:
        raise RuntimeError(f'目标位置已经存在，不会覆盖：{ROOT}')
    try:
        print('正在准备 Python 环境与依赖；这可能需要较长时间和数 GB 空间。', flush=True)
        venv.EnvBuilder(with_pip=True).create(ROOT)
        python = ROOT / 'bin/python'
        subprocess.run([str(python), '-m', 'pip', 'install', '--prefer-binary', '-r', str(REQUIREMENTS)], check=True)
        models = ROOT / 'models'
        models.mkdir()
        cached_models = os.environ.get('SHIYIN_SEPARATOR_MODEL_CACHE')
        for name, (url, digest) in FILES.items():
            print(f'正在准备并校验 {name} …', flush=True)
            output = models / name
            if cached_models:
                shutil.copyfile(Path(cached_models) / name, output)
            else:
                subprocess.run(['/usr/bin/curl', '-fL', '--retry', '2', '--connect-timeout', '30', '--max-time', '900', '-o', str(output), url], check=True)
            hasher = hashlib.sha256()
            with output.open('rb') as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b''):
                    hasher.update(chunk)
            if hasher.hexdigest() != digest:
                raise RuntimeError(f'{name} 校验不一致，已停止安装。')
        subprocess.run([str(python), '-c', 'from audio_separator.utils.cli import main; from audio_separator.separator import Separator; import onnxruntime'], check=True, timeout=30)
        print(f'安装和基本检查完成：{ROOT}', flush=True)
    except BaseException:
        shutil.rmtree(ROOT)
        raise

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'安装未完成：{error}', file=sys.stderr)
        sys.exit(1)
