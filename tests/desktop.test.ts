import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { importLegacy } = createRequire(import.meta.url)('../desktop/migrate.cjs');
function fixture(t: any) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shiyin-desktop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), source = path.join(old, '.local'), target = path.join(root, 'new');
  mkdirSync(source, { recursive: true });
  const db = new DatabaseSync(path.join(source, 'tasks.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE batches(id TEXT PRIMARY KEY,value TEXT)');
  t.after(() => db.close());
  return { root, old, source, target, db };
}
test('desktop import snapshots live WAL and preserves original audio and custom paths without copying credentials', async t => {
  const f = fixture(t);
  const audio = path.join(f.root, 'audio.m4a'); writeFileSync(audio, 'original-audio');
  f.db.prepare('INSERT INTO jobs VALUES (?,?)').run('old-job', JSON.stringify({ id: 'old-job', status: 'completed', filePath: audio, outputDir: f.root }));
  writeFileSync(path.join(f.source, 'storage.json'), JSON.stringify({ version: 1, outputDir: f.root }));
  writeFileSync(path.join(f.source, 'sessions.enc'), 'do-not-copy');
  const sourceBefore = f.db.prepare('SELECT value FROM jobs').get()!.value;
  assert.equal(await importLegacy(f.old, f.target), 1);
  const imported = new DatabaseSync(path.join(f.target, 'tasks.sqlite'));
  assert.equal(JSON.parse(String(imported.prepare('SELECT value FROM jobs').get()!.value)).filePath, audio);
  imported.close();
  assert.equal(f.db.prepare('SELECT value FROM jobs').get()!.value, sourceBefore);
  assert.equal(readFileSync(audio, 'utf8'), 'original-audio');
  assert.equal(JSON.parse(readFileSync(path.join(f.target, 'storage.json'), 'utf8')).outputDir, f.root);
  assert.equal(existsSync(path.join(f.target, 'sessions.enc')), false);
  await assert.rejects(importLegacy(f.old, f.target), /不能覆盖/);
});
test('desktop import binds legacy filenames to original directory and rejects foreign records', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO jobs VALUES (?,?)').run('legacy', JSON.stringify({ id: 'legacy', status: 'completed', filename: 'original.m4a' }));
  await importLegacy(f.source, f.target);
  const copied = new DatabaseSync(path.join(f.target, 'tasks.sqlite'));
  const job = JSON.parse(String(copied.prepare('SELECT value FROM jobs').get()!.value)); copied.close();
  assert.equal(job.filePath, path.join(f.old, 'output/original.m4a'));
  f.db.prepare('UPDATE jobs SET value=?').run('{"id":"foreign"}');
  const invalid = path.join(f.root, 'invalid');
  await assert.rejects(importLegacy(f.old, invalid), /格式不受支持/);
  assert.equal(existsSync(path.join(invalid, 'tasks.sqlite')), false);
  await assert.rejects(importLegacy(f.root, invalid), /没有找到/);
});
