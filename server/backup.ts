import path from "node:path";
import { lstat } from "node:fs/promises";
import { checksum } from "./storage.ts";
import { groupKey, validGroupName } from "./library-organize.ts";
import { clipRange, metadataOf } from "./library.ts";
import { validatePreset } from "./presets.ts";
import { presetExamples, type ExportPreset } from "../shared/preferences.ts";
import type { Job, VideoTask } from "../shared/types.ts";
import type { VideoRecord } from "./video-queue.ts";

export type RecordsBackup = {
  schema: "shiyin-records";
  version: 1;
  createdAt: string;
  audio: Job[];
  video: VideoRecord[];
  groups: string[];
  presets: ExportPreset[];
};
const recordId = /^[a-z0-9_-]{1,128}$/i;
const audioFiles = /\.(mp3|m4a|wav|flac|aac|opus|ogg|aiff?)$/i;
const videoFiles = /\.mp4$/i;
function invalid(): never { throw new Error("备份内容损坏或版本不受支持。"); }
function text(value: unknown, limit = 4096) {
  return typeof value === "string" && value.length <= limit && !value.includes("\0") ? value : undefined;
}
function id(value: unknown) { return typeof value === "string" && recordId.test(value) ? value : invalid(); }
function date(value: unknown) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}
function count(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function storedPath(value: unknown) {
  const filename = text(value);
  return filename && path.isAbsolute(filename) ? filename : undefined;
}
function hash(value: unknown) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }
function unique<T>(values: T[], key: (item: T) => string) {
  if (new Set(values.map(key)).size !== values.length) invalid();
  return values;
}
function source(value: unknown) {
  const input = text(value);
  if (!input) return "";
  try {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !/(^|\.)(douyin\.com|iesdouyin\.com|bilibili\.com|b23\.tv)$/.test(url.hostname)) return "";
    for (const key of [...url.searchParams.keys()]) if (key !== "p" && key !== "modal_id") url.searchParams.delete(key);
    url.hash = "";
    return url.href;
  } catch { return ""; }
}
function audioRecord(entry: Job): Job {
  if (!entry || !["local", "douyin", "bilibili", "qishui"].includes(entry.platform) ||
    !["queued", "downloading", "processing", "checking", "failed", "cancelled", "completed"].includes(entry.status) ||
    (entry.format !== undefined && !["mp3", "m4a", "original", "wav", "flac"].includes(entry.format))) return invalid();
  const interrupted = entry.interrupted === true || !["failed", "cancelled", "completed"].includes(entry.status);
  const filename = text(entry.filename, 300);
  const filePath = storedPath(entry.filePath);
  const outputDir = storedPath(entry.outputDir);
  const duration = count(entry.duration);
  return {
    id: id(entry.id), title: text(entry.title) || "音频任务", artist: text(entry.artist) || "", platform: entry.platform,
    format: entry.format || "original", sourceId: text(entry.sourceId, 128), createdAt: date(entry.createdAt) || new Date(0).toISOString(),
    completedAt: date(entry.completedAt), message: interrupted ? "此任务在备份时尚未完成。" : text(entry.message) || "",
    status: interrupted ? "failed" : entry.status, progress: interrupted ? 0 : count(entry.progress) || 0,
    interrupted: interrupted || undefined, needsReview: interrupted && entry.needsReview === true || undefined,
    completeness: entry.completeness === "full" || entry.completeness === "preview" ? entry.completeness : "unknown",
    filename: filename && path.basename(filename) === filename && audioFiles.test(filename) ? filename : undefined,
    filePath: filePath && audioFiles.test(filePath) ? filePath : undefined,
    checksum: hash(entry.checksum), outputDir, duration, size: count(entry.size),
    detached: entry.status === "completed" || undefined,
    favorite: entry.favorite === true, groups: Array.isArray(entry.groups) ? entry.groups.slice(0, 200).map(validGroupName) : undefined,
    metadata: entry.metadata ? metadataOf(entry.metadata, { title: entry.title, artist: entry.artist, album: "" }) : undefined,
    embedCover: typeof entry.embedCover === "boolean" ? entry.embedCover : undefined,
    naming: ["title", "title-artist", "artist-title"].includes(entry.naming || "") ? entry.naming : undefined,
    selection: entry.selection ? { quality: text(entry.selection.quality, 128), format: text(entry.selection.format, 128), bitrate: count(entry.selection.bitrate) } : undefined,
    parentJobId: entry.parentJobId ? id(entry.parentJobId) : undefined,
    kind: ["clip", "organized", "instrumental", "vocals", "normalized"].includes(entry.kind || "") ? entry.kind : undefined,
    clip: entry.clip && count(entry.clip.end) ? clipRange(entry.clip, entry.clip.end) : undefined,
  };
}
function videoRecord(entry: VideoRecord): VideoRecord {
  const task = entry?.task;
  if (!task || !["queued", "working", "failed", "cancelled", "completed"].includes(task.status)) return invalid();
  const interrupted = task.interrupted === true || task.status === "working" || task.status === "queued";
  const filePath = storedPath(task.filePath);
  return {
    input: source(entry.input), outputDir: storedPath(entry.outputDir) || (filePath ? path.dirname(filePath) : ""),
    task: {
      id: id(task.id), title: text(task.title), artist: text(task.artist), platform: task.platform === "douyin" || task.platform === "bilibili" ? task.platform : undefined,
      sourceId: text(task.sourceId, 128), duration: count(task.duration), height: count(task.height),
      createdAt: date(task.createdAt), message: interrupted ? "此视频在备份时尚未完成。" : text(task.message) || "",
      status: interrupted ? "failed" : task.status, progress: interrupted ? undefined : count(task.progress),
      interrupted: interrupted || undefined, needsReview: interrupted && task.needsReview === true || undefined,
      detached: task.status === "completed" || undefined,
      filePath: filePath && videoFiles.test(filePath) ? filePath : undefined, checksum: hash(task.checksum),
      videoAudioMode: task.videoAudioMode === "audio-only" || task.videoAudioMode === "combined" ? task.videoAudioMode : undefined,
    },
  };
}
export function readBackup(value: unknown): RecordsBackup {
  const input = value as RecordsBackup | undefined;
  const createdAt = date(input?.createdAt);
  if (!createdAt || input?.schema !== "shiyin-records" || input.version !== 1 ||
    !Array.isArray(input.audio) || input.audio.length > 25000 || !Array.isArray(input.video) || input.video.length > 25000 ||
    !Array.isArray(input.groups) || input.groups.length > 5000 || !Array.isArray(input.presets) || input.presets.length > 100) return invalid();
  const audio = unique(input.audio.map(audioRecord), job => job.id);
  const video = unique(input.video.map(videoRecord), record => record.task.id);
  const groups = unique(input.groups.map(validGroupName), groupKey);
  const presets = unique(input.presets.map(item => validatePreset(item, id(item?.id))), item => item.id);
  unique([...presets, ...presetExamples], item => item.label.toLocaleLowerCase());
  return { schema: "shiyin-records", version: 1, createdAt, audio, video, groups, presets };
}
export async function checkedMediaFile(file: string | undefined, fingerprint: string | undefined, kind: "audio" | "video", size?: number) {
  if (!file || !fingerprint || !(kind === "audio" ? audioFiles : videoFiles).test(file)) return false;
  try {
    const info = await lstat(file);
    return info.isFile() && (size === undefined || info.size === size) && await checksum(file) === fingerprint;
  } catch { return false; }
}
export async function associateBackupFiles(backup: RecordsBackup, legacyOutput: string) {
  for (const job of backup.audio) {
    if (job.status !== "completed") continue;
    const file = job.filePath || (job.filename && path.join(job.outputDir || legacyOutput, job.filename));
    if (await checkedMediaFile(file, job.checksum, "audio", job.size)) {
      job.filePath = file;
      job.outputDir = path.dirname(file!);
      job.detached = undefined;
    }
  }
  for (const {task} of backup.video) {
    if (task.status === "completed" && await checkedMediaFile(task.filePath, task.checksum, "video")) task.detached = undefined;
  }
}
