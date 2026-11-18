// Requires an isolated local service. Uses generated media and never a real account.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
const base = process.env.SHIYIN_TEST_URL || "http://127.0.0.1:4188";
const root =
  process.env.SHIYIN_TEST_ARTIFACTS || "/tmp/shiyin-batch-library-qa";
mkdirSync(root, { recursive: true });
const files = ["第一段音乐.wav", "第二段音乐.flac", "损坏的录音.mp3"].map((n) =>
  path.join(root, n),
);
for (let i = 0; i < 2; i++)
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${330 + i * 110}:duration=${5 + i}`,
    "-metadata",
    `title=批量测试 ${i + 1}`,
    "-metadata",
    "artist=批量作者",
    "-metadata",
    `comment=${Date.now()}`,
    files[i],
  ]);
writeFileSync(files[2], "not an audio file");
const before = files.slice(0, 2).map((f) => readFileSync(f));
let chosen = path.join(root, `batch-output-${Date.now()}`);
mkdirSync(chosen);
chosen = realpathSync(chosen);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "本地文件", exact: true }).click();
  await page.locator(".upload-entry input[type=file]").setInputFiles(files);
  await page
    .getByRole("heading", { name: "本地批量处理", exact: true })
    .waitFor();
  const panel = page.locator(".local-batch-panel");
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".local-batch-panel .primary")?.disabled,
  );
  assert.equal(await panel.locator(".local-file-list > li").count(), 3);
  assert.match(await panel.innerText(), /00:05/);
  assert.match(await panel.innerText(), /00:06/);
  assert.match(await panel.innerText(), /未完成/);
  await panel.getByLabel("输出格式", { exact: true }).selectOption("wav");
  await panel
    .getByLabel("文件命名", { exact: true })
    .selectOption("title-artist");
  await panel.getByLabel("本批保存位置", { exact: true }).fill(chosen);
  await page.screenshot({
    path: path.join(root, "batch-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "歌单", exact: true }).click();
  await page.getByRole("button", { name: "音频提取", exact: true }).click();
  assert.equal(
    await page.locator(".local-batch-panel .local-file-list > li").count(),
    3,
    "selected files survive navigation",
  );
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".local-batch-panel")
      ?.innerText.includes("本批已完成 2 个"),
  );
  let jobs = await page.evaluate(async () => (await fetch("/api/jobs")).json());
  const outputs = jobs.filter((j) => j.outputDir === chosen);
  assert.equal(outputs.length, 2);
  assert.ok(
    outputs.every(
      (j) => j.status === "completed" && j.filename.endsWith(".wav"),
    ),
  );
  assert.ok(
    outputs.every((j) => /批量测试 \d - 批量作者\.wav$/.test(j.filename)),
  );
  for (const job of outputs)
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      job.filePath,
      "-f",
      "null",
      "-",
    ]);
  assert.deepEqual(
    files.slice(0, 2).map((f) => readFileSync(f)),
    before,
  );
  await panel
    .getByRole("button", { name: "重试未完成 1 个", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".local-batch-panel")
      ?.innerText.includes("1 条未加入"),
  );
  assert.equal(
    (await page.evaluate(async () => (await fetch("/api/jobs")).json())).filter(
      (j) => j.outputDir === chosen,
    ).length,
    2,
  );
  console.log(
    "PASS mixed multi-file import: durations, corrupt-file isolation, shared format/naming/destination, navigation preservation, real WAV decode and failure-only retry",
  );
  await panel.getByRole("button", { name: "清空清单", exact: true }).click();
  await panel
    .getByLabel("选择批量音视频文件", { exact: true })
    .setInputFiles(files.slice(0, 2));
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".local-batch-panel .primary")?.disabled,
  );
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".local-batch-panel")
      ?.innerText.includes("复用 2 个已有任务或文件"),
  );
  assert.equal(
    (await page.evaluate(async () => (await fetch("/api/jobs")).json())).filter(
      (j) => j.outputDir === chosen,
    ).length,
    2,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(root, "batch-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  console.log(
    "PASS repeat batches reuse completed files, keep originals and fit 390px",
  );
  await page.getByRole("button", { name: "歌单", exact: true }).click();
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByLabel("来源平台", { exact: true }).selectOption("local");
  await page.getByLabel("文件格式", { exact: true }).selectOption("wav");
  await page.getByLabel("搜索音频库", { exact: true }).fill("批量作者");
  assert.equal(
    await page.locator(".job-row").count(),
    jobs.filter(
      (j) =>
        j.status === "completed" &&
        j.platform === "local" &&
        j.filename.endsWith(".wav") &&
        j.artist === "批量作者",
    ).length,
  );
  await page.getByLabel("音频类型", { exact: true }).selectOption("clip");
  await page
    .getByRole("heading", { name: "没有匹配的结果", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "清空筛选与搜索", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("搜索音频库", { exact: true }).inputValue(),
    "",
  );
  await page.getByLabel("文件状态", { exact: true }).selectOption("missing");
  assert.equal(await page.locator(".job-row").count(), 0);
  await page
    .getByRole("button", { name: "清空筛选与搜索", exact: true })
    .click();
  await page.getByLabel("排序", { exact: true }).selectOption("title");
  await page.screenshot({
    path: path.join(root, "library-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: path.join(root, "library-desktop.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS library composed filters, query reset, empty/missing states, sort and desktop/mobile UI",
  );

  // A removed unsubmitted file is physically removed from the upload directory.
  await page.getByRole("button", { name: "音频提取", exact: true }).click();
  await panel.getByRole("button", { name: "清空清单", exact: true }).click();
  const requestCount = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/upload")) requestCount.push(response);
  });
  await panel
    .getByLabel("选择批量音视频文件", { exact: true })
    .setInputFiles(files[0]);
  await panel
    .getByRole("button", { name: "保存所选 1 个", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".local-batch-panel .primary")?.disabled,
  );
  const resource = await requestCount.at(-1).json();
  await panel
    .getByRole("button", {
      name: `移除清单文件 ${path.basename(files[0])}`,
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".local-batch-panel .local-file-list > li")
        .length === 0,
  );
  const match = await page.evaluate(
    async (token) =>
      (
        await fetch("/api/library/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, format: "wav", choice: "original" }),
        })
      ).json(),
    resource.token,
  );
  assert.equal(match.job, null);
  assert.ok(outputs.every((j) => existsSync(j.filePath)));
  console.log(
    "PASS clearing pending uploads drops their plans without deleting completed outputs",
  );
} finally {
  await browser.close();
}

// Stop/resume and failed-submission recovery run in a separate window.
const extraBrowser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await extraBrowser.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "本地文件", exact: true }).click();
  await page.getByRole("button", { name: "批量处理文件", exact: true }).click();
  const panel = page.locator(".local-batch-panel");
  await panel
    .getByLabel("选择批量音视频文件", { exact: true })
    .setInputFiles(
      Array.from({ length: 21 }, (_, i) => ({
        name: `${i}.wav`,
        mimeType: "audio/wav",
        buffer: Buffer.from("invalid"),
      })),
    );
  await panel.getByRole("alert").filter({ hasText: "最多 20" }).waitFor();
  assert.equal(await panel.locator(".local-file-list > li").count(), 0);
  let release, seen;
  const held = new Promise((r) => (release = r)),
    started = new Promise((r) => (seen = r));
  let uploads = 0;
  await page.route("**/api/upload", async (route) => {
    uploads++;
    if (uploads === 1) {
      seen();
      await held;
    }
    await route.continue();
  });
  await panel
    .getByLabel("选择批量音视频文件", { exact: true })
    .setInputFiles(files.slice(0, 2));
  await started;
  await panel
    .getByRole("button", { name: "停止后续操作", exact: true })
    .click();
  release();
  await panel.getByRole("button", { name: "继续读取", exact: true }).waitFor();
  assert.equal(uploads, 1);
  await panel.getByRole("button", { name: "继续读取", exact: true }).click();
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".local-batch-panel .primary")?.disabled,
  );
  assert.equal(uploads, 2);
  await page.unroute("**/api/upload");
  const first = panel.locator(".local-file-list > li").first();
  await first.locator("summary").click();
  await first
    .getByRole("textbox", {
      name: `标题 ${path.basename(files[0])}`,
      exact: true,
    })
    .fill("失败重试保留标题");
  await panel.getByLabel("输出格式", { exact: true }).selectOption("m4a");
  await panel
    .getByLabel("本批保存位置", { exact: true })
    .fill(path.join(root, `missing-${Date.now()}`));
  await panel
    .getByRole("button", { name: "保存所选 2 个", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".local-batch-panel")
      ?.innerText.includes("2 条未加入"),
  );
  await panel.getByLabel("本批保存位置", { exact: true }).fill(chosen);
  await panel
    .getByRole("button", { name: "重试未完成 2 个", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".local-batch-panel")
      ?.innerText.includes("本批已完成 2 个"),
  );
  const jobs = await page.evaluate(async () =>
    (await fetch("/api/jobs")).json(),
  );
  assert.ok(
    jobs.some(
      (j) =>
        j.title === "失败重试保留标题" &&
        j.status === "completed" &&
        j.filename.endsWith(".m4a"),
    ),
  );
  console.log(
    "PASS file-count guard, stopping after current file, resuming unread files and preserving edited metadata through failed submission/retry",
  );
} finally {
  await extraBrowser.close();
}

const duplicateBrowser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await duplicateBrowser.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const countBefore = await page.evaluate(
    async () => (await (await fetch("/api/jobs")).json()).length,
  );
  await page.getByRole("tab", { name: "本地文件", exact: true }).click();
  await page
    .locator(".upload-entry input[type=file]")
    .setInputFiles([files[0], files[0]]);
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
  const countAfter = await page.evaluate(
    async () => (await (await fetch("/api/jobs")).json()).length,
  );
  assert.equal(countAfter - countBefore, 1);
  console.log(
    "PASS identical files in one batch share a single active or completed task",
  );
} finally {
  await duplicateBrowser.close();
}
