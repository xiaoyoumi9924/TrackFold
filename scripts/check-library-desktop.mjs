// Packaged-app verification, always using an isolated profile and generated audio.
import { _electron } from "playwright";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const executablePath = path.resolve(
  process.env.SHIYIN_TEST_EXECUTABLE ||
    "release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音",
);
const media = path.resolve(executablePath, "../../Resources/bin/ffmpeg");
const probe = path.resolve(executablePath, "../../Resources/bin/ffprobe");
const root = mkdtempSync(path.join(os.tmpdir(), "shiyin-library-desktop-"));
const source = path.join(root, "桌面功能测试.wav");
execFileSync(media, [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:duration=8",
  source,
]);
const env = {
  ...process.env,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  SHIYIN_DESKTOP_DATA_DIR: path.join(root, "profile"),
  SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, "output"),
};
let app, page;
async function launch() {
  app = await _electron.launch({
    executablePath,
    args: [],
    env,
    timeout: 45000,
  });
  page = await app.firstWindow();
  await page.locator("main").waitFor();
}
async function api(url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(
        url,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      return data;
    },
    { url, body },
  );
}
async function waitCompleted(id) {
  for (let i = 0; i < 100; i++) {
    const job = (await api("/api/jobs")).find((j) => j.id === id);
    if (job?.status === "completed") return job;
    if (job?.status === "failed") throw Error(job.message);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("desktop task timed out");
}
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = undefined;
}
try {
  await launch();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("tab", { name: "本地文件", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles(source);
  assert.equal(await page.getByRole("button", { name: "整理歌曲信息", exact: true }).getAttribute("aria-expanded"), "true");
  await page.getByLabel("歌曲标题", { exact: true }).fill("桌面整曲测试");
  await page.getByLabel("歌手", { exact: true }).fill("桌面测试歌手");
  await page.getByRole("combobox", { name: "保存格式", exact: true }).selectOption("m4a");
  await page.getByRole("button", { name: "提取并保存", exact: true }).click();
  let jobs = await api("/api/jobs");
  const original = await waitCompleted(jobs[0].id);
  assert.match(original.filename, /桌面测试歌手 - 桌面整曲测试\.m4a$/);
  const before = readFileSync(original.filePath);
  await page.locator("input[type=file]").setInputFiles(source);
  await page.getByRole("checkbox", { name: "另存副本并应用歌曲信息" }).waitFor();
  assert.equal(await page.getByText("这一音质与格式已保存", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "提取并保存", exact: true }).click();
  assert.equal((await api("/api/jobs")).length, 1);
  await page.getByRole("button", { name: "歌单", exact: true }).click();
  await page.getByRole("button", { name: "播放音频 桌面整曲测试", exact: true }).click();
  const player = page.locator(".bottom-player");
  const audio = player.locator("audio");
  await page.waitForFunction(() => document.querySelector(".bottom-player audio")?.currentTime > 0.2);
  const playbackMode = player.locator(".player-tools").getByRole("button", { name: /^播放模式：/ });
  await playbackMode.click();
  assert.equal(await playbackMode.getAttribute("title"), "列表循环");
  await playbackMode.click();
  assert.equal(await playbackMode.getAttribute("title"), "单曲循环");
  assert.equal(await audio.evaluate((audio) => audio.loop), true);
  await playbackMode.click();
  assert.equal(await playbackMode.getAttribute("title"), "顺序播放");
  assert.equal(await audio.evaluate((audio) => audio.loop), false);
  await player.getByRole("button", { name: "静音", exact: true }).click();
  assert.equal(await audio.evaluate((audio) => audio.muted), true);
  await player.getByRole("button", { name: "恢复声音", exact: true }).click();
  assert.equal(await audio.evaluate((audio) => audio.muted), false);
  await page.getByRole("button", { name: "更多歌曲操作", exact: true }).click();
  await page.getByRole("button", { name: "截取音频片段", exact: true }).click();
  const editor = page.getByRole("dialog");
  assert.equal(await audio.evaluate((audio) => audio.paused), true);
  assert.equal(await audio.getAttribute("src"), `/api/jobs/${original.id}/audio`);
  const pausedPosition = await audio.evaluate((audio) => audio.currentTime);
  assert.ok(pausedPosition > 0.2);
  await editor.getByLabel("开始（秒）", { exact: true }).fill("1.25");
  await editor.getByLabel("结束（秒）", { exact: true }).fill("3.75");
  await editor.getByLabel("导出格式", { exact: true }).selectOption("mp3");
  await editor.locator(".wave-area img").evaluate((img) => img.decode());
  await editor.getByRole("button", { name: "导出新片段", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await player.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction((position) => document.querySelector(".bottom-player audio")?.currentTime > position, pausedPosition);
  jobs = await api("/api/jobs");
  const clip = await waitCompleted(
    jobs.find((j) => j.parentJobId === original.id).id,
  );
  assert.ok(Math.abs(clip.duration - 2.5) < 0.15);
  assert.deepEqual(readFileSync(original.filePath), before);
  const metadata = JSON.parse(
    execFileSync(
      probe,
      ["-v", "error", "-show_format", "-of", "json", clip.filePath],
      { encoding: "utf8" },
    ),
  ).format.tags;
  assert.equal(metadata.artist, "桌面测试歌手");
  execFileSync(media, ["-v", "error", "-i", clip.filePath, "-f", "null", "-"]);
  assert.deepEqual(errors, []);
  console.log(
    "PASS packaged UI: import, history reuse, mute, playback position across editing, waveform and precise MP3 export",
  );
  await api("/api/library/settings", {
    naming: "title-artist",
    embedCover: false,
  });
  await quit();
  await launch();
  assert.equal((await api("/api/jobs")).length, 2);
  assert.deepEqual(await api("/api/library/settings"), {
    naming: "title-artist",
    embedCover: false,
  });
  assert.equal(existsSync(original.filePath), true);
  assert.equal(existsSync(clip.filePath), true);
  console.log(
    "PASS packaged restart preserves originals, clips, metadata and organization preferences",
  );
  await quit();
} finally {
  if (app) await quit().catch(() => app?.close());
}
