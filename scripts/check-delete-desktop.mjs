import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright';

const executablePath = path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音');
const ffmpeg = path.resolve(executablePath, '../../Resources/bin/ffmpeg');
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shiyin-delete-')));
const profile = path.join(root, 'profile');
const output = path.join(root, 'output');
const videoDir = path.join(output, '视频');
const onceDir = path.join(root, 'once');
mkdirSync(path.join(profile, 'data'), { recursive: true });
mkdirSync(videoDir, { recursive: true });
mkdirSync(onceDir);
const file = path.join(root, '音频样本.wav');
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=450:duration=2', file]);
const original = readFileSync(file);
const database = new DatabaseSync(path.join(profile, 'data', 'tasks.sqlite'));
database.exec('CREATE TABLE video_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
const insert = database.prepare('INSERT INTO video_jobs VALUES (?, ?)');
function addVideo(title, fingerprint) {
  const id = randomUUID();
  const filePath = path.join(videoDir, `${title}.mp4`);
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1', '-c:v', 'mpeg4', filePath]);
  const bytes = readFileSync(filePath);
  insert.run(id, JSON.stringify({
    input: 'https://www.bilibili.com/video/BV1Example',
    outputDir: videoDir,
    task: { id, title, status: 'completed', message: '视频已保存。', platform: 'bilibili', filePath,
      checksum: fingerprint ? createHash('sha256').update(bytes).digest('hex') : undefined },
  }));
  return { id, filePath, bytes, title };
}
const currentVideo = addVideo('当前 视频 #样本', true);
const oldVideo = addVideo('旧版视频样本', false);
database.close();

const options = { executablePath, env: { ...process.env, SHIYIN_DESKTOP_DATA_DIR: profile, SHIYIN_DESKTOP_OUTPUT_DIR: output }, timeout: 45000 };
let app;
try {
  app = await _electron.launch(options);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, onceDir);
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tab', { name: '本地文件', exact: true }).click();
  await page.locator('.upload-entry input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: '本次更改', exact: true }).click();
  await page.getByText(onceDir, {exact:true}).waitFor();
  await page.getByRole('button', { name: '提取并保存', exact: true }).click();
  const jobs = () => page.evaluate(async () => (await fetch('/api/jobs')).json());
  await page.locator('.jobs-section').getByText('已完成', { exact: true }).waitFor();
  const [job] = await jobs();
  const bytes = readFileSync(job.filePath);
  assert.equal(path.dirname(job.filePath), onceDir);
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/storage?kind=audio')).json()).outputDir), output);
  await page.getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'任务', exact:true}).click();
  const videoRow = page.getByRole('region', {name:'提取任务'}).locator('article').filter({hasText:currentVideo.title});
  await videoRow.getByRole('button', {name:'更多视频操作'}).click();
  await page.getByRole('button', {name:'播放视频', exact:true}).click();
  await page.locator('dialog[open] video').waitFor();
  await page.getByRole('button', {name:'关闭视频预览'}).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '歌单', exact: true }).click();
  const audioMenu = () => page.getByRole('button', { name: '更多歌曲操作' }).click();
  await audioMenu();
  const removeAudio = page.getByRole('button', {name:'移除记录', exact:true});
  await removeAudio.waitFor();
  assert.equal(await page.getByRole('button', {name:'删除音频', exact:true}).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const rejectTrash = id => page.evaluate(async id => {
    const response = await fetch('/api/jobs/' + id + '/remove', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({mode:'trash'}),
    });
    return response.status;
  }, id);
  assert.equal(await rejectTrash(job.id), 400);
  assert.equal((await jobs()).length, 1);
  await removeAudio.click();
  await page.getByText('已移除记录，音频文件仍在原处。').waitFor();
  assert.equal((await jobs()).length, 0);
  assert.deepEqual(readFileSync(job.filePath), bytes);
  assert.deepEqual(readFileSync(file), original);

  await page.setViewportSize({ width: 1220, height: 820 });
  await page.getByRole('button', { name: '视频提取', exact: true }).click();
  const row = video => page.locator('.video-result').filter({ has: page.getByRole('heading', { name: video.title, exact: true }) });
  chmodSync(videoDir, 0o500);
  try {
    for (const video of [currentVideo, oldVideo]) {
      await row(video).getByLabel('更多视频操作').click();
      assert.equal(await row(video).getByRole('button', {name:'删除视频', exact:true}).count(), 0);
      await row(video).getByRole('button', {name:'移除记录', exact:true}).click();
      await row(video).waitFor({state:'detached'});
      assert.deepEqual(readFileSync(video.filePath), video.bytes);
    }
  } finally { chmodSync(videoDir, 0o700); }
  assert.deepEqual(errors, []);
  await app.close();
  app = await _electron.launch(options);
  const reopened = await app.firstWindow();
  assert.deepEqual(await reopened.evaluate(async () => (await fetch('/api/jobs')).json()), []);
  const videos = await reopened.evaluate(async () => (await fetch('/api/videos')).json());
  assert.deepEqual(videos, []);
  console.log('PASS record-only deletion, rejection of trash mode, preserved media in read-only folder and restart', root);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (app) await app.close();
}
