import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = mkdtempSync(path.join(os.tmpdir(), 'shiyin-handoff-'));
const exe = process.env.SHIYIN_TEST_EXECUTABLE;
const app = await _electron.launch({ ...(exe ? { executablePath: path.resolve(exe) } : { args: ['.'] }), env: { ...process.env, SHIYIN_DESKTOP_DATA_DIR: path.join(root, 'profile'), SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, 'output') }, timeout: 45000 });
try {
  await app.firstWindow();
  await app.evaluate(({ app, dialog }) => {
    globalThis.testHandoffs = [];
    dialog.showMessageBox = async () => ({ response: 1 });
    globalThis.fetch = async (url, options) => { globalThis.testHandoffs.push({ path: new URL(url).pathname, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; };
    const emit = url => app.emit('open-url', { preventDefault() {} }, url);
    emit('shiyin-audio://douyin/download?id=1111111111111111111');
    emit('shiyin-audio://douyin/video?id=1111111111111111111');
    emit('shiyin-audio://douyin/video?id=1111111111111111111&url=https://example.com');
  });
  let items = [];
  for (let i = 0; i < 30; i++) {
    items = await app.evaluate(() => globalThis.testHandoffs);
    if (items.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(items.map(x => x.path).sort(), ['/api/extension/douyin', '/api/video']);
  assert.equal(items.find(x => x.path === '/api/video').body.input, 'https://www.douyin.com/video/1111111111111111111');
  console.log('PASS audio and video handoff dispatch; untrusted parameters rejected');
} finally { await app.close(); }
