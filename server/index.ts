import { associateBackupFiles, checkedMediaFile, readBackup, type RecordsBackup } from "./backup.ts";
import { actualExtension, originalAudioOutput, originalTranscodeNote, supportsAttachedCover, type ExportPreset } from "../shared/preferences.ts";
import express from "express";
import { isBilibiliLink, resolveBilibiliAudio, resolveVideo, saveVideo, videoErrorMessage, videoSourceUrl, type VideoPlan } from "./video.ts";
import { BilibiliLogin, inspectBilibili } from "./bilibili-login.ts";
import { VideoQueue, type VideoRecord } from "./video-queue.ts";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, existsSync, lstatSync, statSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { lstat, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AccountPlatform, Batch, Job, Resource, AudioQueueState, RecoveryItem, VideoMetadata, VideoTask } from "../shared/types.ts";
import { Batches } from "./batches.ts";
import { readPlaylist } from "./playlists.ts";
import { searchTracks, myPlaylists } from "./discovery.ts";
import { separate, checkSeparationRuntime, startSeparationInstallation, separationInstallationBusy, cancelSeparationInstallation } from "./separation.ts";
import { loudnessFilter } from "./loudness.ts";
import { exportLibrary } from "./library-export.ts";
import { groupKey, organizeLibrary, validGroupName } from "./library-organize.ts";
import { isNetworkFailure } from "../shared/retry-policy.ts";
import { retryFailures } from "./retry-bulk.ts";
import { CompletionTracker } from "./completion-notifications.ts";
import {
  OutputStorage,
  existingDirectory,
  jobFile,
  checksum,
  matchingFile,
  publishAudio,
  type PublishedCandidate,
} from "./storage.ts";
import { chooseNative, nativePicker } from "./native-picker.ts";
import { douyinBrowsers } from "./douyin-browser.ts";
import {
  resolveQishui,
  resolveQishuiTrack,
  resolveDouyin,
  extractLink,
  planNeedsRefresh,
  selectEquivalentChoice,
  type Plan,
} from "./providers.ts";
import {
  resolveInBrowser,
  resolveDouyinOriginalInBrowser,
  openLogin,
  closeBrowser,
  inspectDouyinLogin,
  forgetBrowser,
  loginWindowOpen,
} from "./browser.ts";
import { AccountStore, normalizeCookie } from "./accounts.ts";
import { QishuiLogin } from "./qishui-login.ts";
import { createVerificationServer } from "./verification-server.ts";
import { readLocalQishuiCookie } from "./local-account.ts";
import {
  libraryDefaults,
  librarySettings,
  metadataOf,
  outputTitle,
  findSaved,
  sameSource,
  clipRange,
} from "./library.ts";
import { probe, convert, download, run, prepareArtwork } from "./media.ts";
import { desktopOpenPath, parentPort, openVerificationWindow } from "./desktop-bridge.ts";
import { clearStaleMedia, removeTemporary, reportLocalFailure } from "./temporary-media.ts";

const root = process.env.SHIYIN_APP_ROOT || process.cwd(),
  local = process.env.SHIYIN_DATA_DIR || path.join(root, ".local"),
  tempRoot = path.join(local, "temp"),
  legacyOutput = process.env.SHIYIN_OUTPUT_DIR || path.join(root, "output");
for (const d of [local, tempRoot, legacyOutput])
  mkdirSync(d, { recursive: true, mode: 0o700 });
