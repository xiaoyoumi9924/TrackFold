import { open, stat, unlink, mkdtemp, mkdir, copyFile, writeFile, rename, rm, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Job } from "../shared/types.ts";
import { checksum, existingDirectory, jobFile } from "./storage.ts";

const label = (value: unknown) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();

export async function exportLibrary(
  ids: unknown, format: unknown, jobs: Map<string, Job>, outputDir: string, legacyOutput: string,
) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length)
    throw new Error("请选择至少一条音频，且选择不得重复。");
  if (format !== "m3u8" && format !== "txt" && format !== "bundle") throw new Error("导出格式无效。");
  const entries: { job: Job; file: string }[] = [];
  for (const id of ids) {
    const job = jobs.get(id);
    const file = job && jobFile(job, legacyOutput);
    if (!job || job.status !== "completed" || !file || !path.isAbsolute(file))
      throw new Error("所选音频中有记录不可用，请刷新后重新选择。");
    if (/[\u0000\r\n]/.test(file)) throw new Error("所选文件路径包含换行字符，无法导出，请先重新命名或定位文件。");
    try { if (!(await stat(file)).isFile()) throw new Error(); }
    catch { throw new Error(`文件不可用：${label(job.title) || "未命名音频"}。请先重新定位或取消选择。`); }
    entries.push({ job, file });
  }
  const directory = existingDirectory(outputDir);
  if (format === "bundle") return exportBundle(entries, directory);
  const content = format === "m3u8"
    ? ["#EXTM3U", ...entries.flatMap(({job,file}) => [
        `#EXTINF:${Number.isFinite(job.duration) && job.duration! > 0 ? Math.floor(job.duration!) : -1},${label(job.artist) ? label(job.artist) + " - " : ""}${label(job.title) || "未命名音频"}`,
        file,
      ])].join("\n") + "\n"
    : ["拾音歌曲清单", ...entries.map(({job,file}, i) => `${i + 1}. ${label(job.artist) ? label(job.artist) + " - " : ""}${label(job.title) || "未命名音频"}  (${label(path.basename(file))})`)].join("\n") + "\n";
  for (let attempt = 0; attempt < 100; attempt++) {
    const filename = `拾音${format === "m3u8" ? "播放列表" : "歌曲清单"}${attempt ? ` (${attempt + 1})` : ""}.${format}`;
    const filePath = path.join(directory, filename);
    let handle;
    try { handle = await open(filePath, "wx", 0o600); }
    catch (e: any) { if (e.code === "EEXIST") continue; throw new Error("无法在保存目录创建文件，请检查文件夹权限。"); }
    try { await handle.writeFile(content, "utf8"); await handle.close(); }
    catch { await handle.close().catch(() => {}); await unlink(filePath).catch(() => {}); throw new Error("导出失败，请检查保存目录和磁盘空间。"); }
    return { filename, filePath, count: entries.length };
  }
  throw new Error("同名文件过多，请整理保存目录后重试。");
}

// Bundle into a private staging folder, then publish it without overwriting an existing folder.
async function exportBundle(entries: {job: Job; file: string}[], directory: string) {
  const stage = await mkdtemp(path.join(directory, ".拾音导出-"));
  let reserved = "";
  try {
    const playlist: string[] = ["#EXTM3U"];
    for (const {job, file} of entries) {
      const parsed = path.parse(path.basename(file));
      const extension = parsed.ext.replace(/[^.a-zA-Z0-9]/g, "").slice(0, 16);
      const clean = parsed.name.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/, "") || "音频";
      let base = "";
      for (const character of clean) { if (Buffer.byteLength(base + character) > 180) break; base += character; }
      let filename = "";
      for (let n = 0; n < 1000; n++) {
        filename = `${base}${n ? ` (${n + 1})` : ""}${extension}`;
        try { await copyFile(file, path.join(stage, filename), constants.COPYFILE_EXCL); break; }
        catch (e: any) { if (e.code === "EEXIST") { filename = ""; continue; } throw e; }
      }
      if (!filename) throw new Error("同名音频过多，无法生成分享文件夹。");
      const copied = path.join(stage, filename);
      const expected = job.checksum || await checksum(file);
      if (await checksum(copied) !== expected) throw new Error(`音频内容已改变或复制不完整：${label(job.title)}。请重新定位或导入后再试。`);
      playlist.push(`#EXTINF:${Number.isFinite(job.duration) && job.duration! > 0 ? Math.floor(job.duration!) : -1},${label(job.artist) ? label(job.artist) + " - " : ""}${label(job.title) || "未命名音频"}`, `./${filename}`);
    }
    await writeFile(path.join(stage, "播放列表.m3u8"), playlist.join("\n") + "\n", {flag:"wx", mode:0o600});
    for (let n=0; n<100; n++) {
      const filename = `拾音分享${n ? ` (${n + 1})` : ""}`;
      const target = path.join(directory, filename);
      try { await mkdir(target, {mode:0o700}); reserved = target; }
      catch (e: any) { if(e.code === "EEXIST") continue; throw e; }
      await rename(stage, target);
      reserved = "";
      return {filename, filePath:target, count:entries.length};
    }
    throw new Error("同名文件夹过多，请整理保存目录后重试。");
  } catch (error: any) {
    if (reserved) await rmdir(reserved).catch(() => {});
    if (["ENOSPC", "EACCES", "EPERM", "EROFS"].includes(error?.code)) throw new Error("无法导出分享文件夹，请检查磁盘空间和保存位置权限。");
    throw error;
  } finally { await rm(stage, {recursive:true, force:true}); }
}
