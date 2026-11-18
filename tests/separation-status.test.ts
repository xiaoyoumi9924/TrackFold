import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkSeparationRuntime } from '../server/separation.ts';

test('component check rejects missing and damaged model without starting Python', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiyin-component-test-'));
  const previous = process.env.SHIYIN_SEPARATOR_RUNTIME;
  process.env.SHIYIN_SEPARATOR_RUNTIME = dir;
  try {
    assert.equal((await checkSeparationRuntime()).available, false);
    await mkdir(path.join(dir, 'bin'));
    await mkdir(path.join(dir, 'models'));
    await symlink(process.execPath, path.join(dir, 'bin/python'));
    await writeFile(path.join(dir, 'models/mdx_model_data.json'), '{}');
    await writeFile(path.join(dir, 'models/UVR-MDX-NET-Inst_HQ_3.onnx'), 'damaged');
    const result = await checkSeparationRuntime();
    assert.equal(result.available, false);
    assert.match(result.message, /校验失败/);
  } finally {
    if (previous === undefined) delete process.env.SHIYIN_SEPARATOR_RUNTIME;
    else process.env.SHIYIN_SEPARATOR_RUNTIME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
