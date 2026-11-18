// Read-only check for the optional separation runtime. Never modifies the user's installation.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = process.env.SHIYIN_SEPARATOR_RUNTIME || path.join(os.homedir(), 'Library/Application Support/拾音/separation-runtime');
const python = path.join(root, 'bin/python');
const model = path.join(root, 'models/UVR-MDX-NET-Inst_HQ_3.onnx');
const metadata = path.join(root, 'models/mdx_model_data.json');
const expected = '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc';
try {
  for (const [label, file] of [['Python', python], ['模型', model], ['模型配置', metadata]]) {
    if (!existsSync(file)) throw new Error(`${label}不存在或无法访问：${file}`);
  }
  const modelConfig = JSON.parse(readFileSync(metadata, 'utf8'));
  if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) throw new Error('模型配置格式无效。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(model)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('模型文件校验失败，请重新配置组件。');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', 'import sys, importlib.metadata; from audio_separator.utils.cli import main; from audio_separator.separator import Separator; import onnxruntime; print("Python " + sys.version.split()[0] + ", audio-separator " + importlib.metadata.version("audio-separator") + ", onnxruntime " + onnxruntime.__version__)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr = (stderr + data).slice(-2000));
    const timer = setTimeout(() => { child.kill(); reject(new Error('组件启动超时。')); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`组件无法启动：${stderr.trim()}`)); });
  });
  console.log(`组件自检通过：${output}\n模型 SHA-256 校验通过。\n位置：${root}`);
} catch (error) {
  console.error(`组件自检未通过：${error.message}`);
  process.exitCode = 1;
}