const temp = mkdtempSync(path.join(tempRoot, `run-${process.pid}-`));
const storage = new OutputStorage(local, legacyOutput);
let organization = { ...libraryDefaults };
try {
  organization = librarySettings(
    JSON.parse(readFileSync(path.join(local, "library.json"), "utf8")),
  );
} catch {}
const db = new DatabaseSync(path.join(local, "tasks.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS library_playlists (key TEXT PRIMARY KEY, name TEXT NOT NULL);",
);
db.exec(`CREATE TABLE IF NOT EXISTS video_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pending_outputs (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
db.exec("CREATE TABLE IF NOT EXISTS export_presets (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
function storedRecords<T>(table: "jobs" | "video_jobs" | "batches", valid: (value: any, id: unknown) => boolean): T[] {
  const records: T[] = [];
  for (const row of db.prepare(`SELECT id, value FROM ${table} ORDER BY rowid`).all()) {
    try {
      const record = JSON.parse(String(row.value));
      if (!valid(record, row.id)) throw new Error("Invalid record");
      records.push(record);
    } catch (error) {
      reportLocalFailure(`已跳过 ${table} 中的损坏记录，数据库原记录已保留`, error);
    }
  }
  return records;
}
function validRecordId(id: unknown) {
  return typeof id === "string" && /^[a-z0-9_-]{1,128}$/i.test(id);
}
function customPresets() {
  return db.prepare("SELECT value FROM export_presets ORDER BY rowid").all().map(row => JSON.parse(String(row.value)) as ExportPreset);
}
function savePreset(preset: ExportPreset) {
  db.prepare("INSERT INTO export_presets (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(preset.id, JSON.stringify(preset));
}
const writePendingOutput = db.prepare("INSERT OR REPLACE INTO pending_outputs (id, value) VALUES (?, ?)");
const readPendingOutput = db.prepare("SELECT value FROM pending_outputs WHERE id = ?");
const clearPendingOutput = db.prepare("DELETE FROM pending_outputs WHERE id = ?");
function prepareOutput(id: string, file: PublishedCandidate) {
  writePendingOutput.run(id, JSON.stringify(file));
}
async function recoverOutput(id: string): Promise<PublishedCandidate | undefined> {
  const row = readPendingOutput.get(id);
  if (!row) return;
  let file: PublishedCandidate;
  try {
    const saved = JSON.parse(String(row.value));
    if (typeof saved?.filePath !== "string" || typeof saved.filename !== "string" ||
        typeof saved.checksum !== "string" || !/^[a-f0-9]{64}$/.test(saved.checksum))
      throw new Error("Invalid pending output");
    const { filename, filePath, checksum, size, duration } = saved;
    file = { filename, filePath, checksum };
    if (Number.isFinite(size)) file.size = size;
    if (Number.isFinite(duration)) file.duration = duration;
  } catch (error) {
    reportLocalFailure("已跳过损坏的待恢复文件记录", error);
    return;
  }
  try {
    if ((await lstat(file.filePath)).isFile() && await checksum(file.filePath) === file.checksum) return file;
  } catch { /* The destination may be temporarily disconnected. */ }
}
function interruptedAudio(job: Job, message = "上次未完成，可在任务页继续。") {
  patch(job, { status: "failed", interrupted: true, failureKind: undefined, message, progress: 0 });
}
let closing = false;
async function restoreAudioOutput(job: Job) {
  const existing = await recoverOutput(job.id);
  if (!existing || closing || job.status === "cancelled") return false;
  patch(job, { ...existing, status: "completed", interrupted: undefined, needsReview: undefined,
    completedAt: new Date().toISOString(), progress: 100, message: "已找回上次保存的音频。" });
  return true;
}
const jobs = new Map<string, Job>();
let completionTracker: CompletionTracker | undefined;
const notificationFile = path.join(local, "notifications.json");
let notificationsEnabled = false;
try {
  const stored = JSON.parse(readFileSync(notificationFile, "utf8"));
  notificationsEnabled = stored.enabled === true || stored.mode === "batch" || stored.mode === "failures";
} catch {}
const audioRecords = storedRecords<Job>("jobs", (job, id) => validRecordId(id) && job?.id === id &&
  typeof job.title === "string" && typeof job.artist === "string" &&
  ["queued", "downloading", "processing", "checking", "completed", "failed", "cancelled"].includes(job.status) &&
  [job.filePath, job.outputDir, job.filename].every(value => value == null || typeof value === "string"));
for (const job of audioRecords) {
  try {
    // Old records always belong to their original output folder, never the new preference.
    job.outputDir ||= legacyOutput;
    if (job.status === "completed") job.filePath ||= jobFile(job, legacyOutput);
    if (job.message === "应用已退出，可重新解析后再试。" || job.message === "上次任务被中断，请重新解析后再试。")
      interruptedAudio(job);
    if (!["completed", "failed", "cancelled"].includes(job.status) || job.interrupted) {
      if (await restoreAudioOutput(job)) continue;
      if (!job.interrupted) interruptedAudio(job);
    }
    jobs.set(job.id, job);
    if (
      job.status === "completed" &&
      job.filePath &&
      !job.checksum &&
      existsSync(job.filePath)
    ) {
      try {
        job.checksum = await checksum(job.filePath);
      } catch {}
    }
    save(job);
  } catch (error) {
    jobs.set(job.id, job);
    reportLocalFailure("无法更新已读取的音频任务", error);
  }
}
function save(job: Job, changes?: Partial<Job>) {
  db.prepare("INSERT OR REPLACE INTO jobs(id,value) VALUES (?,?)").run(
    job.id,
    JSON.stringify(changes ? { ...job, ...changes } : job),
  );
  if (changes) Object.assign(job, changes);
  jobs.set(job.id, job);
  if (job.status === "completed" || job.status === "cancelled") clearPendingOutput.run(job.id);
  completionTracker?.observe(job);
}
const plans = new Map<string, Plan>();
const claimedUploads = new Map<string, Plan>();
const controllers = new Map<string, AbortController>();
const queue: { job: Job; plan: Plan; choice: string }[] = [];
const audioQueueLimit = 10;
let active = 0;
let queuePaused = false;
const running = new Set<Promise<void>>();
const videoPreviews = new Map<string, { plan: VideoPlan; input: string; expires: number }>();
const resolvingVideo = new Map<string, Promise<VideoPlan>>();
function readVideoPlan(input: string, expected?: VideoMetadata) {
  const cookie = accounts.cookie("douyin");
  return resolveVideo(videoSourceUrl(expected?.platform, expected?.sourceId) || input, cookie, id => resolveInBrowser(profile, id, cookie), expected, accounts.cookie("bilibili"));
}
async function restoreVideoOutput(task: VideoTask) {
  const existing = await recoverOutput(task.id);
  if (!existing || closing || task.status === "cancelled") return false;
  Object.assign(task, { filePath: existing.filePath, checksum: existing.checksum, status: "completed", interrupted: undefined,
    needsReview: undefined, message: "已找回上次保存的视频。", progress: undefined });
  return true;
}
const videoRecords = storedRecords<VideoRecord>("video_jobs", (record, id) => validRecordId(id) &&
  record?.task?.id === id && ["queued", "working", "completed", "failed", "cancelled"].includes(record.task.status) &&
  typeof record.input === "string" && typeof record.outputDir === "string" &&
  (record.task.filePath == null || typeof record.task.filePath === "string"));
for (const { task } of videoRecords) {
  if (task.interrupted || task.status === "queued" || task.status === "working") await restoreVideoOutput(task);
}
const videoUpsert = db.prepare("INSERT INTO video_jobs(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value");
function saveVideoRecord(record: VideoRecord) {
  videoUpsert.run(record.task.id, JSON.stringify(record));
  if (["completed", "cancelled"].includes(record.task.status)) clearPendingOutput.run(record.task.id);
}
for (const record of videoRecords) if (record.task.status === "completed") {
  try { saveVideoRecord(record); } catch (error) { reportLocalFailure("无法更新已读取的视频任务", error); }
}
const videoQueue = new VideoQueue((task, input, outputDir, plan, signal) =>
  saveVideo(() => plan ? Promise.resolve(plan) : readVideoPlan(input, task), outputDir, temp, task, signal,
    () => videoQueue.save(task), file => prepareOutput(task.id, file)), 2, videoRecords, saveVideoRecord);
const playlistRequests = new Set<AbortController>();
const profile = path.join(local, "douyin-browser");
const accounts = new AccountStore(
  local,
  existsSync(path.join(profile, "Default", "Cookies")) ||
    existsSync(path.join(profile, "Default", "Network", "Cookies")),
);
async function checkAccount(platform: AccountPlatform) {
  return accounts.check(platform, (cookie) =>
    platform === "bilibili" ? inspectBilibili(cookie) : inspectDouyinLogin(profile, cookie),
  );
}
const bilibiliLogin = new BilibiliLogin(async (cookie, account) => {
  accounts.update({ bilibili: cookie }, "qr");
  await accounts.check("bilibili", async () => account);
});
const qishuiLogin = new QishuiLogin(
  async (cookie) => {
    accounts.update({ qishui: cookie }, "qr");
    await checkAccount("qishui");
  },
  undefined,
  local,
);
if (await qishuiLogin.restore()) {
  accounts.qishuiQrOpened();
  const restored = qishuiLogin.current()!;
  accounts.qishuiQrProgress(restored.phase, restored.message);
}
// Keep a phone confirmation alive even when the page reloads or is backgrounded.
const qrTimer = setInterval(async () => {
  const current = qishuiLogin.current();
  if (!current || ["confirmed", "expired"].includes(current.phase)) return;
  try {
    const qr = await qishuiLogin.poll(current.id);
    accounts.qishuiQrProgress(qr.phase, qr.message);
    if (qr.phase === "expired")
      accounts.qishuiQrEnded("二维码已过期，请刷新后重新扫码。");
  } catch {
    // A cancelled or replaced QR has no further work to do.
  }
}, 2000);
qrTimer.unref();
let browserCheckRunning = false;
const browserLoginTimer = setInterval(async () => {
  if (
    closing ||
    browserCheckRunning ||
    !loginWindowOpen() ||
    accounts.state("douyin").status === "connected"
  )
    return;
  browserCheckRunning = true;
  try {
    await checkAccount("douyin");
  } catch {
  } finally {
    browserCheckRunning = false;
  }
}, 4000);
browserLoginTimer.unref();
function accountSettings() {
  const states = accounts.all();
  states.douyin.loginWindowOpen = loginWindowOpen();
  return {
    accounts: states,
    qishuiConnected: states.qishui.status === "connected",
    douyinConnected: states.douyin.status === "connected",
    outputDir: storage.outputDir,
  };
}
function publicJob(job: Job) {
  const { checksum: _checksum, ...visible } = job;
  const file = jobFile(job, legacyOutput);
  return {
    ...visible,
    fileExists: !!file && existsSync(file),
  };
}
async function discardPlan(plan: Plan) {
  const token = plan.resource.token;
  if (plans.get(token) !== plan) return;
  plans.delete(token);
  if (plan.inputFile) await removeTemporary(plan.inputFile);
}
function register(plan: Plan) {
  if (plans.size >= 100) {
    const oldest = plans.values().next().value;
    if (oldest) void discardPlan(oldest);
  }
  plans.set(plan.resource.token, plan);
  return plan.resource;
}
function claimUpload(plan: Plan) {
  const token = plan.resource.token;
  if (plans.get(token) !== plan)
    throw Object.assign(new Error("该文件已加入任务或正在恢复，请稍候。"), { status: 409 });
  plans.delete(token);
  claimedUploads.set(token, plan);
}
async function releaseUpload(plan: Plan, keepAvailable = false) {
  const token = plan.resource.token;
  if (claimedUploads.get(token) !== plan) return;
  claimedUploads.delete(token);
  if (keepAvailable && !closing) register(plan);
  else if (plan.inputFile) await removeTemporary(plan.inputFile);
}
const douyinOriginal = (id: string, signal?: AbortSignal) =>
  resolveDouyinOriginalInBrowser(profile, id, accounts.cookie("douyin"), signal);
function readQishuiTrack(id: string, options: { signal?: AbortSignal; preview?: boolean } = {}) {
  return resolveQishuiTrack(id, accounts.cookie("qishui"), { ...options, douyinOriginal });
}
async function resolveInput(input: string) {
  const url = new URL(extractLink(input));
  if (isBilibiliLink(url)) return register(await resolveBilibiliAudio(url, undefined, accounts.cookie("bilibili")));
  const qishui = /qishui|music\.douyin\.com|beta-luna/.test(input);
  return register(qishui
    ? await resolveQishui(input, accounts.cookie("qishui"), { douyinOriginal })
    : await resolveDouyin(input, accounts.cookie("douyin") || "", id => resolveInBrowser(profile, id, accounts.cookie("douyin"))));
}
db.exec(
  "CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
);
const batches = new Batches(
  storedRecords<Batch>("batches", (batch, id) => validRecordId(id) && batch?.id === id &&
    ["resolving", "ready", "cancelled", "interrupted"].includes(batch.status) &&
    Array.isArray(batch.items) && batch.items.every((item: Batch["items"][number]) =>
      !!item && validRecordId(item.id) && typeof item.input === "string" &&
      ["listed", "waiting", "resolving", "ready", "failed", "cancelled", "stale", "duplicate", "submitted"].includes(item.status))),
  (batch) =>
    db
      .prepare(
        "INSERT INTO batches(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(batch.id, JSON.stringify(batch)),
  async (input, trackId) => trackId
    ? register(await readQishuiTrack(trackId))
    : resolveInput(input),
  (resource, options, batchId, itemId) => {
    const plan = plans.get(resource.token);
    if (!plan) throw new Error("解析结果已过期，请重新解析。");
    const choice = selectEquivalentChoice(plan);
    return createJob({
      token: resource.token, choice, format: options.format, outputDir: options.outputDir,
      allowPreview: options.allowPreview,
      organization: { naming: options.naming, embedCover: options.embedCover }, reuseActive: true,
    }, batchId, itemId);
  },
);
completionTracker = new CompletionTracker(
  () => closing || bulkRetryRunning || batches.pending || [...jobs.values()].some(job => !["completed", "failed", "cancelled"].includes(job.status)),
  summary => {
    if (notificationsEnabled && parentPort && !closing) parentPort.postMessage({ type: "task-summary", ...summary });
  },
);
function patch(job: Job, data: Partial<Job>) {
  save(job, data);
}
function failBackgroundAudio(job: Job, error: unknown) {
  reportLocalFailure("音频任务状态未能保存", error);
  if (["completed", "failed", "cancelled"].includes(job.status)) return;
  Object.assign(job, {
    status: "failed", message: readableError(error),
    interrupted: closing || job.interrupted, failureKind: undefined,
  });
}
function sourceReview(message: string) {
  return Object.assign(new Error(message), { needsReview: true });
}
async function readAudioSource(job: Job) {
  if (job.platform === "qishui" && job.sourceId) {
    if (job.audioSource === "douyin") return readQishuiTrack(job.sourceId);
    return resolveQishui(
      `https://music.douyin.com/qishui/share/track?track_id=${job.sourceId}`, accounts.cookie("qishui"), { douyinOriginal });
  }
  const url = job.platform === "bilibili" || job.platform === "douyin" ? videoSourceUrl(job.platform, job.sourceId) : undefined;
  if (!url) throw sourceReview("请重新解析链接或重新选择本地文件。");
  if (job.platform === "bilibili") return resolveBilibiliAudio(new URL(url), job.sourceId, accounts.cookie("bilibili"));
  const cookie = accounts.cookie("douyin");
  return resolveDouyin(url, cookie, id => resolveInBrowser(profile, id, cookie));
}
async function refreshForJob(job: Job, signal?: AbortSignal) {
  const plan = await readAudioSource(job);
  signal?.throwIfAborted();
  if (plan.resource.sourceId !== job.sourceId)
    throw sourceReview("刷新后的资源编号不一致，请重新解析。");
  if (job.requiresFullAudio && plan.resource.completeness !== "full")
    throw sourceReview("平台暂未返回完整音频，请重新解析后确认保存。");
  if (
    plan.resource.completeness === "preview" &&
    job.completeness !== "preview"
  )
    throw sourceReview("资源现在只提供试听，请重新解析并确认是否保存试听。");
  let choice: string | undefined;
  try { choice = selectEquivalentChoice(plan, job.selection); }
  catch (error) { throw sourceReview(readableError(error)); }
  if (!choice) throw sourceReview("平台未返回原音质，请重新选择资源。");
  register(plan);
  patch(job, {
    resourceToken: plan.resource.token,
    completeness: plan.resource.completeness,
    audioSource: plan.resource.audioSource,
  });
  return { plan, choice };
}
async function downloadAudioStream(stream: Plan["streams"][number], destination: string, signal: AbortSignal, progress: (n: number) => void, maxBytes?: number) {
  let lastError: unknown;
  for (const url of [stream.url, ...(stream.backupUrls || [])]) {
    try { await download(url, destination, signal, progress, stream.headers, maxBytes); return; }
    catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") throw error;
      if ([403, 410].includes((error as { status?: number })?.status || 0) || !lastError) lastError = error;
    }
  }
  throw lastError;
}
async function prepareStreamFile(stream: Plan["streams"][number], input: string, scratch: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!stream.auth) return input;
  const mod = await import("soda-decrypt");
  const decrypted = path.join(scratch, "decrypted.m4a");
  await (mod as any).decryptSodaAudio({
    playAuth: stream.auth, playauth: stream.auth, file: input, out: decrypted,
  });
  signal.throwIfAborted();
  return decrypted;
}

