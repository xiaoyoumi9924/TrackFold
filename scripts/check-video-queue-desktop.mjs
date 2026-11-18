import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = mkdtempSync(path.join(os.tmpdir(), 'shiyin-video-queue-'));
const exe = path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音');
const app = await _electron.launch({ executablePath: exe, env: { ...process.env, SHIYIN_DESKTOP_DATA_DIR: path.join(root, 'profile'), SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, 'output') }, timeout: 45000 });
try {
  const page = await app.firstWindow();
  await page.locator('main').waitFor();
  const videoDir = path.join(root, 'custom-video');
  mkdirSync(videoDir);
  const api = (url, body) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    return { status: response.status, data: await response.json() };
  }, { url, body });
  const audio = (await api('/api/storage')).data.outputDir;
  const video = (await api('/api/storage?kind=video')).data.outputDir;
  assert.equal(video, path.join(audio, '视频'));
  const saved = await api('/api/storage', { kind: 'video', outputDir: videoDir });
  assert.equal(saved.data.outputDir, realpathSync(videoDir));
  assert.equal((await api('/api/storage')).data.outputDir, audio);
  const once = path.join(root, 'video-once');
  mkdirSync(once);
  assert.equal((await api('/api/storage/check-folder', {path:once})).data.path, realpathSync(once));
  assert.equal((await api('/api/storage/check-folder', {path:once+'-missing'})).status, 400);
  renameSync(videoDir, videoDir + '-away');
  const blocked = await api('/api/video', { input: '无效测试视频' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /文件夹不存在或不可写/);
  renameSync(videoDir + '-away', videoDir);
  await page.getByRole('button', {name:'视频提取', exact:true}).click();
  await page.getByRole('button', {name:'暂停视频队列', exact:true}).click();
  await page.getByRole('button', {name:'继续视频队列', exact:true}).waitFor();
  assert.equal((await api('/api/queue')).data.paused, false);
  const tasks = await page.evaluate(async once => {
    const submit = async (input, outputDir) => { const r = await fetch('/api/video', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({input,outputDir})}); if (!r.ok) throw Error(await r.text()); return r.json(); };
    return Promise.all([submit('无效测试视频 A', once), submit('无效测试视频 B'), submit('无效测试视频 C')]);
  }, once);
  assert.equal(new Set(tasks.map(x => x.id)).size, 3);
  assert.deepEqual((await api('/api/video/queue')).data, {paused:true,active:0,waiting:3,limit:2});
  await page.getByRole('button', {name:'任务', exact:true}).click();
  await page.getByRole('group', {name:'按文件类型筛选任务'}).getByRole('button', {name:'视频', exact:true}).click();
  assert.equal(await page.getByText(/音频队列 0/).count(), 0);
  await page.getByRole('button', {name:'队列操作', exact:true}).click();
  await page.getByRole('button', {name:'继续视频队列', exact:true}).click();
  await page.getByRole('button', {name:'视频提取', exact:true}).click();
  await page.locator('.video-result').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.video-result').length === 3);
  await page.waitForFunction(() => [...document.querySelectorAll('.video-result')].every(x => !x.textContent.includes('等待处理') && !x.textContent.includes('正在解析')));
  assert.equal(await page.locator('.video-result').count(), 3);
  assert.equal((await api('/api/storage?kind=video')).data.outputDir, realpathSync(videoDir));
  const db = new DatabaseSync(path.join(root, 'profile', 'data', 'tasks.sqlite'), {readOnly:true});
  try {
    const read = db.prepare('SELECT value FROM video_jobs WHERE id = ?');
    assert.equal(JSON.parse(read.get(tasks[0].id).value).outputDir, realpathSync(once));
    assert.equal(JSON.parse(read.get(tasks[1].id).value).outputDir, realpathSync(videoDir));
  } finally { db.close(); }
  await page.screenshot({path: '/tmp/shiyin-video-queue.png'});
  console.log('PASS independent video destination, unavailable directory reporting and three queued video results.');
} finally { await app.close(); }
