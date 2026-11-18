// Use an isolated service/data directory. Generates only synthetic media.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.SHIYIN_TEST_URL || "http://127.0.0.1:4187";
const artifacts = process.env.SHIYIN_TEST_ARTIFACTS || "/tmp/shiyin-library-qa";
mkdirSync(artifacts, { recursive: true });
const source = path.join(artifacts, "本地配乐测试.flac");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=12",
  "-metadata",
  "title=本地配乐测试",
  "-metadata",
  "artist=测试歌手",
  "-metadata",
  `comment=qa-${Date.now()}`,
  "-c:a",
  "flac",
  source,
]);
async function api(route, body, method = "POST") {
  const r = await fetch(
    base + route,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw Error(`${r.status}: ${data.error}`);
  return data;
}
async function upload() {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(source)]), "本地配乐测试.flac");
  const r = await fetch(base + "/api/upload", { method: "POST", body: form });
  assert.equal(r.status, 200);
  return r.json();
}
async function completed(id) {
  for (let n = 0; n < 100; n++) {
    const jobs = await api("/api/jobs");
    const job = jobs.find((j) => j.id === id);
    if (job?.status === "completed") return job;
    if (job?.status === "failed") throw Error(job.message);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("media task timed out");
}
await api("/api/library/settings", {
  naming: "artist-title",
  embedCover: true,
});
const resource = await upload();
assert.equal(resource.artist, "测试歌手");
const first = await api("/api/jobs", {
  token: resource.token,
  format: "original",
  metadata: { title: "歌曲（现场版）", artist: "测试歌手", album: "测试专辑" },
});
const original = await completed(first.id);
assert.match(
  original.filename,
  /^测试歌手 - 歌曲（现场版）(?: \(\d+\))?\.flac$/,
);
const sourceBytes = readFileSync(original.filePath);
const tags = JSON.parse(
  execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-of", "json", original.filePath],
    { encoding: "utf8" },
  ),
).format.tags;
assert.equal(tags.artist, "测试歌手");
assert.equal(tags.album, "测试专辑");
const again = await upload();
const match = await api("/api/library/match", {
  token: again.token,
  choice: "original",
  format: "original",
});
assert.equal(match.job.id, original.id);
const reused = await api("/api/jobs", {
  token: again.token,
  format: "original",
});
assert.equal(reused.id, original.id);
const third = await upload();
const copy = await completed(
  (
    await api("/api/jobs", {
      token: third.token,
      format: "original",
      forceCopy: true,
      metadata: original.metadata,
    })
  ).id,
);
assert.notEqual(copy.filePath, original.filePath);
assert.match(copy.filename, /\(\d+\)\.flac$/);
console.log(
  "PASS local tags, readable names, cross-import history reuse and explicit non-overwriting copies",
);

const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "歌单", exact: true }).click();
  const row = page
    .locator(".job-row")
    .filter({
      has: page.getByRole("heading", { name: copy.title, exact: true }),
    })
    .first();
  await row.getByRole("button", { name: "更多歌曲操作", exact: true }).click();
  await page.getByRole("button", { name: "截取音频片段", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("开始（秒）", { exact: true }).fill("2");
  await editor.getByLabel("结束（秒）", { exact: true }).fill("6");
  await editor.getByLabel("淡入（秒）", { exact: true }).fill("0.3");
  await editor.getByLabel("淡出（秒）", { exact: true }).fill("0.8");
  await editor.getByLabel("片段标题", { exact: true }).fill("四秒配乐片段");
  await editor.getByLabel("导出格式", { exact: true }).selectOption("wav");
  await editor.locator(".wave-area img").evaluate((img) => img.decode());
  await editor
    .getByRole("button", { name: "试听所选片段", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("dialog audio")?.currentTime > 2.1,
  );
  await editor.getByRole("button", { name: "停止试听", exact: true }).click();
  await page.screenshot({
    path: path.join(artifacts, "clip-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(artifacts, "clip-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await editor.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await editor.getByLabel("结束（秒）", { exact: true }).fill("1");
  assert.equal(
    await editor
      .getByRole("button", { name: "导出新片段", exact: true })
      .isDisabled(),
    true,
  );
  await editor.getByLabel("结束（秒）", { exact: true }).fill("6");
  await editor.getByRole("button", { name: "导出新片段", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  const all = await api("/api/jobs");
  const clipJob = all.find((j) => j.title === "四秒配乐片段");
  const clip = await completed(clipJob.id);
  assert.ok(Math.abs(clip.duration - 4) < 0.005);
  assert.equal(clip.format, "wav");
  assert.deepEqual(readFileSync(original.filePath), sourceBytes);
  assert.equal(
    existsSync(copy.filePath),
    true,
    "clip must not remove its parent",
  );
  assert.equal(clip.kind, "clip");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await row.getByRole("button", { name: "更多歌曲操作", exact: true }).click();
  await page.getByRole("button", { name: "整理歌曲信息", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("歌曲标题", { exact: true })
    .fill("另存整理测试");
  await page.getByRole("button", { name: "另存整理版", exact: true }).click();
  const organized = (await api("/api/jobs")).find(
    (j) => j.title === "另存整理测试",
  );
  const organizedResult = await completed(organized.id);
  assert.ok(Math.abs(organizedResult.duration - 12) < 0.01);
  assert.equal(organizedResult.kind, "organized");
  assert.equal(existsSync(copy.filePath), true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS UI waveform, range preview, fades, exact WAV export, metadata-copy export, source preservation and 390px layout",
  );
} finally {
  await browser.close();
}

const bad = await fetch(base + `/api/jobs/${original.id}/clip`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    format: "wav",
    clip: { start: 0, end: 20, fadeIn: 0, fadeOut: 0 },
  }),
});
assert.equal(bad.status, 400);
renameSync(original.filePath, original.filePath + ".moved");
renameSync(copy.filePath, copy.filePath + ".moved");
try {
  const missingInput = await upload();
  const missingMatch = await api("/api/library/match", {
    token: missingInput.token,
    choice: "original",
    format: "original",
  });
  assert.equal(missingMatch.job, null);
  const response = await fetch(base + `/api/jobs/${original.id}/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "wav",
      clip: { start: 0, end: 2, fadeIn: 0, fadeOut: 0 },
    }),
  });
  assert.equal(response.status, 400);
} finally {
  renameSync(original.filePath + ".moved", original.filePath);
  renameSync(copy.filePath + ".moved", copy.filePath);
}
console.log(
  "PASS missing historical files do not suppress downloads; invalid clips cannot create jobs",
);
