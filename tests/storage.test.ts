import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OutputStorage,
  existingDirectory,
  jobFile,
  checksum,
  matchingFile,
  publishAudio,
} from "../server/storage.ts";
import type { Job } from "../shared/types.ts";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "shiyin-storage-"));
  const data = path.join(root, "data"),
    original = path.join(root, "original"),
    next = path.join(root, "新保存位置 with spaces");
  for (const folder of [data, original, next]) mkdirSync(folder);
  return { root, data, original, next };
}
test("saved destination survives restart; a missing external folder never silently falls back", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const store = new OutputStorage(f.data, f.original);
  await store.update(f.next);
  assert.equal(
    new OutputStorage(f.data, f.original).outputDir,
    existingDirectory(f.next),
  );
  renameSync(f.next, f.next + "-away");
  const restarted = new OutputStorage(f.data, f.original);
  assert.equal(
    restarted.outputDir,
    existingDirectory(f.original).replace(
      /original$/,
      "新保存位置 with spaces",
    ),
  );
  assert.equal(restarted.describe().available, false);
  assert.equal(readdirSync(f.root).includes("新保存位置 with spaces"), false);
});
test("legacy audio settings are preserved while audio and video destinations can change independently", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  writeFileSync(path.join(f.data, "storage.json"), JSON.stringify({ version: 1, outputDir: f.next }));
  const store = new OutputStorage(f.data, f.original);
  const defaultVideo = path.join(f.original, "视频");
  assert.equal(store.outputDir, f.next);
  assert.equal(store.describe("video").outputDir, defaultVideo);
  assert.equal(store.directory("video"), existingDirectory(defaultVideo));
  await assert.rejects(store.update(f.next, "video"), /不同的保存文件夹/);

  const newAudio = path.join(f.root, "audio");
  const newVideo = path.join(f.root, "video");
  mkdirSync(newAudio);
  mkdirSync(newVideo);
  await Promise.all([store.update(newAudio), store.update(newVideo, "video")]);

  const restarted = new OutputStorage(f.data, f.original);
  assert.equal(restarted.directory("audio"), existingDirectory(newAudio));
  assert.equal(restarted.directory("video"), existingDirectory(newVideo));
  renameSync(newVideo, newVideo + "-away");
  assert.equal(restarted.describe("video").available, false);
  assert.equal(restarted.describe().available, true);
});
test("invalid folder changes preserve the saved preference and never create misspelled paths", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const store = new OutputStorage(f.data, f.original);
  const file = path.join(f.root, "not-a-folder");
  writeFileSync(file, "data");
  for (const bad of [
    "relative/path",
    path.join(f.root, "missing"),
    file,
    "\0bad",
  ])
    await assert.rejects(store.update(bad));
  assert.equal(store.outputDir, f.original);
  assert.deepEqual(readdirSync(f.data), []);
});
test("old and queued jobs keep their own locations across default-folder changes", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const store = new OutputStorage(f.data, f.original);
  const old = { filename: "old.m4a" } as Job;
  const queued = { filename: "queued.m4a", outputDir: store.outputDir } as Job;
  await store.update(f.next);
  assert.equal(jobFile(old, f.original), path.join(f.original, "old.m4a"));
  assert.equal(
    jobFile(queued, f.original),
    path.join(f.original, "queued.m4a"),
  );
  assert.notEqual(store.outputDir, queued.outputDir);
});
test("publishing never overwrites an existing file, including concurrent identical names", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "source");
  writeFileSync(source, "new-audio");
  const existing = path.join(f.next, "同名-12345678.m4a");
  writeFileSync(existing, "keep-user-file");
  const results = await Promise.all(
    [1, 2].map(() =>
      publishAudio(source, f.next, "同名", "12345678-full-id", "m4a"),
    ),
  );
  assert.equal(readFileSync(existing, "utf8"), "keep-user-file");
  assert.notEqual(results[0].filename, results[1].filename);
  for (const result of results)
    assert.equal(readFileSync(result.filePath, "utf8"), "new-audio");
  assert(!readdirSync(f.next).some((n) => n.startsWith(".shiyin")));
});
test(
  "external-disk fallback writes exclusively and preserves collisions",
  { timeout: 5000 },
  async (t) => {
    const f = fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const source = path.join(f.root, "source");
    writeFileSync(source, "new-audio");
    const existing = path.join(f.next, "song-12345678.m4a");
    writeFileSync(existing, "original");
    const unsupported = async () => {
      throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
    };
    const result = await publishAudio(
      source,
      f.next,
      "song",
      "12345678-full-id",
      "m4a",
      undefined,
      unsupported,
    );
    assert.equal(readFileSync(existing, "utf8"), "original");
    assert.equal(readFileSync(result.filePath, "utf8"), "new-audio");
    assert.equal(statSync(result.filePath).mode & 0o777, 0o600);
    assert(!readdirSync(f.next).some((n) => n.startsWith(".shiyin")));
  },
);
test("aborted publishing leaves no output, and long Chinese names remain valid UTF-8 filenames", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "source");
  writeFileSync(source, "audio");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    publishAudio(
      source,
      f.next,
      "test",
      "12345678-id",
      "m4a",
      controller.signal,
    ),
  );
  assert.deepEqual(readdirSync(f.next), []);
  const result = await publishAudio(
    source,
    f.next,
    "很长的音乐标题🎵".repeat(40),
    "12345678-id",
    "m4a",
  );
  assert(Buffer.byteLength(result.filename) < 255);
  assert(!result.filename.includes("�"));
});
test("relocation accepts the exact original after moving or renaming and rejects same-size impostors", async (t) => {
  const f = fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const original = path.join(f.original, "audio.m4a");
  writeFileSync(original, "original-audio");
  const job = {
    status: "completed",
    size: 14,
    checksum: await checksum(original),
  } as Job;
  const moved = path.join(f.next, "改过名字的音频.m4a");
  renameSync(original, moved);
  assert.equal(
    await matchingFile(job, moved),
    path.join(existingDirectory(f.next), "改过名字的音频.m4a"),
  );
  const other = path.join(f.next, "other.m4a");
  writeFileSync(other, "different-data");
  assert.equal(statSync(other).size, job.size);
  await assert.rejects(matchingFile(job, other), /内容.*不一致/);
  await assert.rejects(matchingFile({ ...job, status: "failed" }, moved), /尚未完成/);
  await assert.rejects(matchingFile({ ...job, checksum: undefined }, moved), /作为本地文件重新导入/);
});