async function execute(job: Job, plan: Plan, choice: string) {
  const c = new AbortController();
  controllers.set(job.id, c);
  const signal = c.signal;
  const scratch = path.join(temp, job.id);
  const originalPlan = plan;
  try {
    mkdirSync(scratch, { recursive: true });
    existingDirectory(job.outputDir || legacyOutput);
    patch(job, {
      status: "downloading",
      progress: 1,
      message: plan.inputFile ? "读取本地文件" : "正在获取资源",
    });
    if (planNeedsRefresh(plan)) {
      patch(job, { message: "资源地址已过期，正在重新获取" });
      ({ plan, choice } = await refreshForJob(job, signal));
    }
    let input = plan.inputFile;
    if (!input) {
      let stream = plan.streams.find((x) => x.id === choice);
      if (!stream) throw new Error("音质选项已失效，请重新解析。");
      input = path.join(scratch, "source.bin");
      try {
        await downloadAudioStream(
          stream,
          input,
          signal,
          (n) => patch(job, { progress: Math.round(n) }),
        );
      } catch (error) {
        if (signal.aborted || ![403, 410].includes((error as any)?.status))
          throw error;
        patch(job, { message: "资源链接失效，正在重新获取", progress: 1 });
        ({ plan, choice } = await refreshForJob(job, signal));
        if (signal.aborted) throw new Error("任务已取消");
        stream = plan.streams.find((x) => x.id === choice)!;
        await downloadAudioStream(
          stream,
          input,
          signal,
          (n) => patch(job, { progress: Math.round(n) }),
        );
      }
      if (stream.auth) patch(job, { status: "processing", message: "正在处理平台音频", progress: 72 });
      input = await prepareStreamFile(stream, input, scratch, signal);
    }
    if (signal.aborted) throw new Error("任务已取消");
    if (job.parentJobId) {
      const parent = jobs.get(job.parentJobId);
      if (!parent?.checksum || (await checksum(input)) !== parent.checksum)
        throw new Error("原文件内容已改变，请重新导入后截取。");
    }
    const info = await probe(input, signal);
    if (job.clip) clipRange(job.clip, info.duration);
    const ext = actualExtension(job.format, info.codec);
    const transcodeWarning = job.format === "original" && !originalAudioOutput(info.codec).copy
      ? originalTranscodeNote : undefined;
    const staged = path.join(scratch, `output.${ext}`);
    patch(job, {
      status: "processing",
      message: "正在提取音频与写入文件",
      progress: 75,
      warning: transcodeWarning,
    });
    let artwork: string | undefined;
    if (job.embedCover && supportsAttachedCover(ext)) {
      try {
        artwork = await prepareArtwork(job.cover, input, scratch, signal);
      } catch {
        if (signal.aborted) throw new Error("任务已取消");
        patch(job, { warning: [transcodeWarning, "封面未能写入，音频与歌曲信息仍已保留。"].filter(Boolean).join(" ") });
      }
    }
    if (job.kind === "normalized") patch(job, {message:"正在统一音量并导出副本"});
    const result = await convert(
      input,
      staged,
      ext,
      job.title,
      info.duration,
      signal,
      (n) => patch(job, { progress: Math.round(n) }),
      job.format === "original",
      { metadata: job.metadata, artwork, clip: job.clip, loudnessFilter: job.loudness ? loudnessFilter(job.loudness) : undefined },
    );
    patch(job, {
      status: "checking",
      message: "正在核对音轨与时长",
      progress: 97,
    });
    if (!result.duration || result.size < 100)
      throw new Error("输出文件未通过音轨检查。");
    if (
      job.clip
        ? Math.abs(result.duration - (job.clip.end - job.clip.start)) > 0.15
        : plan.resource.duration > 0 &&
          result.duration < plan.resource.duration - 2
    )
      throw new Error(
        job.clip
          ? "导出时长与所选片段不一致，已停止保存，请重试。"
          : "输出时长明显短于资源，已停止保存，请重试。",
      );
    if (signal.aborted) throw new Error("任务已取消");
    const fingerprint = await checksum(staged);
    const saved = await publishAudio(
      staged,
      job.outputDir || legacyOutput,
      job.metadata
        ? outputTitle(job.metadata, job.naming || "artist-title")
        : job.title,
      job.id,
      ext,
      signal,
      undefined,
      !!job.metadata,
      file => prepareOutput(job.id, { ...file, checksum: fingerprint, size: result.size, duration: result.duration }),
    );
    patch(job, {
      status: "completed",
      message: job.kind === "normalized" ? "音量统一副本已保存" : job.clip
        ? "截取片段已保存"
        : job.completeness === "preview"
          ? "试听片段已保存"
          : "音频已保存",
      progress: 100,
      interrupted: undefined,
      needsReview: undefined,
      ...saved,
      checksum: fingerprint,
      size: result.size,
      duration: result.duration,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (closing && signal.aborted && job.status !== "cancelled") interruptedAudio(job);
    else patch(job, {
      status: signal.aborted ? "cancelled" : "failed",
      interrupted: signal.aborted ? undefined : job.interrupted,
      needsReview: signal.aborted ? undefined : (error as { needsReview?: boolean })?.needsReview,
      failureKind: !signal.aborted && isNetworkFailure(error) ? "network" : undefined,
      message: signal.aborted ? "任务已取消" : readableError(error),
    });
  } finally {
    await removeTemporary(scratch, true);
    await releaseUpload(originalPlan);
    controllers.delete(job.id);
  }
}
function drain() {
  while (!closing && !queuePaused && deletingJobs.size === 0 && active < audioQueueLimit && queue.length) {
    const item = queue.shift()!;
    if (item.job.status === "cancelled") {
      void releaseUpload(item.plan);
      continue;
    }
    active++;
    const task = execute(item.job, item.plan, item.choice).catch(error => {
      failBackgroundAudio(item.job, error);
    }).finally(() => {
      active--;
      running.delete(task);
      drain();
    });
    running.add(task);
  }
}
function readableError(error: unknown) {
  if ((error as any)?.code === "ENOSPC")
    return "保存磁盘空间不足，请清理空间或更换保存位置。";
  if (["EACCES", "EPERM", "EROFS"].includes((error as any)?.code))
    return "文件或保存位置不可读写，请检查权限或更换位置。";
  const s = error instanceof Error ? error.message : "处理失败，请重试。";
  if (/abort|timeout/i.test(s)) return "请求超时，请检查网络后重试。";
  if (isNetworkFailure(error)) return "网络连接暂时失败，请检查网络后重试。";
  if (/Invalid data found|moov atom not found|Error opening input|could not find codec|EBML header parsing failed/i.test(s))
    return "无法识别这个音视频文件，文件可能损坏或格式暂不支持。请换一个文件重试。";
  if (/ENOENT/.test(s))
    return "缺少媒体处理工具，请确认 FFmpeg 和 FFprobe 已安装。";
  return s.replace(/https?:\/\/[^\s]+/g, "[资源地址]").slice(0, 800);
}
const production = process.argv.includes("--production");
const verification = createVerificationServer(qishuiLogin, path.join(root, "dist/verification.js"), readableError);
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (
    process.env.SHIYIN_ACCESS_TOKEN &&
    req.headers["x-shiyin-token"] !== process.env.SHIYIN_ACCESS_TOKEN
  )
    return res.status(403).json({ error: "请从拾音桌面窗口访问。" });
  if (closing)
    return res.status(503).json({ error: "拾音正在退出，请稍后重试。" });
  const host = req.get("Host");
  if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
    return res.status(403).json({ error: "仅支持本机访问。" });
  const origin = req.get("Origin");
  if (origin && (origin !== `http://${host}` || Number(host?.split(":")[1] ?? 80) !== req.socket.localPort))
    return res.status(403).json({ error: "请求来源不受支持。" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (production)
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  next();
});
app.use("/api", (req, res, next) => {
  const site = req.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none")
    return res.status(403).json({ error: "请求来源不受支持。" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/backup/preview", express.json({ limit: "12mb" }));
app.use(["/api/library/organize", "/api/library/export", "/api/discovery/batches"], express.json({ limit: "1mb" }));
app.use(express.json({ limit: "64kb" }));
app.get("/api/health", async (_, res) => {
  const tools = await Promise.all(
    ["ffmpeg", "ffprobe"].map(async (cmd) => {
      try {
        await run(cmd, ["-version"]);
        return true;
      } catch {
        return false;
      }
    }),
  );
  res.json({
    ok: true,
    ffmpeg: tools[0] && tools[1],
    outputDir: storage.outputDir,
    version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
    desktop: !!parentPort,
    browserReady: douyinBrowsers().length > 0,
    nativePicker,
  });
});
app.get("/api/settings", (_, res) => res.json(accountSettings()));
function notificationSettings() {
  return { enabled: notificationsEnabled, supported: !!parentPort, last: completionTracker?.last || null };
}
app.get("/api/notifications", (_, res) => res.json(notificationSettings()));
app.post("/api/notifications", (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") throw new Error("通知设置无效。");
    if (enabled && !parentPort) throw new Error("系统通知需要使用拾音桌面版。");
    const temporary = notificationFile + ".pending";
    writeFileSync(temporary, JSON.stringify({enabled}), {mode:0o600});
    renameSync(temporary, notificationFile);
    notificationsEnabled = enabled;
    res.json(notificationSettings());
  } catch (error) { next(error); }
});
function storageKind(value: unknown) {
  if (value === undefined || value === "audio") return "audio";
  if (value === "video") return "video";
  throw new Error("请选择音频或视频保存位置。");
}
app.get("/api/storage", (req, res) => res.json(storage.describe(storageKind(req.query.kind))));
app.post("/api/storage", async (req, res, next) => {
  try {
    res.json(await storage.update(req.body?.outputDir, storageKind(req.body?.kind)));
  } catch (e) {
    next(e);
  }
});
app.post("/api/storage/check-folder", (req, res, next) => {
  try { res.json({ path: existingDirectory(req.body?.path) }); }
  catch (error) { next(error); }
});
app.post("/api/storage/choose-folder", async (req, res, next) => {
  try {
    res.json({ path: await chooseNative("folder", storage.describe(storageKind(req.body?.kind)).outputDir) });
  } catch (e) {
    next(e);
  }
});
app.post("/api/jobs/:id/choose-file", async (req, res, next) => {
  const job = jobs.get(String(req.params.id));
  if (job?.status !== "completed")
    return res.status(404).json({ error: "已完成的任务不存在。" });
  try {
    res.json({
      path: await chooseNative(
        "file",
        path.dirname(jobFile(job, legacyOutput) || legacyOutput),
      ),
    });
  } catch (e) {
    next(e);
  }
});
app.post("/api/jobs/:id/relocate", async (req, res, next) => {
  const job = jobs.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: "任务不存在。" });
  if (deletingJobs.has(job.id) || relocatingJobs.has(job.id))
    return res.status(409).json({ error: "音频记录正在更新，请稍后重试。" });
  relocatingJobs.add(job.id);
  try {
    const filePath = await matchingFile(job, req.body.filePath);
    if (jobs.get(job.id) !== job || deletingJobs.has(job.id)) throw new Error("音频记录已变化，请刷新后重试。");
    patch(job, {
      filePath,
      detached: undefined,
      filename: path.basename(filePath),
      outputDir: path.dirname(filePath),
    });
    res.json(publicJob(job));
  } catch (e) {
    next(e);
  } finally { relocatingJobs.delete(job.id); }
});
app.post("/api/settings", async (req, res, next) => {
  try {
    const updates: Partial<Record<AccountPlatform, string>> = {};
    for (const p of ["qishui", "douyin"] as const)
      if (typeof req.body?.[p] === "string")
        updates[p] = normalizeCookie(p, req.body[p]);
    if (updates.qishui !== undefined) await qishuiLogin.cancel();
    if (updates.douyin === "") await forgetBrowser(profile);
    accounts.update(updates);
    for (const p of ["qishui", "douyin"] as const)
      if (updates[p]) await checkAccount(p);
    res.json({ ...accountSettings(), ok: true });
  } catch (e) {
    next(e);
  }
});
app.post("/api/accounts/:platform/check", async (req, res, next) => {
  try {
    const p = String(req.params.platform);
    if (p !== "qishui" && p !== "douyin" && p !== "bilibili") throw new Error("请选择支持的平台。");
    const account = await checkAccount(p);
    res.json({ account, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
app.delete("/api/accounts/:platform", async (req, res, next) => {
  try {
    const p = String(req.params.platform);
    if (p !== "qishui" && p !== "douyin" && p !== "bilibili") throw new Error("请选择支持的平台。");
    if (p === "qishui") await qishuiLogin.cancel();
    if (p === "douyin") await forgetBrowser(profile);
    if (p === "bilibili") bilibiliLogin.cancel();
    accounts.update({ [p]: "" });
    res.json({ ok: true, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
app.get("/api/login/bilibili/qr", (_, res) => res.json({ qr: bilibiliLogin.current() }));
app.post("/api/login/bilibili/qr", async (_, res, next) => {
  try { res.json({ qr: await bilibiliLogin.create() }); }
  catch (error) { next(error); }
});
app.get("/api/login/bilibili/qr/:id", async (req, res, next) => {
  try { res.json({ qr: await bilibiliLogin.poll(req.params.id) }); }
  catch (error) { next(error); }
});
app.delete("/api/login/bilibili/qr/:id", (req, res) => {
  bilibiliLogin.cancel(req.params.id);
  res.json({ ok: true });
});
app.post("/api/login/douyin", async (_, res, next) => {
  try {
    await openLogin(
      profile,
      () => {
        accounts.browserLoginClosed();
        void checkAccount("douyin").catch(() => {});
      },
      () => accounts.browserLoginOpened(),
    );
    res.json({ ok: true, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
app.post("/api/login/qishui-local", async (_, res, next) => {
  try {
    const cookie = readLocalQishuiCookie();
    await qishuiLogin.cancel();
    accounts.update({ qishui: cookie }, "local");
    await checkAccount("qishui");
    res.json({ ok: true, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/login/qishui/qr/:id/verification/open",
  async (req, res, next) => {
    try {
      const url = await verification.open(String(req.params.id));
      if (parentPort) openVerificationWindow(url);
      else await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.post("/api/login/qishui/qr", async (_, res, next) => {
  try {
    const qr = await qishuiLogin.create();
    accounts.qishuiQrOpened();
    res.json({ qr, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
app.get("/api/login/qishui/qr", (_, res) => {
  res.json({ qr: qishuiLogin.current(), ...accountSettings() });
});
app.get("/api/login/qishui/qr/:id", async (req, res, next) => {
  try {
    const qr = await qishuiLogin.poll(String(req.params.id));
    accounts.qishuiQrProgress(qr.phase, qr.message);
    if (qr.phase === "expired")
      accounts.qishuiQrEnded("二维码已过期，请刷新后重新扫码。");
    res.json({ qr, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
app.delete("/api/login/qishui/qr/:id", async (_, res, next) => {
  try {
    await qishuiLogin.cancel(String(_.params.id));
    accounts.qishuiQrEnded("扫码已取消，账号状态可重新检查。");
    res.json({ ok: true, ...accountSettings() });
  } catch (e) {
    next(e);
  }
});
function videoInput(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 10000)
    throw new Error("请粘贴一条视频分享链接。");
  return value.trim();
}

app.post("/api/video/resolve", async (req, res, next) => {
  try {
    const input = videoInput(req.body?.input);
    let pending = resolvingVideo.get(input);
    if (!pending) {
      if (resolvingVideo.size >= 2) throw new Error("有视频正在解析，请稍后再试。");
      pending = readVideoPlan(input).finally(() => resolvingVideo.delete(input));
      resolvingVideo.set(input, pending);
    }
    const plan = await pending;
    const now = Date.now();
    for (const [id, preview] of videoPreviews) if (preview.expires <= now) videoPreviews.delete(id);
    if (videoPreviews.size >= 100) videoPreviews.delete(videoPreviews.keys().next().value!);
    const id = randomUUID();
    videoPreviews.set(id, { plan, input, expires: now + 5 * 60_000 });
    res.json({ id, ...plan.metadata });
  } catch (error) { next(new Error(videoErrorMessage(error))); }
});
app.post("/api/video", (req, res, next) => {
  try {
    if (closing) throw new Error("拾音正在退出。");
    const previewId = req.body?.previewId;
    const destination = () => req.body?.outputDir === undefined
      ? storage.directory("video") : existingDirectory(req.body.outputDir);
    if (previewId !== undefined) {
      const preview = typeof previewId === "string" ? videoPreviews.get(previewId) : undefined;
      if (!preview || preview.expires <= Date.now()) return res.status(410).json({ error: "解析结果已过期，请重新解析链接。" });
      return res.json(publicVideo(videoQueue.add(storableVideoLink(preview.input), destination(), preview.plan)));
    }
    const input = videoInput(req.body?.input);
    res.json(publicVideo(videoQueue.add(storableVideoLink(input), destination())));
  } catch (error) { next(error); }
});
function storableVideoLink(input: string) {
  try {
    const url = new URL(extractLink(input));
    const pageKey = isBilibiliLink(url) ? "p" : "modal_id";
    const page = url.searchParams.get(pageKey);
    url.search = "";
    url.hash = "";
    if (page && /^\d+$/.test(page)) url.searchParams.set(pageKey, page);
    return url.href;
  } catch { return `无效链接 ${createHash("sha256").update(input).digest("hex")}`; }
}
app.post("/api/video/resolve-audio", (req, res, next) => {
  try {
    const preview = typeof req.body?.previewId === "string" && videoPreviews.get(req.body.previewId);
    if (!preview || preview.expires <= Date.now()) throw new Error("解析结果已过期，请重新解析视频。");
    if (preview.plan.metadata.platform !== "bilibili" || !preview.plan.audioPlan?.streams.length)
      throw new Error("平台没有返回可提取的音轨。");
    res.json(register(preview.plan.audioPlan));
  } catch (error) { next(error); }
});
app.post("/api/video/:id/retry", async (req, res, next) => {
  try { res.json(publicVideo(await retryVideo(req.params.id))); }
  catch (error) { next(error); }
});
app.post("/api/video/:id/cancel", (req, res, next) => {
  try { res.json(publicVideo(videoQueue.cancel(req.params.id))); }
  catch (error) { next(error); }
});
function publicVideo(task: VideoTask) {
  const { checksum: _checksum, ...visible } = task;
  return { ...visible, fileExists: task.status === "completed" ? !task.detached && !!task.filePath && existsSync(task.filePath) : undefined };
}
async function savedVideo(id: string) {
  const task = videoQueue.tasks.get(id);
  if (task?.status !== "completed" || !task.filePath || task.detached) return undefined;
  const stat = await lstat(task.filePath).catch(() => undefined);
  return stat?.isFile() ? task.filePath : undefined;
}
app.get("/api/video/:id/media", async (req, res) => {
  const file = await savedVideo(req.params.id);
  if (!file) return res.sendStatus(404);
  res.sendFile(file);
});
app.post("/api/video/:id/open-folder", async (req, res, next) => {
  try {
    const file = await savedVideo(req.params.id);
    if (!file) return res.status(404).json({ error: "视频文件已移走或删除。" });
    await openFolder(path.dirname(file));
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/video/:id/relocate", async (req, res, next) => {
  const task = videoQueue.tasks.get(req.params.id);
  if (task?.status !== "completed" || !task.checksum)
    return res.status(400).json({ error: "此视频没有可用的文件校验记录，请重新导入。" });
  if (deletingJobs.has(task.id) || relocatingJobs.has(task.id))
    return res.status(409).json({ error: "视频记录正在更新，请稍后重试。" });
  relocatingJobs.add(task.id);
  try {
    const selected = await chooseNative("file", task.filePath ? path.dirname(task.filePath) : storage.describe("video").outputDir);
    if (!selected) return res.json(null);
    if (!await checkedMediaFile(selected, task.checksum, "video")) throw new Error("文件与原视频不一致，请选择备份中的原视频。");
    if (videoQueue.tasks.get(task.id) !== task) throw new Error("视频记录已变化，请刷新后重试。");
    task.filePath = selected;
    task.detached = undefined;
    videoQueue.save(task);
    res.json(publicVideo(task));
  } catch (error) { next(error); }
  finally { relocatingJobs.delete(task.id); }
});
app.get("/api/videos", (_, res) => res.json([...videoQueue.tasks.values()].reverse().map(publicVideo)));
app.get("/api/video-current", (_, res) => {
  const task = [...videoQueue.tasks.values()].at(-1);
  res.json(task ? publicVideo(task) : null);
});
app.get("/api/video/queue", (_, res) => res.json(videoQueue.state()));
app.post("/api/video/queue", (req, res) => {
  if (typeof req.body?.paused !== "boolean") return res.status(400).json({ error: "队列状态无效。" });
  res.json(videoQueue.setPaused(req.body.paused));
});
app.get("/api/video/:id", (req, res) => {
  const task = videoQueue.tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "视频任务不存在，请重新解析。" });
  res.json(publicVideo(task));
});

app.post("/api/resolve", async (req, res, next) => {
  try {
    const input = String(req.body.input || "").trim();
    if (!input) throw new Error("请先粘贴分享链接。");
    res.json(await resolveInput(input));
  } catch (e) {
    next(e);
  }
});
const previewRequests = new Set<AbortController>();
app.post("/api/discovery/preview", async (req, res, next) => {
  if (closing) return res.status(409).json({ error: "拾音正在退出。" });
  if (previewRequests.size >= 3) return res.status(429).json({ error: "试听请求较多，请稍后再试。" });
  if (typeof req.body?.id !== "string" || !/^[1-9]\d{5,24}$/.test(req.body.id))
    return res.status(400).json({ error: "歌曲编号无效。" });
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
  previewRequests.add(controller);
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  let scratch: string | undefined;
  try {
    const plan = await readQishuiTrack(req.body.id, { signal, preview: true });
    const choice = plan.resource.choices.find(item => item.format === "m4a" || item.format === "aac");
    const stream = plan.streams.find(item => item.id === (choice?.id ?? plan.resource.choices[0]?.id));
    if (!stream) throw new Error("这首歌暂时没有可用的试听资源。");
    scratch = await mkdtemp(path.join(temp, "试听-"));
    const downloaded = path.join(scratch, "source.bin");
    await downloadAudioStream(stream, downloaded, signal, () => {}, 48 * 1024 * 1024);
    const source = await prepareStreamFile(stream, downloaded, scratch, signal);
    const preview = path.join(scratch, "preview.mp3");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", source,
      "-map", "0:a:0", "-vn", "-t", "60", "-c:a", "libmp3lame", "-b:a", "128k", preview], signal);
    res.type("mp3");
    await new Promise<void>((resolve, reject) => res.sendFile(preview, error => error ? reject(error) : resolve()));
  } catch (error) { if (!res.destroyed) next(error); }
  finally {
    res.off("close", disconnected);
    previewRequests.delete(controller);
    if (scratch) await removeTemporary(scratch, true);
  }
});
app.get("/api/discovery/batches", (_, res) => res.json(batches.discoveryHistory(id => {
  const job = jobs.get(id);
  return !!job && job.status !== "completed";
})));
app.post("/api/discovery/batches", (req, res, next) => {
  try {
    if (closing) throw new Error("拾音正在退出。");
    const { tracks, title, format, allowPreview } = req.body ?? {};
    if (format !== undefined && format !== "mp3" && format !== "m4a" && format !== "original")
      throw new Error("请选择有效输出格式。");
    const autoSave = format === undefined ? undefined : {
      ...organization, format, outputDir: existingDirectory(storage.outputDir), allowPreview: allowPreview === true,
    };
    res.status(201).json(batches.createDiscovery(tracks, title, autoSave));
  } catch (error) { next(error); }
});
app.get("/api/discovery/batches/:id", (req, res, next) => {
  try { res.json(batches.discoveryBatch(req.params.id)); }
  catch (error) { next(error); }
});
app.post("/api/discovery/batches/:id/:action", async (req, res, next) => {
  try {
    if (closing) throw new Error("拾音正在退出。");
    const batch = batches.discoveryBatch(req.params.id);
    if (req.params.action === "stop") res.json(batches.cancel(batch.id));
    else if (req.params.action === "retry") res.json(batches.resumeDiscovery(batch.id));
    else if (req.params.action === "resource") {
      const item = batch.items.find(item => item.id === req.body?.itemId);
      if (item?.status !== "ready" || !item.track) throw new Error("这首歌曲还未解析完成。");
      const plan = item.resource && plans.get(item.resource.token);
      res.json(plan && !planNeedsRefresh(plan) ? plan.resource
        : register(await readQishuiTrack(item.track.id)));
    } else res.sendStatus(404);
  } catch (error) { next(error); }
});
app.post("/api/discovery/search", async (req, res, next) => {
  try { res.json({ items: await searchTracks(req.body.keyword, accounts.cookie("qishui")) }); }
  catch (e) { next(e); }
});
app.get("/api/discovery/my-playlists", async (_, res, next) => {
  try {
    const account = await checkAccount("qishui");
    if (account.status !== "connected") throw new Error("请先在设置中连接并确认汽水账号，再读取歌单。");
    res.json(await myPlaylists(accounts.cookie("qishui")));
  }
  catch (e) { next(e); }
});
const upload = multer({
  dest: temp,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});
app.post("/api/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("请选择音频或视频文件。");
    const info = await probe(req.file.path);
    const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const plan: Plan = {
      resource: {
        token: randomUUID(),
        platform: "local",
        sourceId: await checksum(req.file.path),
        title: info.tags.title || path.parse(name).name,
        artist: info.tags.artist || "本地文件",
        album: info.tags.album || "",
        duration: info.duration,
        completeness: "full",
        note: "从你选择的本地文件中提取音轨。",
        choices: [{ id: "original", label: "原始音轨", format: info.codec }],
      },
      streams: [],
      inputFile: req.file.path,
    };
    if (closing || res.destroyed) { await removeTemporary(req.file.path); return; }
    res.json(register(plan));
  } catch (e) {
    if (req.file) await removeTemporary(req.file.path);
    next(e);
  }
});
// Discard only unsubmitted local uploads; active jobs retain their source until completion.
app.delete("/api/uploads/:token", async (req, res, next) => {
  try {
    const token = String(req.params.token);
    const plan = plans.get(token);
    if (claimedUploads.has(token))
      return res.status(409).json({ error: "文件已加入任务，不能移除正在使用的来源。" });
    if (plan?.inputFile) await discardPlan(plan);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get("/api/library/settings", (_, res) => res.json(organization));
app.post("/api/library/settings", (req, res, next) => {
  try {
    const nextSettings = librarySettings(req.body);
    writeFileSync(
      path.join(local, "library.json"),
      JSON.stringify(nextSettings),
      { mode: 0o600 },
    );
    organization = nextSettings;
    res.json(organization);
  } catch (e) {
    next(e);
  }
});
function savedFileExists(job: Job) {
  const file = jobFile(job, legacyOutput);
  return job.status === "completed" && !deletingJobs.has(job.id) && !!file && existsSync(file);
}
function audioSelection(resource: Resource, choice: string) {
  const selected = resource.choices.find(item => item.id === choice);
  return selected ? { quality: selected.quality, bitrate: selected.bitrate, format: selected.format } : undefined;
}
app.post("/api/library/match", (req, res, next) => {
  try {
    const plan = plans.get(req.body.token) || claimedUploads.get(req.body.token);
    if (!plan) return res.json({ job: null });
    const saved = findSaved(jobs.values(), plan.resource, req.body.format, audioSelection(plan.resource, req.body.choice), savedFileExists);
    res.json({ job: saved ? publicJob(saved) : null });
  } catch (error) { next(error); }
});
app.get("/api/jobs/:id/audio-codec", async (req, res, next) => {
  try {
    const job = jobs.get(String(req.params.id));
    const file = job && jobFile(job, legacyOutput);
    if (job?.status !== "completed" || !file || !existsSync(file))
      return res.status(404).json({ error: "原音频文件不存在，请先重新定位或导入文件。" });
    const info = await probe(file, AbortSignal.timeout(10000));
    res.json({ codec: info.codec });
  } catch (error) { next(error); }
});
app.get("/api/jobs/:id/waveform", async (req, res, next) => {
  const job = jobs.get(String(req.params.id));
  const file = job && jobFile(job, legacyOutput);
  if (job?.status !== "completed" || !file || !existsSync(file))
    return res.sendStatus(404);
  const controller = new AbortController();
  playlistRequests.add(controller);
  const abort = () => {
    playlistRequests.delete(controller);
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", abort);
  const output = path.join(temp, `wave-${randomUUID()}.jpg`);
  try {
    await run(
      "ffmpeg",
      [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-filter_complex",
        "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1000x160:colors=0xff9077[wave];color=c=0x382c28:s=1000x160:d=1[bg];[bg][wave]overlay=shortest=1",
        "-frames:v",
        "1",
        output,
      ],
      AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    );
    res.type("jpeg").sendFile(output, async (err) => {
      await removeTemporary(output);
      if (err && !res.headersSent) next(err);
    });
  } catch (e) {
    await removeTemporary(output);
    if (!res.destroyed) next(e);
  }
});
app.post(
  ["/api/jobs/:id/clip", "/api/jobs/:id/organize"],
  async (req, res, next) => {
    try {
      const parent = jobs.get(String(req.params.id));
      const file = parent && jobFile(parent, legacyOutput);
      if (parent && deletingJobs.has(parent.id)) throw new Error("音频正在移除，请稍后重试。");
      if (parent?.status !== "completed" || !file || !existsSync(file))
        throw new Error("原音频文件不存在，请先重新定位或导入文件。");
      const organizing = req.path.endsWith("/organize");
      const clip = organizing
        ? undefined
        : clipRange(req.body.clip, parent.duration || 0);
      const format = req.body.format;
      if (
        !(
          organizing ? ["original", "mp3", "m4a"] : ["mp3", "m4a", "wav"]
        ).includes(format)
      )
        throw new Error("请选择 MP3、M4A 或 WAV。");
      const metadata = metadataOf(req.body.metadata, {
        title: organizing ? parent.title : `${parent.title}（片段）`,
        artist: parent.artist,
        album: parent.metadata?.album,
      });
      const existing = [...jobs.values()].find(
        (j) =>
          JSON.stringify(j.metadata) === JSON.stringify(metadata) &&
          j.parentJobId === parent.id &&
          j.format === format &&
          JSON.stringify(j.clip) === JSON.stringify(clip) &&
          !["completed", "failed", "cancelled"].includes(j.status),
      );
      if (existing) return res.status(200).json(publicJob(existing));
      const plan: Plan = {
        resource: {
          token: randomUUID(),
          platform: parent.platform,
          sourceId: parent.sourceId || parent.id,
          title: metadata.title,
          artist: metadata.artist,
          duration: clip ? clip.end - clip.start : parent.duration || 0,
          completeness: parent.completeness,
          note: "从已保存音频截取",
          choices: [],
        },
        streams: [],
        inputFile: file,
      };
      const job: Job = {
        id: randomUUID(),
        title: metadata.title,
        artist: metadata.artist,
        metadata,
        naming: organization.naming,
        embedCover: organization.embedCover,
        cover: parent.cover,
        platform: parent.platform,
        sourceId: parent.sourceId,
        completeness: parent.completeness,
        parentJobId: parent.id,
        clip,
        kind: organizing ? "organized" : "clip",
        format,
        status: "queued",
        progress: 0,
        message: organizing ? "等待另存整理版" : "等待截取片段",
        createdAt: new Date().toISOString(),
        outputDir: existingDirectory(storage.outputDir),
      };
      save(job);
      queue.push({ job, plan, choice: "" });
      queueMicrotask(drain);
      res.status(201).json(publicJob(job));
    } catch (e) {
      next(e);
    }
  },
);
function playlistNames(): string[] {
  const names = new Map<string, string>();
  for (const row of db.prepare("SELECT key, name FROM library_playlists ORDER BY rowid").all())
    names.set(String(row.key), String(row.name));
  for (const job of jobs.values()) {
    if (job.status !== "completed") continue;
    for (const name of job.groups || []) if (!names.has(groupKey(name))) names.set(groupKey(name), name);
  }
  return [...names.values()];
}

function updateLibraryRows(updates: Job[]) {
  const update = db.prepare("UPDATE jobs SET value = ? WHERE id = ?");
  for (const job of updates) {
    if (update.run(JSON.stringify(job), job.id).changes !== 1)
      throw new Error("部分音频记录已变化，请刷新后重试。");
  }
}

const backupLimit = 12 * 1024 ** 2;
let pendingRestore: { id: string; backup: RecordsBackup; expires: number } | undefined;
let restoring = false;
function canRestoreRecords() {
  return !closing && !jobs.size && !videoQueue.tasks.size && !batches.pending && !videoQueue.busy &&
    !playlistNames().length && !customPresets().length;
}
app.get("/api/backup", (_, res, next) => {
  try {
    const backup = readBackup({
      schema: "shiyin-records", version: 1, createdAt: new Date().toISOString(), audio: [...jobs.values()],
      video: [...videoQueue.tasks.values()].map(task => ({ task, ...videoQueue.request(task.id) })),
      groups: playlistNames(), presets: customPresets(),
    });
    const json = JSON.stringify(backup);
    if (Buffer.byteLength(json) > backupLimit) throw new Error("记录备份超出 12 MB，无法生成。");
    res.set("Cache-Control", "no-store").attachment(`Shiyin-records-${backup.createdAt.slice(0, 10)}.json`).type("json").send(json);
  } catch (error) { next(error); }
});
app.post("/api/backup/preview", (req, res, next) => {
  try {
    const backup = readBackup(req.body);
    const id = randomUUID();
    pendingRestore = { id, backup, expires: Date.now() + 15 * 60_000 };
    res.json({
      id, createdAt: backup.createdAt, canRestore: !restoring && canRestoreRecords(),
      audio: backup.audio.length, video: backup.video.length, favorites: backup.audio.filter(job => job.favorite).length,
      groups: backup.groups.length, presets: backup.presets.length,
    });
  } catch (error) { next(error); }
});
app.post("/api/backup/restore", async (req, res, next) => {
  if (restoring || !canRestoreRecords()) return res.status(409).json({error: "当前资料库已有记录、歌单或预设。请选择空资料库恢复。"});
  const pending = pendingRestore;
  if (!pending || pending.id !== req.body?.id || pending.expires <= Date.now()) return res.status(400).json({error: "备份预览已过期，请重新打开。"});
  restoring = true;
  try {
    const { backup } = pending;
    await associateBackupFiles(backup, legacyOutput);
    if (pendingRestore !== pending) return res.status(409).json({error: "已打开另一份备份，请重新预览确认。" });
    if (!canRestoreRecords()) return res.status(409).json({error: "资料库在检查期间已有改动，恢复已停止。"});
    const writeJob = db.prepare("INSERT INTO jobs (id,value) VALUES (?,?)");
    const writeGroup = db.prepare("INSERT INTO library_playlists (key,name) VALUES (?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const job of backup.audio) writeJob.run(job.id, JSON.stringify(job));
      for (const record of backup.video) saveVideoRecord(record);
      for (const name of backup.groups) writeGroup.run(groupKey(name), name);
      for (const preset of backup.presets) savePreset(preset);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const job of backup.audio) jobs.set(job.id, job);
    for (const record of backup.video) videoQueue.restoreRecord(record);
    if (pendingRestore === pending) pendingRestore = undefined;
    res.json({ ok: true });
  } catch (error) { next(error); }
  finally { restoring = false; }
});

app.get("/api/library/playlists", (_, res) => res.json({ playlists: playlistNames() }));
app.post("/api/library/playlists", (req, res, next) => {
  try {
    const { action } = req.body || {};
    if (!["create", "rename", "remove"].includes(action)) throw new Error("歌单操作无效。");
    const name = validGroupName(req.body?.name);
    const key = groupKey(name);
    const names = new Map(playlistNames().map(existing => [groupKey(existing), existing]));
    const replacement = action === "rename" ? validGroupName(req.body?.newName) : name;
    const replacementKey = groupKey(replacement);
    if (action === "create") {
      if (names.has(key)) throw new Error("已存在同名歌单。");
      if (names.size >= 200) throw new Error("歌单数量已达上限，请先移除不需要的歌单。");
    } else {
      if (!names.has(key)) throw new Error("歌单已不存在，请刷新后重试。");
      if (action === "rename" && replacementKey !== key && names.has(replacementKey))
        throw new Error("已存在同名歌单。");
    }

    const updates: Job[] = [];
    if (action !== "create") {
      for (const job of jobs.values()) {
        if (job.status !== "completed" || !job.groups?.some(group => groupKey(group) === key)) continue;
        if (deletingJobs.has(job.id)) throw new Error("歌单中有歌曲正在移除，请稍后重试。");
        const groups = action === "remove"
          ? job.groups.filter(group => groupKey(group) !== key)
          : job.groups.map(group => groupKey(group) === key ? replacement : group);
        updates.push({ ...job, groups });
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (action !== "create") db.prepare("DELETE FROM library_playlists WHERE key = ?").run(key);
      if (action !== "remove") db.prepare("INSERT INTO library_playlists (key, name) VALUES (?, ?)").run(replacementKey, replacement);
      updateLibraryRows(updates);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const job of updates) jobs.set(job.id, job);
    res.json({ playlists: playlistNames(), jobs: updates.map(publicJob) });
  } catch (error) { next(error); }
});
app.post("/api/library/organize", (req, res, next) => {
  try {
    if (Array.isArray(req.body?.ids) && req.body.ids.some((id: unknown) => typeof id === "string" && deletingJobs.has(id)))
      throw new Error("所选音频正在移除，请稍后重试。");
    const updates = organizeLibrary(req.body?.ids, req.body?.action, req.body?.value, jobs, playlistNames());
    db.exec("BEGIN IMMEDIATE");
    try {
      updateLibraryRows(updates);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const job of updates) jobs.set(job.id, job);
    res.json({ jobs: updates.map(publicJob), playlists: playlistNames() });
  } catch (error) { next(error); }
});
const exportingJobs = new Map<string, number>();
app.post("/api/library/export", async (req, res, next) => {
  if (Array.isArray(req.body.ids) && req.body.ids.some((id: unknown) => typeof id === "string" && deletingJobs.has(id))) return next(new Error("所选音频正在移除，请稍后重试。"));
  const ids = new Set<string>(Array.isArray(req.body.ids) ? req.body.ids.filter((id: unknown) => typeof id === "string") : []);
  for (const id of ids) exportingJobs.set(id, (exportingJobs.get(id) || 0) + 1);
  const task = exportLibrary(req.body.ids, req.body.format, jobs, storage.outputDir, legacyOutput);
  const tracking = task.then(() => {}, () => {});
  running.add(tracking);
  try { res.status(201).json(await task); }
  catch (error) { next(error); }
  finally {
    running.delete(tracking);
    for (const id of ids) {
      const count = exportingJobs.get(id)! - 1;
      if (count) exportingJobs.set(id, count);
      else exportingJobs.delete(id);
    }
  }
});
function audioQueueState(): AudioQueueState {
  return {
    paused: queuePaused,
    waiting: queue.filter(({ job }) => job.status === "queued").length,
    active,
    limit: audioQueueLimit,
    lastSummary: completionTracker?.last || null,
  };
}
app.get("/api/queue", (_, res) => res.json(audioQueueState()));
app.post("/api/queue", (req, res) => {
  if (typeof req.body.paused !== "boolean") return res.status(400).json({ error: "队列状态无效。" });
  queuePaused = req.body.paused;
  if (!queuePaused) drain();
  res.json(audioQueueState());
});
app.get("/api/jobs", (_, res) =>
  res.json([...jobs.values()].reverse().map(publicJob)),
);
function createJob(
  options: {
    token: string;
    format: string;
    choice?: string;
    allowPreview?: boolean;
    forceCopy?: boolean;
    metadata?: unknown;
    outputDir?: string;
    organization?: unknown;
    reuseActive?: boolean;
  },
  batchId?: string,
  discoveryItemId?: string,
) {
  if (closing) throw new Error("拾音正在退出。");
  // A retried batch item can already have a job if the service stopped before recording the link.
  const linked = discoveryItemId && jobs.get(discoveryItemId);
  if (linked) return linked;
  const plan = plans.get(options.token) || claimedUploads.get(options.token);
  if (!plan) throw new Error("解析结果已过期，请重新解析链接或导入文件。");
  if (!["mp3", "m4a", "original", ...(plan.resource.platform === "local" ? ["wav"] : [])].includes(options.format))
    throw new Error("请选择有效输出格式。");
  if (plan.resource.completeness === "preview" && options.allowPreview !== true)
    throw new Error("当前只有试听片段，请明确选择保存试听。");
  if (discoveryItemId && plan.resource.completeness === "unknown")
    throw new Error("音频完整性未知，请先查看资源。");
  const choice = String(options.choice || plan.resource.choices[0]?.id);
  if (!plan.inputFile && !plan.streams.some((s) => s.id === choice))
    throw new Error("音质选项不存在。");
  const selection = audioSelection(plan.resource, choice);
  if (options.forceCopy !== true) {
    const saved = findSaved(jobs.values(), plan.resource, options.format, selection, savedFileExists);
    if (saved) {
      if (plan.inputFile) void discardPlan(plan);
      return saved;
    }
  }
  const destination = options.outputDir === undefined ? existingDirectory(storage.outputDir) : existingDirectory(options.outputDir);
  const organize = options.organization === undefined ? organization : librarySettings(options.organization);
  const metadata = metadataOf(options.metadata, {
    title: plan.resource.title,
    artist: plan.resource.artist === "本地文件" ? "" : plan.resource.artist,
    album: plan.resource.album || "",
  });
  const existing = [...jobs.values()].find(j => {
    if (["completed", "failed", "cancelled"].includes(j.status)) return false;
    if (discoveryItemId) return sameSource(j, plan.resource, options.format, selection);
    const sameSelection = j.platform === plan.resource.platform && j.sourceId === plan.resource.sourceId &&
      j.format === options.format && JSON.stringify(j.selection) === JSON.stringify(selection);
    return j.resourceToken === plan.resource.token || sameSelection;
  });
  if (existing && (discoveryItemId || plan.resource.platform === "local") && options.reuseActive === true && options.forceCopy !== true) {
    if (existing.resourceToken !== plan.resource.token && plan.inputFile) void discardPlan(plan);
    return existing;
  }
  if (existing)
    throw Object.assign(new Error("该资源正在处理，请等待或取消原任务。"), {
      status: 409,
    });
  if (claimedUploads.has(options.token))
    throw Object.assign(new Error("该文件正在恢复，请稍候。"), { status: 409 });
  const job: Job = {
    id: discoveryItemId || randomUUID(),
    title: metadata.title,
    artist: metadata.artist,
    metadata,
    naming: organize.naming,
    embedCover: organize.embedCover,
    cover: plan.resource.cover,
    platform: plan.resource.platform,
    audioSource: plan.resource.audioSource,
    status: "queued",
    progress: 0,
    message: "等待处理",
    format: options.format,
    createdAt: new Date().toISOString(),
    completeness: plan.resource.completeness,
    resourceToken: plan.resource.token,
    sourceId: plan.resource.sourceId,
    selection,
    batchId,
    requiresFullAudio: discoveryItemId && plan.resource.completeness === "full" ? true : undefined,
    outputDir: destination,
  };
  save(job);
  if (plan.inputFile) claimUpload(plan);
  queue.push({ job, plan, choice });
  // Let the caller persist batch linkage before download starts.
  queueMicrotask(drain);
  return job;
}
app.post("/api/jobs", (req, res, next) => {
  try {
    const sizeBefore = jobs.size;
    const job = createJob(req.body);
    const reused = jobs.size === sizeBefore;
    res.status(reused ? 200 : 201).json({ ...publicJob(job), reused });
  } catch (e) {
    next(e);
  }
});
// Called only by the authenticated desktop process after a browser handoff.
app.post("/api/extension/douyin", async (req, res, next) => {
  try {
    if (!parentPort) return res.status(403).json({ error: "请使用拾音桌面版。" });
    const id = String(req.body.id || "");
    if (!/^\d{15,22}$/.test(id)) throw new Error("视频编号无效。");
    const resource = await resolveInput(`https://www.douyin.com/video/${id}`);
    const before = jobs.size;
    const job = createJob({ token: resource.token, format: "mp3" });
    res.json({ ...publicJob(job), reused: before === jobs.size });
  } catch (error) { next(error); }
});
app.post('/api/extension/bilibili', async (req, res, next) => {
  try {
    if (!parentPort) return res.status(403).json({ error: '请使用拾音桌面版。' });
    const id = String(req.body.id || ''), part = Number(req.body.part);
    if (!/^BV[0-9A-Za-z]{10}$/.test(id) || !Number.isSafeInteger(part) || part < 1 || part > 10000) throw new Error('视频或分 P 编号无效。');
    const resource = await resolveInput(`https://www.bilibili.com/video/${id}?p=${part}`);
    const before = jobs.size;
    const job = createJob({ token: resource.token, format: 'mp3' });
    res.json({ ...publicJob(job), reused: before === jobs.size });
  } catch (error) { next(error); }
});
app.get("/api/batches", (_, res) => res.json(batches.list()));
app.post("/api/playlists", async (req, res, next) => {
  const controller = new AbortController();
  playlistRequests.add(controller);
  const disconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", disconnected);
  try {
    const playlist = await readPlaylist(
      req.body.input,
      accounts.cookie("qishui"),
      { signal: controller.signal },
    );
    controller.signal.throwIfAborted();
    if (req.body.browse === true) return res.json(playlist);
    res.status(201).json(batches.importPlaylist(playlist));
  } catch (e) {
    if (!res.destroyed) next(e);
  } finally {
    playlistRequests.delete(controller);
    res.off("close", disconnected);
  }
});
app.post("/api/batches/:id/check-playlist", async (req, res, next) => {
  const controller = new AbortController();
  playlistRequests.add(controller);
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  try {
    const batch = batches.get(String(req.params.id));
    if (!batch.playlist?.comparisonReady) throw new Error("旧清单无法确认完整，请先重新展开歌单，再检查更新。");
    const playlist = await readPlaylist(batch.playlist.id, accounts.cookie("qishui"), { signal: controller.signal });
    controller.signal.throwIfAborted();
    res.status(201).json(batches.comparePlaylist(batch.id, playlist));
  } catch (e) { if (!res.destroyed) next(e); }
  finally { playlistRequests.delete(controller); res.off("close", disconnected); }
});
app.post("/api/batches/:id/resolve-selected", (req, res, next) => {
  try {
    res.json(batches.resolveSelected(String(req.params.id), req.body.itemIds));
  } catch (e) {
    next(e);
  }
});
app.post("/api/batches", (req, res, next) => {
  try {
    res.status(201).json(batches.create(req.body.input));
  } catch (e) {
    next(e);
  }
});
app.post("/api/batches/:id/cancel", (req, res, next) => {
  try {
    res.json(batches.cancel(String(req.params.id)));
  } catch (e) {
    next(e);
  }
});
app.post("/api/batches/:id/items/:itemId/retry", (req, res, next) => {
  try {
    res.json(batches.retry(String(req.params.id), String(req.params.itemId), id => jobs.has(id)));
  } catch (e) {
    next(e);
  }
});
app.post("/api/batches/:id/items/:itemId/submit", (req, res, next) => {
  try {
    const id = String(req.params.id);
    const discovery = batches.get(id).discovery;
    const result = batches.submit(id, String(req.params.itemId), (resource) => {
      const refreshed = discovery && req.body?.token ? plans.get(String(req.body.token))?.resource : undefined;
      if (discovery && req.body?.token && (refreshed?.platform !== resource.platform || refreshed.sourceId !== resource.sourceId))
        throw new Error("解析结果已失效，请重新查看此歌曲。");
      return createJob({ ...req.body, token: refreshed?.token ?? resource.token }, id);
    });
    const job = jobs.get(result.jobId);
    res
      .status(result.created ? 201 : 200)
      .json({ ...result, job: job ? publicJob(job) : undefined });
  } catch (e) {
    next(e);
  }
});
const deletingJobs = new Set<string>();
const relocatingJobs = new Set<string>();
const retryLocks = new Set<string>();
const pendingDeletions = new Set<Promise<void>>();
function requireRecordRemoval(body: unknown) {
  const mode = (body as { mode?: unknown } | undefined)?.mode;
  if (mode !== undefined && mode !== "record")
    throw new Error("拾音仅支持移除记录。");
}

async function runDeletion(id: string, action: () => Promise<void>) {
  if (closing) throw new Error("拾音正在退出。");
  if (deletingJobs.has(id)) throw Object.assign(new Error("正在处理这条记录，请稍候。"), { status: 409 });
  deletingJobs.add(id);
  const work = Promise.resolve().then(action);
  const settled = work.then(() => {}, () => {});
  pendingDeletions.add(settled);
  try { await work; }
  finally {
    pendingDeletions.delete(settled);
    deletingJobs.delete(id);
    drain();
  }
}

function audioRemovalBlock(id: string) {
  if (relocatingJobs.has(id)) return "该音频正在重新关联，请稍后再移除记录。";
  if (exportingJobs.has(id)) return "该音频正在导出，请稍后再移除记录。";
  if ([...jobs.values()].some(other => other.parentJobId === id && !["completed", "failed", "cancelled"].includes(other.status)))
    return "该音频有正在等待或处理的派生任务，请先完成或取消这些任务。";
}

function removeAudioRecord(id: string) {
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  clearPendingOutput.run(id);
  jobs.delete(id);
  completionTracker?.remove(id);
}

function removeVideoRecord(id: string) {
  videoQueue.remove(id, () => {
    db.prepare("DELETE FROM video_jobs WHERE id = ?").run(id);
    clearPendingOutput.run(id);
  });
}

function fileDefinitelyMissing(file?: string) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    // An unavailable drive or inaccessible path is not proof the file was deleted.
    return !lstatSync(file, { throwIfNoEntry: false }) &&
      statSync(path.dirname(file), { throwIfNoEntry: false })?.isDirectory() === true;
  } catch { return false; }
}

function cleanMissingMediaRecords() {
  if (closing) return;
  for (const job of jobs.values()) {
    if (job.status !== "completed" || deletingJobs.has(job.id)) continue;
    if (fileDefinitelyMissing(jobFile(job, legacyOutput)) && !audioRemovalBlock(job.id)) removeAudioRecord(job.id);
  }
  for (const task of videoQueue.tasks.values()) {
    const id = task.id;
    if (task.status !== "completed" || task.detached || deletingJobs.has(id) || relocatingJobs.has(id) || retryLocks.has(id)) continue;
    if (videoQueue.canRemove(id) && fileDefinitelyMissing(task.filePath)) removeVideoRecord(id);
  }
}
setInterval(() => {
  try { cleanMissingMediaRecords(); }
  catch (error) { console.error("自动清理缺失媒体记录失败", error); }
}, 2500).unref();

app.post("/api/jobs/:id/remove", async (req, res, next) => {
  try {
    const id = String(req.params.id), job = jobs.get(id);
    if (job?.status !== "completed") throw new Error("只能删除已完成的音频。");
    requireRecordRemoval(req.body);
    await runDeletion(id, async () => {
      const block = audioRemovalBlock(id);
      if (block) throw new Error(block);
      removeAudioRecord(id);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/video/:id/remove", async (req, res, next) => {
  try {
    const id = req.params.id;
    const task = videoQueue.tasks.get(id);
    if (!task) return res.status(404).json({ error: "视频任务不存在。" });
    requireRecordRemoval(req.body);
    await runDeletion(id, async () => {
      if (retryLocks.has(id)) throw new Error("视频正在恢复，请稍后再删除。");
      if (relocatingJobs.has(id)) throw new Error("视频正在重新关联，请稍后再移除记录。");
      removeVideoRecord(id);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/jobs/clear-incomplete", (req, res, next) => {
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id)) {
    return res.status(400).json({ error: "请选择要清理的任务记录。" });
  }
  const unique = [...new Set<string>(ids)];
  if (unique.some(id => {
    const job = jobs.get(id);
    return !job || !["failed", "cancelled"].includes(job.status) ||
      retryLocks.has(id) || controllers.has(id) || deletingJobs.has(id);
  })) {
    return res.status(409).json({ error: "部分任务的状态已变化，请刷新后再清理。" });
  }
  try {
    const remove = db.prepare("DELETE FROM jobs WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const id of unique) { remove.run(id); clearPendingOutput.run(id); }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const id of unique) {
      jobs.delete(id);
      completionTracker?.remove(id);
    }
    res.json({ removed: unique.length });
  } catch (error) { next(error); }
});
function withRetryLock<T>(id: string, action: () => Promise<T>) {
  if (closing) throw new Error("拾音正在退出。");
  if (deletingJobs.has(id) || retryLocks.has(id)) throw Object.assign(new Error("该任务正在重新获取资源，请稍候。"), {status:409});
  if (controllers.has(id)) throw Object.assign(new Error("上一轮处理正在结束，请稍候。"), { status: 409 });
  retryLocks.add(id);
  const work = Promise.resolve().then(action).finally(() => { retryLocks.delete(id); running.delete(tracked); });
  const tracked = work.then(() => {}, () => {});
  running.add(tracked);
  return work;
}
async function retryRemote(j: Job) {
  return withRetryLock(j.id, () => restartRemote(j));
}
async function restartRemote(j: Job) {
  const id = j.id;
  if (!["failed", "cancelled"].includes(j.status)) throw new Error("该任务当前不能重试。");
  if (j.platform === "local" || j.parentJobId) throw new Error("请重新选择本地文件后提取。");
  if (j.interrupted && await restoreAudioOutput(j)) return j;
  if (closing) return j;
  const controller = new AbortController();
  controllers.set(id, controller);
  patch(j, { status: "queued", failureKind: undefined, message: "正在重新获取资源", progress: 0 });
  try {
    const item = await refreshForJob(j, controller.signal);
    controller.signal.throwIfAborted();
    patch(j, { needsReview: undefined });
    queue.push({ job: j, ...item });
    controllers.delete(id);
    drain();
    return j;
  } catch (e) {
    if (closing && controller.signal.aborted && j.status !== "cancelled") interruptedAudio(j);
    else patch(j, {
      status: controller.signal.aborted ? "cancelled" : "failed",
      failureKind: !controller.signal.aborted && isNetworkFailure(e) ? "network" : undefined,
      needsReview: !controller.signal.aborted && j.interrupted && !isNetworkFailure(e) ? true : undefined,
      message: controller.signal.aborted ? "任务已取消" : readableError(e),
    });
    if (controller.signal.aborted) return j;
    throw e;
  } finally {
    if (controllers.get(id) === controller) controllers.delete(id);
  }
}
function unavailableDestination(directory: string) {
  try { existingDirectory(directory); return false; }
  catch { return true; }
}
function audioRecovery(job: Job): RecoveryItem | undefined {
  if (!job.interrupted || job.status !== "failed") return;
  const item: RecoveryItem = { id: job.id, title: job.title, kind: "audio", action: "resume", message: job.message };
  if (unavailableDestination(job.outputDir || legacyOutput))
    return { ...item, action: "review", message: "原保存文件夹不可用，请接回外接盘或恢复目录权限。" };
  if (job.parentJobId) {
    const parent = jobs.get(job.parentJobId);
    const file = parent && jobFile(parent, legacyOutput);
    if (!file || !existsSync(file)) return { ...item, action: "review", message: "请先在歌单中重新定位原音频。" };
    if (job.kind === "vocals" || job.kind === "instrumental")
      return { ...item, action: "review", message: "请从原音频重新启动人声与伴奏分离。" };
  } else if (!job.sourceId) return { ...item, action: "review", message: "旧记录缺少来源，请重新添加原链接或文件。" };
  else if (job.platform === "local") {
    if (!/^[a-f0-9]{64}$/.test(job.sourceId)) return { ...item, action: "review", message: "旧记录无法核对源文件，请重新导入。" };
    return { ...item, action: "file", message: "选择原文件，拾音会保留这条任务的格式和保存位置。" };
  } else if (job.needsReview) return { ...item, action: "review", canReviewSource: true };
  return item;
}
function videoRecovery(task: VideoTask): RecoveryItem | undefined {
  if (!task.interrupted || task.status !== "failed") return;
  const item: RecoveryItem = { id: task.id, title: task.title || "视频", kind: "video", action: "resume", message: task.message };
  const request = videoQueue.request(task.id);
  if (!request || unavailableDestination(request.outputDir))
    return { ...item, action: "review", message: "原保存文件夹不可用，请接回外接盘或恢复目录权限。" };
  if (task.needsReview) return { ...item, action: "review", message: task.message + " 可在视频页重新解析后保存。" };
  return item;
}
function retryVideo(id: string) {
  return withRetryLock(id, async () => {
    const task = videoQueue.tasks.get(id);
    if (task?.status !== "failed") throw new Error("此视频任务无法重试，请重新解析链接。");
    if (await restoreVideoOutput(task)) { videoQueue.save(task); return task; }
    const request = videoQueue.request(id);
    if (!request) throw new Error("缺少原视频链接，请重新添加。");
    existingDirectory(request.outputDir);
    return videoQueue.retry(id);
  });
}
function queueRecovered(job: Job, plan: Plan, choice: string) {
  if (closing || !job.interrupted || job.status !== "failed") throw new Error("任务状态已变化，请刷新后再继续。");
  existingDirectory(job.outputDir || legacyOutput);
  patch(job, { status: "queued", resourceToken: plan.resource.token, progress: 0, message: "等待继续处理", needsReview: undefined });
  queue.push({ job, plan, choice });
  queueMicrotask(drain);
}
function resumeAudio(job: Job) {
  return withRetryLock(job.id, async () => {
    if (await restoreAudioOutput(job)) return;
    if (audioRecovery(job)?.action !== "resume") throw new Error("请按任务提示处理后再继续。");
    if (!job.parentJobId) { await restartRemote(job); return; }
    const parent = jobs.get(job.parentJobId)!;
    const inputFile = jobFile(parent, legacyOutput)!;
    const plan: Plan = { inputFile, streams: [], resource: {
      token: randomUUID(), platform: job.platform, sourceId: job.sourceId || parent.id, title: job.title,
      artist: job.artist, duration: job.clip ? job.clip.end - job.clip.start : parent.duration || 0,
      completeness: job.completeness, note: "继续处理已保存的音频", choices: [],
    } };
    queueRecovered(job, plan, "");
  });
}
app.get("/api/recovery", (_, res) => res.json([
  ...[...jobs.values()].reverse().map(audioRecovery),
  ...[...videoQueue.tasks.values()].reverse().map(videoRecovery),
].filter(item => item && !retryLocks.has(item.id))));
app.post("/api/recovery/resume", async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length)
      throw new Error("请选择 1 至 20 项待恢复任务。");
    const results: { id: string; title: string; message?: string }[] = [];
    for (const id of ids) {
      if (closing) break;
      const job = jobs.get(id), video = videoQueue.tasks.get(id);
      const title = job?.title || video?.title || "视频";
      try {
        if (job && audioRecovery(job)?.action === "resume") await resumeAudio(job);
        else if (video && videoRecovery(video)?.action === "resume") await retryVideo(id);
        else throw new Error("任务状态已变化，请按当前提示处理。");
        results.push({ id, title });
      } catch (error) { results.push({ id, title, message: readableError(error) }); }
    }
    res.json({ results });
  } catch (error) { next(error); }
});
app.post("/api/recovery/:id/file", async (req, res, next) => {
  try {
    const job = jobs.get(String(req.params.id));
    if (!job || audioRecovery(job)?.action !== "file") throw new Error("这条任务无需重新选择文件。");
    await withRetryLock(job.id, async () => {
      const token = String(req.body?.token);
      if (claimedUploads.has(token))
        throw Object.assign(new Error("该文件已加入其他任务，请重新选择原文件。"), { status: 409 });
      const plan = plans.get(token);
      if (!plan?.inputFile || plan.resource.platform !== "local" || plan.resource.sourceId !== job.sourceId)
        throw new Error("所选文件和原文件内容不一致，请重新选择。");
      claimUpload(plan);
      let queued = false;
      try {
        if (await restoreAudioOutput(job)) return;
        queueRecovered(job, plan, "original");
        queued = true;
      } finally {
        if (!queued) await releaseUpload(plan, job.status !== "completed");
      }
    });
    res.json(publicJob(job));
  } catch (error) { next(error); }
});
app.post("/api/recovery/:id/source", async (req, res, next) => {
  try {
    const job = jobs.get(String(req.params.id));
    if (!job || !audioRecovery(job)?.canReviewSource) throw new Error("这条任务无需重新确认资源。");
    const plan = await readAudioSource(job);
    if (plan.resource.sourceId !== job.sourceId) throw new Error("平台返回了不同的来源，请重新添加链接。");
    res.json(register(plan));
  } catch (error) { next(error); }
});
app.post("/api/recovery/:id/confirm", async (req, res, next) => {
  try {
    const job = jobs.get(String(req.params.id));
    if (!job || !audioRecovery(job)?.canReviewSource) throw new Error("任务状态已变化，请刷新后再试。");
    await withRetryLock(job.id, async () => {
      if (await restoreAudioOutput(job)) return;
      const plan = plans.get(String(req.body?.token));
      const choice = plan?.resource.choices.find(item => item.id === req.body?.choice);
      if (!plan || plan.resource.sourceId !== job.sourceId || plan.resource.platform !== job.platform || !choice)
        throw new Error("解析结果已失效，请重新确认资源。");
      if (plan.resource.completeness === "preview" && req.body?.allowPreview !== true)
        throw new Error("当前只有试听片段，请明确选择保存试听。");
      if (!["mp3", "m4a", "original"].includes(req.body?.format)) throw new Error("请选择有效输出格式。");
      existingDirectory(job.outputDir || legacyOutput);
      Object.assign(job, { format: req.body.format, completeness: plan.resource.completeness, audioSource: plan.resource.audioSource,
        requiresFullAudio: undefined, selection: { quality: choice.quality, bitrate: choice.bitrate, format: choice.format } });
      queueRecovered(job, plan, choice.id);
    });
    res.json(publicJob(job));
  } catch (error) { next(error); }
});
let bulkRetryRunning = false;
app.post("/api/jobs/retry-failed", async (req, res, next) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length)
    return res.status(400).json({error:"请选择 1 至 20 条不同的失败任务。"});
  if (bulkRetryRunning) return res.status(409).json({error:"批量重试正在进行，请稍候。"});
  if (queuePaused) return res.status(409).json({error:"队列已暂停，请先继续队列再批量重试。"});
  bulkRetryRunning = true;
  let finish!: () => void;
  const tracked = new Promise<void>(resolve => {finish = resolve});
  running.add(tracked);
  try {
    const results = await retryFailures(ids, {
      find: id => jobs.get(id),
      stopReason: () => closing ? "应用正在退出" : queuePaused ? "队列已暂停" : undefined,
      isLocked: id => retryLocks.has(id),
      retry: retryRemote,
      describe: readableError,
    });
    res.json({results});
  } catch (error) { next(error); }
  finally { bulkRetryRunning = false; finish(); running.delete(tracked); }
});
app.post("/api/jobs/:id/retry", async (req, res, next) => {
  try {
    const job = jobs.get(String(req.params.id));
    if (!job) return res.status(400).json({error:"该任务当前不能重试。"});
    res.json(publicJob(await retryRemote(job)));
  } catch(error) { next(error); }
});
app.get("/api/separation/status", async (_, res) => res.json(await checkSeparationRuntime()));
app.post("/api/separation/install", async (_, res, next) => {
  try { res.status(202).json(await startSeparationInstallation()); }
  catch (error) { next(error); }
});
let separationBusy = false;
app.post("/api/jobs/:id/separate", async (req, res, next) => {
  try {
    if (queuePaused) throw new Error("任务队列已暂停，请先继续队列再开始分离。");
    if (separationBusy || active >= audioQueueLimit) throw new Error("当前处理任务较多，请等待后再分离。");
    const component = await checkSeparationRuntime();
    if (!component.available) throw new Error(component.message);
    if (closing) throw new Error("应用正在退出，请重新打开后再分离。");
    if (queuePaused) throw new Error("任务队列已暂停，请先继续队列再开始分离。");
    if (separationBusy || active >= audioQueueLimit) throw new Error("当前处理任务较多，请等待后再分离。");
    const parent = jobs.get(String(req.params.id));
    const source = parent && jobFile(parent, legacyOutput);
    if (parent && deletingJobs.has(parent.id)) throw new Error("音频正在移除，请稍后重试。");
    if (parent?.status !== "completed" || !source || !existsSync(source) || !parent.checksum) throw new Error("原音频不可用，请先重新定位或导入。");
    const destination = existingDirectory(storage.outputDir);
    const controller = new AbortController();
    const requested = req.body?.kind;
    if (requested !== undefined && requested !== "vocals" && requested !== "instrumental") throw new Error("分离音轨类型无效。");
    const kinds: ("vocals" | "instrumental")[] = requested ? [requested] : ["vocals", "instrumental"];
    const stems = kinds.map(kind => {
      const suffix = kind === "vocals" ? "人声" : "伴奏";
      const metadata = { title: `${parent.title}（${suffix}）`, artist: parent.artist, album: parent.metadata?.album || "" };
      const job: Job = { id: randomUUID(), title: metadata.title, artist: metadata.artist, metadata, naming: organization.naming,
        platform: parent.platform, sourceId: parent.sourceId, completeness: parent.completeness, parentJobId: parent.id,
        kind, format: "wav", status: "processing", progress: 1, message: "正在本机分离人声与伴奏，可能需要几分钟。",
        createdAt: new Date().toISOString(), outputDir: destination };
      save(job); controllers.set(job.id, controller); return job;
    });
    separationBusy = true; active++;
    const scratch = path.join(temp, `separate-${randomUUID()}`);
    const task = (async () => {
      try {
        if (await checksum(source) !== parent.checksum) throw new Error("原文件内容已改变，请重新导入后分离。");
        const outputs = await separate(source, scratch, controller.signal);
        for (const job of stems) {
          controller.signal.throwIfAborted();
          const file = outputs[job.kind as "vocals" | "instrumental"];
          const info = await probe(file, controller.signal);
          if (!info.duration || info.size < 100 || (parent.duration && Math.abs(info.duration - parent.duration) > 1)) throw new Error("分离结果时长或音轨不完整。");
          const digest = await checksum(file);
          const saved = await publishAudio(file, destination, outputTitle(job.metadata!, job.naming!), job.id, "wav", controller.signal, undefined, true,
            candidate => prepareOutput(job.id, { ...candidate, checksum: digest, size: info.size, duration: info.duration }));
          patch(job, { status: "completed", message: "分离音轨已保存", progress: 100, ...saved, checksum: digest, size: info.size, duration: info.duration, completedAt: new Date().toISOString() });
        }
      } catch (error) {
        for (const job of stems) if (job.status !== "completed") {
          if (closing && controller.signal.aborted && job.status !== "cancelled") interruptedAudio(job);
          else patch(job, { status: controller.signal.aborted ? "cancelled" : "failed", message: controller.signal.aborted ? "分离已取消。" : readableError(error) });
        }
      } finally {
        await removeTemporary(scratch, true);
        for (const job of stems) controllers.delete(job.id);
      }
    })().catch(error => {
      for (const job of stems) failBackgroundAudio(job, error);
    }).finally(() => { separationBusy = false; active--; running.delete(task); drain(); });
    running.add(task);
    res.status(202).json({ jobs: stems.map(publicJob) });
  } catch (error) { next(error); }
});
app.post("/api/jobs/:id/cancel", (req, res) => {
  const j = jobs.get(String(req.params.id));
  if (!j) return res.status(404).json({ error: "任务不存在。" });
  if (["completed", "failed", "cancelled"].includes(j.status) && !j.interrupted)
    return res.json(publicJob(j));
  const c = controllers.get(j.id);
  if (c) {
    c.abort();
    for (const [id, controller] of controllers) {
      const task = jobs.get(id);
      if (controller === c && task && task.status !== "completed")
        patch(task, { status: "cancelled", interrupted: undefined, needsReview: undefined, message: "任务已取消" });
    }
  }
  else {
    const index = queue.findIndex(item => item.job.id === j.id);
    if (index >= 0) {
      const [item] = queue.splice(index, 1);
      void releaseUpload(item.plan);
    }
    patch(j, { status: "cancelled", interrupted: undefined, needsReview: undefined, message: "任务已取消" });
  }
  res.json({ ok: true });
});
app.get("/api/jobs/:id/file", (req, res) => {
  const j = jobs.get(String(req.params.id));
  const file = j && jobFile(j, legacyOutput);
  if (j?.status !== "completed" || !j.filename || !file || !existsSync(file))
    return res.status(404).json({ error: "文件不存在，请重新下载。" });
  res.download(file, j.filename);
});
app.get("/api/jobs/:id/audio", (req, res) => {
  const j = jobs.get(String(req.params.id));
  const file = j && jobFile(j, legacyOutput);
  if (j?.status !== "completed" || !file || !existsSync(file))
    return res.sendStatus(404);
  res.sendFile(file);
});

app.post("/api/jobs/:id/reveal", async (req, res, next) => {
  const j = jobs.get(String(req.params.id));
  const file = j && jobFile(j, legacyOutput);
  if (j?.status !== "completed" || !j.filename || !file || !existsSync(file))
    return res
      .status(404)
      .json({ error: "文件已移走或删除，请检查保存目录。" });
  try {
    if (parentPort) await desktopOpenPath("reveal", file);
    else if (process.platform === "darwin") await run("open", ["-R", file]);
    else if (process.platform === "win32")
      await run("explorer", ["/select,", file]);
    else await run("xdg-open", [path.dirname(file)]);
    res.json({ ok: true });
  } catch {
    next(new Error("未能打开文件夹，请在设置中查看保存位置。"));
  }
});
async function openFolder(directory: string) {
  if (!existsSync(directory))
    throw new Error("文件夹目前不可用，请连接磁盘或重新选择位置。");
  try {
    if (parentPort) return await desktopOpenPath("folder", directory);
    await run(
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open",
      [directory],
    );
  } catch {
    throw new Error("未能打开文件夹，请检查保存位置。");
  }
}
app.post("/api/jobs/:id/open-folder", async (req, res, next) => {
  const job = jobs.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: "任务不存在。" });
  try {
    await openFolder(job.outputDir || legacyOutput);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.use("/api", (_, res) => res.status(404).json({ error: "接口不存在。" }));
if (production) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*splat}", (_, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error.status === 409 ? 409 : 400).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "文件超过 500 MB，请选择较小的文件。"
          : readableError(error),
    });
  },
);
const port = Number(process.env.PORT || 4173);
const server = app.listen(port, "127.0.0.1", (error?: Error) => {
  if (error) {
    console.error(
      `启动未完成：端口 ${port} 可能已被占用。请打开已运行的页面或更换端口。`,
    );
    process.exit(1);
  }
  const actualPort = (server.address() as import("node:net").AddressInfo).port;
  console.log(`拾音已启动：http://127.0.0.1:${actualPort}`);
  parentPort?.postMessage({ type: "ready", port: actualPort });
  void clearStaleMedia(tempRoot);
  for (const platform of ["douyin", "qishui"] as const)
    if (accounts.state(platform).hasCredentials)
      void checkAccount(platform).catch(() => {});
});
async function shutdown() {
  if (closing) return;
  closing = true;
  completionTracker?.close();
  const separationStopped = cancelSeparationInstallation();
  const videoStopped = videoQueue.stop();
  clearInterval(qrTimer);
  bilibiliLogin.cancel();
  clearInterval(browserLoginTimer);
  for (const { job } of queue.splice(0)) {
    try { interruptedAudio(job); } catch (error) { failBackgroundAudio(job, error); }
  }
  batches.stopAll();
  for (const c of controllers.values()) c.abort();
  for (const c of playlistRequests) c.abort();
  for (const c of previewRequests) c.abort();
  await verification.close();
  await Promise.allSettled([qishuiLogin.suspend(), closeBrowser(), videoStopped, ...running, ...(separationStopped ? [separationStopped] : []), ...pendingDeletions]);
  server.close();
  server.closeAllConnections();
  await removeTemporary(temp, true);
  db.close();
  process.exit(0);
}
parentPort?.on("message", ({ data }) => {
  if (data?.type === "shutdown") void shutdown();
  if (data?.type === "status")
    parentPort!.postMessage({
      type: "status",
      id: data.id,
      busy:
        active > 0 ||
        running.size > 0 ||
        separationInstallationBusy() ||
        videoQueue.busy ||
        resolvingVideo.size > 0 ||
        pendingDeletions.size > 0 ||
        queue.length > 0 ||
        playlistRequests.size > 0 ||
        batches.pending,
      records: jobs.size + batches.size + videoQueue.tasks.size,
    });
});
server.on("error", (error: NodeJS.ErrnoException) => {
  parentPort?.postMessage({ type: "startup-error", code: error.code });
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
