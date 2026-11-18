import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = mkdtempSync(path.join(os.tmpdir(), 'shiyin-handoff-'));
const exe = path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音');
const app = await _electron.launch({ executablePath: exe, env: { ...process.env, SHIYIN_DESKTOP_DATA_DIR: path.join(root, 'profile'), SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, 'output') }, timeout: 45000 });
try {
  await app.firstWindow();
  await app.evaluate(({app}) => {
    globalThis.testHandoffs = [];
    globalThis.fetch = async (url, options) => { globalThis.testHandoffs.push({ path: new URL(url).pathname, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; };
    const emit = url => app.emit('open-url', { preventDefault() {} }, url);
    emit('shiyin-audio://douyin/download?id=1111111111111111111');
    emit('shiyin-audio://douyin/video?id=1111111111111111111');
    emit('shiyin-audio://bilibili/download?id=BV1xx411c7mD&p=2');
    emit('shiyin-audio://bilibili/video?id=BV1xx411c7mD&p=3');
    emit('shiyin-audio://bilibili/video?id=BV1xx411c7mD&p=3&url=https://example.com');
  });
  let items = [];
  for (let i = 0; i < 30; i++) {
    items = await app.evaluate(() => globalThis.testHandoffs);
    if (items.length === 4) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(items.map(x => x.path).sort(), ['/api/extension/bilibili', '/api/extension/douyin', '/api/video', '/api/video']);
  assert.ok(items.some(x => x.body.input === 'https://www.bilibili.com/video/BV1xx411c7mD?p=3'));
  assert.deepEqual(items.find(x => x.path === '/api/extension/bilibili').body, {id:'BV1xx411c7mD', part:2});
  console.log('PASS audio and video handoff dispatch; untrusted parameters rejected');
} finally { await app.close(); }
