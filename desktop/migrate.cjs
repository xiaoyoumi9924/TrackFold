const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

// Read a consistent SQLite snapshot, including WAL writes from the running web edition.
async function importLegacy(selected, destination) {
  const source = fs.existsSync(path.join(selected, '.local/tasks.sqlite'))
    ? path.join(selected, '.local') : selected;
  const sourceFile = path.join(source, 'tasks.sqlite');
  const targetFile = path.join(destination, 'tasks.sqlite');
  if (!fs.existsSync(sourceFile)) throw new Error('没有找到旧版记录，请选择原项目文件夹或其中的 .local 文件夹。');
  if (path.resolve(source) === path.resolve(destination)) throw new Error('请选择旧版记录所在的文件夹。');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (fs.existsSync(targetFile)) {
    const target = new DatabaseSync(targetFile, { readOnly: true });
    try {
      for (const name of ['jobs', 'batches']) {
        const exists = target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        if (exists && target.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n)
          throw new Error('桌面版已有记录，不能覆盖。旧版记录和音频仍保留在原处。');
      }
    } finally { target.close(); }
  }
  const incoming = path.join(destination, 'import.pending.sqlite');
  fs.rmSync(incoming, { force: true });
  const original = new DatabaseSync(sourceFile, { readOnly: true });
  try { await backup(original, incoming); } finally { original.close(); }
  const snapshot = new DatabaseSync(incoming);
  let count = 0;
  try {
    if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('旧版记录未通过完整性检查。');
    const oldOutput = path.join(path.dirname(source), 'output');
    const rows = snapshot.prepare('SELECT id,value FROM jobs').all();
    for (const row of rows) {
      const job = JSON.parse(row.value);
      if (typeof job.id !== 'string' || job.id !== row.id || typeof job.status !== 'string') throw new Error('旧版任务格式不受支持。');
      job.outputDir ||= oldOutput;
      if (!job.filePath && job.filename) job.filePath = path.join(job.outputDir, job.filename);
      snapshot.prepare('UPDATE jobs SET value=? WHERE id=?').run(JSON.stringify(job), row.id);
      count++;
    }
    const hasBatches = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='batches'").get();
    if (hasBatches) for (const row of snapshot.prepare('SELECT id,value FROM batches').all()) {
      const batch = JSON.parse(row.value);
      if (batch.id !== row.id || !Array.isArray(batch.items)) throw new Error('旧版批次格式不受支持。');
      count++;
    }
    snapshot.exec('PRAGMA journal_mode=DELETE');
  } catch (error) { snapshot.close(); fs.rmSync(incoming, { force: true }); throw error; }
  snapshot.close();
  // Preferences are committed before the final DB swap; roll them back if commit fails.
  const config = path.join(destination, 'storage.json');
  const previous = fs.existsSync(config) ? fs.readFileSync(config) : null;
  try {
    let preference = { version: 1, outputDir: path.join(path.dirname(source), 'output') };
    const oldConfig = path.join(source, 'storage.json');
    if (fs.existsSync(oldConfig)) {
      const saved = JSON.parse(fs.readFileSync(oldConfig, 'utf8'));
      if (saved.version === 1 && typeof saved.outputDir === 'string' && path.isAbsolute(saved.outputDir)) preference = saved;
    }
    fs.writeFileSync(config, JSON.stringify(preference), { mode: 0o600 });
    fs.rmSync(targetFile + '-wal', { force: true });
    fs.rmSync(targetFile + '-shm', { force: true });
    fs.renameSync(incoming, targetFile);
    fs.chmodSync(targetFile, 0o600);
  } catch (error) {
    if (previous) fs.writeFileSync(config, previous); else fs.rmSync(config, { force: true });
    fs.rmSync(incoming, { force: true });
    throw error;
  }
  return count;
}
module.exports = { importLegacy };
