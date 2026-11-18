import { reactive } from "vue";
import { hasExplicitOutputFormat, savedOutputFormat } from "./default-format";
import type {
  AudioMetadata,
  Job,
  LibrarySettings,
  Resource,
} from "../shared/types";

export interface LocalItem {
  id: string;
  file: File;
  selected: boolean;
  phase: "waiting" | "reading" | "ready" | "error" | "submitted";
  error: string;
  resource?: Resource;
  metadata?: AudioMetadata;
  jobId?: string;
  reused?: boolean;
}
// Kept for this window so switching pages doesn't drop selected files or restart work.
export const localBatch = reactive({
  items: [] as LocalItem[],
  busy: "",
  stop: false,
  message: "",
  error: "",
  format: "mp3",
  forceCopy: false,
  outputDir: "",
  preferencesLoaded: false,
  organization: { naming: "artist-title", embedCover: true } as LibrarySettings,
});
async function json(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作未完成，请重试。");
  return data;
}
export async function discardLocal(item: LocalItem) {
  if (!item.resource || item.phase === "submitted") return;
  await json(`/api/uploads/${item.resource.token}`, { method: "DELETE" });
  item.resource = undefined;
}
export async function readLocal(item: LocalItem) {
  item.error = "";
  if (item.resource && item.phase !== "submitted")
    await discardLocal(item).catch(() => {});
  item.resource = undefined;
  item.phase = "reading";
  try {
    const form = new FormData();
    form.append("file", item.file);
    item.resource = await json("/api/upload", { method: "POST", body: form });
    const resource = item.resource!;
    item.metadata ||= {
      title: resource.title
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 300),
      artist:
        resource.artist === "本地文件"
          ? ""
          : resource.artist
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .slice(0, 300),
      album: resource.album || "",
    };
    item.phase = "ready";
  } catch (e) {
    item.phase = "error";
    item.error = (e as Error).message;
  }
}
export async function readPending(items: LocalItem[]) {
  localBatch.busy = "reading";
  localBatch.stop = false;
  try {
    for (const item of items) {
      if (localBatch.stop) break;
      if (item.file.size > 500 * 1024 * 1024) {
        item.phase = "error";
        item.error = "文件超过 500 MB，请选择较小的文件。";
        continue;
      }
      await readLocal(item);
    }
    if (localBatch.stop)
      localBatch.message = "已停止后续读取，已读好的文件可继续保存。";
  } finally {
    localBatch.busy = "";
  }
}
export async function addLocalFiles(files: File[]) {
  if (localBatch.busy || !files.length) return;
  localBatch.error = "";
  localBatch.message = "";
  if (localBatch.items.length + files.length > 20) {
    localBatch.error = "每批最多 20 个文件，请先清空或移除部分条目。";
    return;
  }
  const total = [...localBatch.items.map((i) => i.file), ...files].reduce(
    (n, f) => n + f.size,
    0,
  );
  if (total > 2 * 1024 ** 3) {
    localBatch.error = "本批文件合计不能超过 2 GB，请分批导入。";
    return;
  }
  if (!localBatch.items.length && hasExplicitOutputFormat()) localBatch.format = savedOutputFormat();
  for (const file of files)
    localBatch.items.push({
      id: crypto.randomUUID(),
      file,
      selected: true,
      phase: "waiting",
      error: "",
    });
  await readPending(localBatch.items.filter((i) => i.phase === "waiting"));
}
export async function submitLocal(retryFailed = false, jobs: Job[] = []) {
  if (localBatch.busy) return;
  const items = localBatch.items.filter((item) =>
    retryFailed
      ? item.phase === "error" ||
        (item.jobId &&
          jobs.some(
            (job) =>
              job.id === item.jobId &&
              ["failed", "cancelled"].includes(job.status),
          ))
      : item.selected && item.phase === "ready",
  );
  if (!items.length) return;
  localBatch.busy = "saving";
  localBatch.stop = false;
  localBatch.error = "";
  localBatch.message = "";
  // One run uses one settings snapshot, including its destination.
  const options = {
    format: localBatch.format,
    forceCopy: localBatch.forceCopy,
    outputDir: localBatch.outputDir,
    organization: { ...localBatch.organization },
  };
  let added = 0,
    reused = 0,
    failed = 0;
  try {
    for (const item of items) {
      if (localBatch.stop) break;
      if (item.phase !== "ready") await readLocal(item);
      if (!item.resource || item.phase !== "ready") {
        failed++;
        continue;
      }
      try {
        const job: Job & { reused?: boolean } = await json("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...options,
            reuseActive: true,
            token: item.resource.token,
            choice: "original",
            metadata: item.metadata,
          }),
        });
        item.phase = "submitted";
        item.jobId = job.id;
        item.reused = job.reused === true || job.status === "completed";
        item.selected = false;
        item.error = "";
        if (item.reused) reused++;
        else added++;
      } catch (e) {
        const message = (e as Error).message;
        // A matching active job can own the same uploaded token; leave cleanup to that job.
        item.phase = "error";
        item.error = message;
        failed++;
      }
    }
    localBatch.message = `已加入 ${added} 条任务，复用 ${reused} 个已有任务或文件${failed ? `，${failed} 条未加入` : ""}。${localBatch.stop ? "已停止后续提交；已加入任务继续处理。" : ""}`;
  } catch (cause) {
    localBatch.error = (cause as Error).message;
  } finally {
    localBatch.busy = "";
  }
}
