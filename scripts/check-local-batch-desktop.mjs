// Packaged-app QA with a fresh profile, generated media and no personal accounts.
import { _electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
const executablePath = path.resolve(
  process.env.SHIYIN_TEST_EXECUTABLE ||
    "release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音",
);
const media = path.resolve(executablePath, "../../Resources/bin/ffmpeg");
const root = mkdtempSync(path.join(os.tmpdir(), "shiyin-batch-desktop-"));
const files = ["桌面批量一.wav", "桌面批量二.flac", "损坏音频.mp3"].map((n) =>
  path.join(root, n),
);
for (let i = 0; i < 2; i++)
  execFileSync(media, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${330 + i * 110}:duration=${4 + i}`,
    files[i],
  ]);
writeFileSync(files[2], "not audio");
const originals = files.slice(0, 2).map((f) => readFileSync(f));
const env = {
  ...process.env,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  SHIYIN_DESKTOP_DATA_DIR: path.join(root, "profile"),
  SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, "output"),
};
let app;
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = undefined;
}
try {
  app = await _electron.launch({
    executablePath,
    env,
    args: [],
    timeout: 45000,
  });
  let page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("main").waitFor();
  await page.getByRole("tab", { name: "本地文件", exact: true }).click();
  await page.locator(".upload-entry input[type=file]").setInputFiles(files);
  const panel = page.locator(".local-batch-panel");
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".local-batch-panel .primary")?.disabled,
  );
  await panel.getByLabel("输出格式", { exact: true }).selectOption("mp3");
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".local-batch-panel")
      ?.innerText.includes("本批已完成 2 个"),
  );
  const jobs = await page.evaluate(async () =>
    (await fetch("/api/jobs")).json(),
  );
  assert.equal(jobs.length, 2);
  assert.ok(
    jobs.every((j) => j.status === "completed" && j.filename.endsWith(".mp3")),
  );
  for (const job of jobs)
    execFileSync(media, ["-v", "error", "-i", job.filePath, "-f", "null", "-"]);
  assert.deepEqual(
    files.slice(0, 2).map((f) => readFileSync(f)),
    originals,
  );
  await page.getByRole("button", { name: "歌单", exact: true }).click();
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByLabel("来源平台", { exact: true }).selectOption("local");
  await page.getByLabel("文件格式", { exact: true }).selectOption("mp3");
  assert.equal(await page.locator(".job-row").count(), 2);
  await page.getByLabel("音频类型", { exact: true }).selectOption("clip");
  await page
    .getByRole("heading", { name: "没有匹配的结果", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "清空筛选与搜索", exact: true })
    .click();
  assert.equal(await page.locator(".job-row").count(), 2);
  assert.deepEqual(errors, []);
  console.log(
    "PASS packaged batch import: corrupt file isolated, two real MP3 outputs decoded with bundled tools, sources untouched and library filters usable",
  );
  await quit();
  app = await _electron.launch({
    executablePath,
    env,
    args: [],
    timeout: 45000,
  });
  page = await app.firstWindow();
  await page.locator("main").waitFor();
  const restored = await page.evaluate(async () =>
    (await fetch("/api/jobs")).json(),
  );
  assert.equal(restored.length, 2);
  assert.ok(restored.every((j) => j.status === "completed" && j.fileExists));
  console.log(
    "PASS packaged restart restores all batch outputs and original file locations",
  );
  await quit();
  console.log(JSON.stringify({ root }));
} finally {
  if (app) await quit().catch(() => app?.close());
}
