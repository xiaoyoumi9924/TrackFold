import type {
  AudioMetadata,
  ClipRange,
  Job,
  LibrarySettings,
  Resource,
} from "../shared/types.ts";

import { actualExtension } from "../shared/preferences.ts";
import { fileFormat } from "../shared/library-filters.ts";

export const libraryDefaults: LibrarySettings = {
  naming: "artist-title",
  embedCover: true,
};
export function metadataOf(value: any, fallback: AudioMetadata): AudioMetadata {
  const field = (key: keyof AudioMetadata, max: number) => {
    const text =
      value?.[key] ??
      String(fallback[key] || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, max);
    if (
      typeof text !== "string" ||
      text.length > max ||
      /[\u0000-\u001f\u007f]/.test(text)
    )
      throw new Error("歌曲信息格式无效，请使用单行文字。");
    return text.trim();
  };
  const result = {
    title: field("title", 300),
    artist: field("artist", 300),
    album: field("album", 300),
  };
  if (!result.title) throw new Error("请填写歌曲标题。");
  return result;
}
export function librarySettings(value: any): LibrarySettings {
  if (
    !value ||
    !["artist-title", "title-artist", "title"].includes(value.naming) ||
    typeof value.embedCover !== "boolean"
  )
    throw new Error("歌曲整理选项无效。");
  return { naming: value.naming, embedCover: value.embedCover };
}
export { outputTitle } from "../shared/preferences.ts";
export function clipRange(value: any, duration: number): ClipRange {
  if (
    !value ||
    !["start", "end", "fadeIn", "fadeOut"].every(
      (k) => typeof value[k] === "number" && Number.isFinite(value[k]),
    )
  )
    throw new Error("请填写有效的截取时间和淡入淡出时长。");
  const { start, end, fadeIn, fadeOut } = value;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    start < 0 ||
    end > duration + 0.001 ||
    end - start < 0.1
  )
    throw new Error("截取范围须在音频内，且至少保留 0.1 秒。");
  if (fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > end - start)
    throw new Error("淡入和淡出的总时长不能超过所选片段。");
  return { start, end: Math.min(end, duration), fadeIn, fadeOut };
}
export function sameSource(
  job: Job,
  resource: Resource,
  format: string,
  selection: Job["selection"],
) {
  return (
    job.platform === resource.platform &&
    job.sourceId === resource.sourceId &&
    !job.clip &&
    !job.parentJobId &&
    job.completeness === resource.completeness &&
    job.format === format &&
    JSON.stringify(job.selection) === JSON.stringify(selection)
  );
}
export function findSaved(
  jobs: Iterable<Job>,
  resource: Resource,
  format: string,
  selection: Job["selection"],
  exists: (job: Job) => boolean,
) {
  const localOriginal = format === "original" && resource.platform === "local" && selection?.format;
  return [...jobs]
    .reverse()
    .find(
      (job) =>
        job.status === "completed" &&
        sameSource(job, resource, format, selection) &&
        (!localOriginal || fileFormat(job) === actualExtension("original", localOriginal)) &&
        exists(job),
    );
}
