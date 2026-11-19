import { titlePart } from "../shared/preferences.ts";
import {
  constants,
  existsSync,
  accessSync,
  statSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { open, copyFile, link, unlink, stat, lstat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { Job, StorageKind, StorageSettings } from "../shared/types.ts";
import { nativePicker } from "./native-picker.ts";

export function existingDirectory(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error("请选择保存文件夹，或填写完整路径。");
  const expanded = value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
  if (!path.isAbsolute(expanded))
    throw new Error("请填写保存文件夹的完整路径。");
  try {
    const directory = realpathSync(expanded);
    if (!statSync(directory).isDirectory()) throw new Error("所选路径不是文件夹。");
    accessSync(directory, constants.W_OK | constants.X_OK);
    return directory;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (!code) throw cause;
    throw new Error(directoryProblem(code));
  }
}

function directoryProblem(code?: string) {
  if (code === "ENOENT" || code === "ENODEV" || code === "ENXIO") return "文件夹已移走或磁盘未连接。";
  if (code === "ENOTDIR") return "所选路径不是文件夹。";
  if (code === "ENOSPC" || code === "EDQUOT") return "磁盘空间不足。";
  if (code === "EROFS") return "磁盘为只读。";
  if (code === "EACCES" || code === "EPERM") return "拾音没有权限写入此文件夹。";
  return "无法访问此文件夹，请检查磁盘连接和权限。";
}

export class OutputStorage {
  private current: Record<StorageKind, string>;
  private defaultVideoOutputDir: string;
  private configFile: string;
  constructor(
    dataDirectory: string,
    readonly defaultOutputDir: string,
  ) {
    this.configFile = path.join(dataDirectory, "storage.json");
    let audio = defaultOutputDir;
    let video: string | undefined;
    if (existsSync(this.configFile)) {
      const stored = JSON.parse(readFileSync(this.configFile, "utf8"));
      if (
        stored.version !== 1 ||
        typeof stored.outputDir !== "string" ||
        !path.isAbsolute(stored.outputDir) ||
        (stored.videoOutputDir !== undefined &&
          (typeof stored.videoOutputDir !== "string" || !path.isAbsolute(stored.videoOutputDir)))
      )
        throw new Error("保存位置设置损坏，请检查本机 storage.json。");
      audio = stored.outputDir;
      video = stored.videoOutputDir;
    }
    const videoFolder = path.join(defaultOutputDir, "视频");
    this.defaultVideoOutputDir = audio === videoFolder ? path.join(defaultOutputDir, "视频提取") : videoFolder;
    this.current = { audio, video: video ?? this.defaultVideoOutputDir };
  }
  get outputDir() {
    return this.current.audio;
  }
  private defaultDirectory(kind: StorageKind) {
    return kind === "video" ? this.defaultVideoOutputDir : this.defaultOutputDir;
  }
  directory(kind: StorageKind) {
    const directory = this.current[kind];
    if (kind === "video" && directory === this.defaultVideoOutputDir && !existsSync(directory))
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    return existingDirectory(directory);
  }
  describe(kind: StorageKind = "audio"): StorageSettings {
    let available = true;
    try { this.directory(kind); } catch { available = false; }
    return {
      outputDir: this.current[kind], defaultOutputDir: this.defaultDirectory(kind), available,
      nativePicker,
      message: available ? "新建任务将保存到这里。" : "保存文件夹目前不可用，请连接磁盘或重新选择位置。",
    };
  }
  async update(value: unknown, kind: StorageKind = "audio") {
    if (kind === "video" && value === this.defaultVideoOutputDir && !existsSync(value))
      mkdirSync(value, { recursive: true, mode: 0o700 });
    const directory = existingDirectory(value);
    // Verify actual file creation, beyond permission bits (e.g. external disks).
    const probe = path.join(directory, `.shiyin-check-${randomUUID()}`);
    let file;
    try {
      file = await open(probe, "wx", 0o600);
    } catch {
      throw new Error("无法在该文件夹保存文件，请选择可写的位置。");
    } finally {
      if (file) {
        await file.close();
        await unlink(probe);
      }
    }
    const other = this.current[kind === "audio" ? "video" : "audio"];
    const otherPath = existsSync(other) ? realpathSync(other) : other;
    if (directory === otherPath) throw new Error("音频和视频请选择不同的保存文件夹。");
    const next = { ...this.current, [kind]: directory };
    const pending = this.configFile + ".pending";
    writeFileSync(
      pending,
      JSON.stringify({ version: 1, outputDir: next.audio, videoOutputDir: next.video }),
      { mode: 0o600 },
    );
    renameSync(pending, this.configFile);
    this.current = next;
    return this.describe(kind);
  }
}

export function jobFile(job: Job, legacyDirectory: string) {
  if (job.detached) return;
  if (job.filePath) return job.filePath;
  return job.filename
    ? path.join(job.outputDir || legacyDirectory, job.filename)
    : undefined;
}
export async function checksum(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function matchingFile(job: Job, value: unknown) {
  if (job.status !== "completed") throw new Error("该任务尚未完成，不能重新关联文件。");
  if (!job.checksum)
    throw new Error("此旧任务没有文件核对记录，无法重新关联；请将原音频作为本地文件重新导入。");
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0")
  )
    throw new Error("请选择原来的音频文件，或填写文件的完整路径。");
  let file: string;
  try {
    file = realpathSync(value);
    const info = await stat(file);
    if (!info.isFile() || info.size !== job.size)
      throw new Error("size mismatch");
  } catch {
    throw new Error(
      "文件不存在，或大小与原音频不一致。请选择这条任务原来的文件。",
    );
  }
  let fingerprint;
  try {
    fingerprint = await checksum(file);
  } catch {
    throw new Error("暂时无法读取该文件，请检查权限或磁盘连接。");
  }
  if (fingerprint !== job.checksum)
    throw new Error("文件内容与原音频不一致，未更改任务关联。");
  return file;
}

export interface PublishedCandidate {
  filename: string;
  filePath: string;
  checksum: string;
  size?: number;
  duration?: number;
}

export async function publishAudio(
  staged: string,
  directory: string,
  title: string,
  id: string,
  extension: string,
  signal?: AbortSignal,
  linkFile: typeof link = link,
  readableName = false,
  beforePublish?: (file: { filename: string; filePath: string }) => void,
) {
  if (!["mp3", "m4a", "flac", "wav", "opus", "ogg", "mp4"].includes(extension))
    throw new Error("输出格式无效。");
  existingDirectory(directory);
  const hidden = path.join(directory, `.shiyin-${randomUUID()}.part`);
  try {
    await copyFile(staged, hidden, constants.COPYFILE_EXCL);
    for (let attempt = 0; attempt < 100; attempt++) {
      signal?.throwIfAborted();
      const filename = `${titlePart(title)}${readableName ? "" : `-${id.slice(0, 8)}`}${attempt ? ` (${attempt + 1})` : ""}.${extension}`;
      const target = path.join(directory, filename);
      if (beforePublish) {
        try { await lstat(target); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        signal?.throwIfAborted();
        beforePublish({ filename, filePath: target });
      }
      try {
        await linkFile(hidden, target);
        return { filename, filePath: target };
      } catch (e: any) {
        if (e.code === "EEXIST") continue;
        if (
          !["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS"].includes(
            e.code,
          )
        )
          throw e;
        // Some external-disk filesystems do not support hard links.
        let destination;
        try {
          destination = await open(target, "wx", 0o600);
        } catch (err: any) {
          if (err.code === "EEXIST") continue;
          throw err;
        }
        const identity = await destination.stat();
        try {
          await pipeline(
            createReadStream(hidden),
            createWriteStream(target, { fd: destination.fd, autoClose: false }),
            { signal },
          );
          const final = await stat(target);
          if (final.ino !== identity.ino || final.dev !== identity.dev)
            throw new Error("保存期间文件位置发生变化，请重试。");
          await destination.close();
          return { filename, filePath: target };
        } catch (err) {
          await destination.close().catch(() => {});
          const current = await stat(target).catch(() => null);
          if (current?.ino === identity.ino && current?.dev === identity.dev)
            await unlink(target).catch(() => {});
          throw err;
        }
      }
    }
    throw new Error("同名文件过多，请修改标题或选择其他保存位置。");
  } finally {
    await unlink(hidden).catch(() => {});
  }
}
