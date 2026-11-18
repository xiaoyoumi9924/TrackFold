import type { Job, Platform } from "./types.ts";

export interface LibraryFilters {
  query: string;
  kind: "all" | "full" | "preview" | "clip" | "unknown" | "stem" | "normalized";
  platform: "all" | Platform;
  file: "all" | "available" | "missing";
  format: "all" | "mp3" | "m4a" | "flac" | "wav";
  favoriteOnly: boolean;
  group: string;
  sort: "newest" | "oldest" | "title" | "artist";
}
export const emptyLibraryFilters: LibraryFilters = {
  query: "",
  kind: "all",
  platform: "all",
  file: "all",
  format: "all",
  favoriteOnly: false,
  group: "",
  sort: "newest",
};
export function audioKind(job: Job) {
  if (job.kind === "normalized") return "normalized";
  if (job.kind === "vocals" || job.kind === "instrumental") return "stem";
  if (job.clip || job.kind === "clip") return "clip";
  return job.completeness;
}
export function fileFormat(job: Job) {
  return (
    job.filename?.split(".").pop()?.toLowerCase() ||
    (job.format === "original" ? "" : job.format)
  );
}
export function filterLibrary(jobs: Job[], filters: LibraryFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  const result = jobs.filter(
    (job) =>
      job.status === "completed" &&
      (!query ||
        `${job.title} ${job.artist} ${job.metadata?.album || ""} ${job.filename || ""}`
          .toLocaleLowerCase()
          .includes(query)) &&
      (filters.kind === "all" || audioKind(job) === filters.kind) &&
      (filters.platform === "all" || job.platform === filters.platform) &&
      (filters.file === "all" ||
        (filters.file === "missing"
          ? job.fileExists === false
          : job.fileExists === true)) &&
      (filters.format === "all" || fileFormat(job) === filters.format) &&
      (!filters.favoriteOnly || job.favorite === true) &&
      (!filters.group || (job.groups || []).some(group => group.normalize("NFC").toLocaleLowerCase("zh-CN") === filters.group.normalize("NFC").toLocaleLowerCase("zh-CN"))),
  );
  return result.sort((a, b) => {
    if (filters.sort === "title" || filters.sort === "artist")
      return (
        a[filters.sort].localeCompare(b[filters.sort], "zh-CN", {
          numeric: true,
        }) || a.id.localeCompare(b.id)
      );
    const order =
      (Date.parse(b.completedAt || b.createdAt) || 0) -
      (Date.parse(a.completedAt || a.createdAt) || 0);
    return (
      (filters.sort === "oldest" ? -order : order) || a.id.localeCompare(b.id)
    );
  });
}
