import type { Job } from "./types.ts";

// Only clearly temporary transport failures qualify; cancelled or ambiguous failures need review.
export function canBatchRetry(job: Job) {
  return job.status === "failed" && !job.interrupted && job.failureKind === "network" &&
    job.platform !== "local" &&
    !!job.sourceId && !!(job.selection?.quality || job.selection?.format) && !job.parentJobId;
}
export function retryReason(job: Job) {
  if (job.interrupted) return "可在「继续上次」中查看恢复方式";
  if (job.parentJobId) return "编辑或分离任务需从原音频处理";
  if (job.platform === "local") return "本地文件需重新选择";
  if (canBatchRetry(job)) return "网络异常，可批量重试";
  return "需查看原因后处理";
}
export function isNetworkFailure(error: unknown) {
  const err = error as {name?:string; message?:string; code?:string; status?:number; cause?:{code?:string}} | null;
  if (!err) return false;
  return ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].some(code => code === err.code || code === err.cause?.code) ||
    [408, 502, 503, 504].includes(err.status || 0) ||
    err.name === "TimeoutError" || /\b(fetch failed|network timeout|connection reset|timed out)\b/i.test(err.message || "");
}
