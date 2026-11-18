// Isolated packaged-app test using synthetic audio and the locally installed model.
import { _electron } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
const root = mkdtempSync(path.join(os.tmpdir(), "shiyin-separation-desktop-"));
const executablePath = path.resolve(
  process.env.SHIYIN_TEST_EXECUTABLE || "release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音",
);
const ffmpeg = path.resolve(executablePath, "../../Resources/bin/ffmpeg");
const source = path.join(root, "测试声音.wav");
execFileSync(ffmpeg, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=8",
  source,
]);
const before = readFileSync(source);
let app;
try {
  app = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      SHIYIN_DESKTOP_DATA_DIR: path.join(root, "profile"),
      SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, "output"),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    args: [],
    timeout: 45000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("main").waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole("button", { name: "人声分离", exact: true }).click();
  await page.getByText('人声分离组件已就绪，处理将在本机进行。').waitFor();
  await page.getByRole('button', { name: '音频提取', exact: true }).click();
  await page.getByRole("tab", { name: "本地文件", exact: true }).click();
  await page.locator(".upload-entry input[type=file]").setInputFiles(source);
  await page.getByRole("button", { name: "提取并保存", exact: true }).click();
  const jobs = () =>
    page.evaluate(async () => (await fetch("/api/jobs")).json());
  let parent;
  for (let i = 0; i < 100; i++) {
    parent = (await jobs())[0];
    if (parent?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(parent?.status, "completed");
  const original = readFileSync(parent.filePath);
  await page.getByRole("button", { name: "歌单", exact: true }).click();
  await page.getByRole("button", { name: "更多歌曲操作", exact: true }).click();
  await page
    .getByRole("button", { name: "分离人声和伴奏", exact: true })
    .first()
    .click();
  let stems = [];
  for (let i = 0; i < 360; i++) {
    stems = (await jobs()).filter(
      (j) =>
        j.parentJobId === parent.id &&
        ["vocals", "instrumental"].includes(j.kind),
    );
    if (
      stems.length === 2 &&
      stems.every((j) =>
        ["completed", "failed", "cancelled"].includes(j.status),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(stems.length, 2);
  assert.ok(
    stems.every((j) => j.status === "completed"),
    stems.map((j) => j.message).join("; "),
  );
  for (const job of stems) {
    assert.ok(Math.abs(job.duration - parent.duration) < 1);
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-i",
      job.filePath,
      "-f",
      "null",
      "-",
    ]);
  }
  assert.deepEqual(readFileSync(source), before);
  assert.deepEqual(readFileSync(parent.filePath), original);
  await page.screenshot({
    path: "/tmp/shiyin-separation-desktop-ui.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByLabel("音频类型", { exact: true }).selectOption("stem");
  await page.waitForFunction(
    () => document.querySelectorAll(".job-row").length === 2,
  );
  assert.equal(await page.locator(".job-row").count(), 2);
  const cancelled = await page.evaluate(async (id) => {
    const started = await fetch(`/api/jobs/${id}/separate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await started.json();
    if (!started.ok) throw Error(data.error);
    await fetch(`/api/jobs/${data.jobs[0].id}/cancel`, { method: "POST" });
    return data.jobs.map((j) => j.id);
  }, parent.id);
  let cancelledJobs;
  for (let i = 0; i < 100; i++) {
    const current = await jobs();
    cancelledJobs = current.filter((j) => cancelled.includes(j.id));
    if (
      cancelledJobs.length === 2 &&
      cancelledJobs.every((j) => j.status === "cancelled")
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(cancelledJobs.every((j) => j.status === "cancelled"));
  assert.deepEqual(readFileSync(parent.filePath), original);
  assert.deepEqual(errors, []);
  console.log(
    "PASS packaged app: two real separated stems, valid WAV audio, duration checks, intact sources, library filtering and cancellation",
  );
} finally {
  if (app) {
    const done = app.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit());
    await done;
  }
}
