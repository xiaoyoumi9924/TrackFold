import { unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaChoice, VideoMetadata, VideoTask } from "../shared/types.ts";
import { isNetworkFailure } from "../shared/retry-policy.ts";
import { download, run } from "./media.ts";
import { extractLink, platformFetch, resolveDouyin, type Plan } from "./providers.ts";
import { checksum, existingDirectory, publishAudio, type PublishedCandidate } from "./storage.ts";

export interface VideoPlan {
  metadata: VideoMetadata;
  videoUrls: string[];
  audioUrls: string[];
  headers: Record<string, string>;
  audioPlan?: Plan;
}
const biliHeaders = { Referer: "https://www.bilibili.com/", "User-Agent": "Mozilla/5.0" };

function positiveDuration(value: unknown) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}
function coverUrl(value: unknown) {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value.startsWith("//") ? "https:" + value : value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port &&
      /(^|\.)(hdslb\.com|byteimg\.com|douyinpic\.com|ibytedtos\.com|pstatp\.com|bdxiguaimg\.com|douyin\.com|bytecdn\.cn|bytecdn\.com)$/.test(url.hostname)) {
      url.protocol = "https:";
      return url.href;
    }
  } catch { /* The renderer uses a fallback when there is no cover. */ }
}

async function biliJson(url: string, cookie: string) {
  const response = await platformFetch(url, { headers: cookie ? { ...biliHeaders, Cookie: cookie } : biliHeaders });
  const data = await response.json();
  if (data.code !== 0)
    throw Object.assign(new Error(`B 站未提供视频（${data.message || data.code}），可能需要登录或没有观看权限。`), { needsReview: true });
  return data.data;
}

export function isBilibiliLink(url: URL) {
  return url.hostname === "b23.tv" || /(^|\.)bilibili\.com$/.test(url.hostname);
}

type BilibiliStream = { id?: number; height?: number; codecs?: string; bandwidth?: number; baseUrl?: string; base_url?: string; url?: string; backupUrl?: string[]; backup_url?: string[] };
function streamUrls(stream?: BilibiliStream) {
  const primary = stream?.baseUrl || stream?.base_url || stream?.url;
  return primary ? [primary, ...(stream?.backupUrl || stream?.backup_url || [])] : [];
}

async function resolveBilibili(url: URL, audioOnly = false, expectedCid?: string, cookie = ""): Promise<VideoPlan> {
  let final = url;
  if (url.hostname === "b23.tv" || !/^\/video\/BV/i.test(url.pathname)) {
    const response = await platformFetch(url.href, { headers: biliHeaders });
    final = new URL(response.url);
    await response.body?.cancel();
    const requestedPage = url.searchParams.get("p");
    if (requestedPage && !final.searchParams.has("p")) final.searchParams.set("p", requestedPage);
  }
  const bvid = /(^|\.)bilibili\.com$/.test(final.hostname)
    ? final.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)\/?$/i)?.[1]
    : undefined;
  if (!bvid) throw new Error("请检查链接，当前支持 B 站普通视频。");

  const info = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, cookie);
  const page = Number(final.searchParams.get("p") || 1);
  const parts = Array.isArray(info?.pages) ? info.pages : [];
  const index = expectedCid ? parts.findIndex((part: { cid: unknown }) => String(part.cid) === expectedCid) : page - 1;
  const part = Number.isInteger(index) && index >= 0 ? parts[index] : undefined;
  if (!part || !/^\d+$/.test(String(part.cid))) throw new Error("没有找到指定分 P，请重新确认来源。");

  const data = await biliJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${part.cid}&qn=80&fnval=16&fourk=1`, cookie);
  const videos: BilibiliStream[] = (data?.dash?.video || []).filter((stream: BilibiliStream) => streamUrls(stream).length);
  const audios: BilibiliStream[] = (data?.dash?.audio || []).filter((stream: BilibiliStream) => streamUrls(stream).length);
  videos.sort((a, b) => (b.id || 0) - (a.id || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const combined = data?.durl?.length === 1 ? data.durl[0] as BilibiliStream : undefined;
  if ((!audioOnly || !audios.length) && !videos.length && !combined && data?.durl?.length > 1)
    throw new Error("该视频为多段格式，当前暂不支持。");
  const videoUrls = streamUrls(videos[0] || combined);
  if (!audioOnly && !videoUrls.length) throw new Error("平台没有返回可用的视频。");
  if (!audioOnly && videos.length && !audios.length) throw new Error("未取得视频音轨，请稍后重试。");
  if (audioOnly && !audios.length && !streamUrls(combined).length) throw new Error("平台没有返回可提取的音轨。");

  const title = parts.length > 1 ? `${info.title} P${index + 1} ${part.part || ""}`.trim() : info.title || "B 站视频";
  const sourceId = `${info.bvid || bvid}:${part.cid}`;
  const cover = coverUrl(part.first_frame) || coverUrl(info.pic);
  const duration = positiveDuration(part.duration) ?? (parts.length === 1 ? positiveDuration(info.duration) : undefined);
  const videoAudioMode = audios.length ? "audio-only" : "combined";
  const choices: MediaChoice[] = [];
  const streams: Plan["streams"] = [];
  for (const stream of audios.length ? audios : combined ? [combined] : []) {
    const [url, ...backupUrls] = streamUrls(stream);
    const bitrate = stream.bandwidth || undefined;
    const format = stream === combined ? "video" : stream.codecs?.startsWith("mp4a") ? "aac" : stream.codecs || "audio";
    const id = `${stream.id ?? "source"}:${format}`;
    if (!url || choices.some(choice => choice.id === id)) continue;
    choices.push({ id, quality: id, label: bitrate ? `视频音轨 · ${Math.round(bitrate / 1000)} kbps` : "视频音轨", format, bitrate });
    streams.push({ id, url, backupUrls, format, headers: biliHeaders });
  }
  const audioPlan: Plan = {
    resource: {
      token: randomUUID(), platform: "bilibili", sourceId, title, artist: info.owner?.name || "", cover,
      duration: duration || 0, completeness: duration ? "full" : "unknown", videoAudioMode, choices,
      note: videoAudioMode === "audio-only" ? "只下载这段视频的音轨。" : "平台只提供带画面的视频文件，保存音频前需要下载视频数据。",
    },
    streams,
    createdAt: Date.now(),
  };
  return {
    metadata: { title, artist: info.owner?.name || undefined, platform: "bilibili", cover, duration, sourceId, videoAudioMode, height: positiveDuration(videos[0]?.height) },
    videoUrls, audioUrls: streamUrls(audios[0]), headers: biliHeaders, audioPlan,
  };
}

export async function resolveBilibiliAudio(url: URL, sourceId?: string, cookie = "") {
  const cid = sourceId?.split(":")[1];
  return (await resolveBilibili(url, true, cid, cookie)).audioPlan!;
}

export function videoSourceUrl(platform: VideoMetadata["platform"], sourceId?: string) {
  if (platform === "bilibili" && sourceId && /^BV[0-9A-Za-z]+:\d+$/.test(sourceId))
    return `https://www.bilibili.com/video/${sourceId.split(":")[0]}`;
  if (platform === "douyin" && sourceId && /^\d{15,22}$/.test(sourceId))
    return `https://www.douyin.com/video/${sourceId}`;
}

export async function resolveVideo(input: string, cookie: string, browserResolve: (id: string) => Promise<any>, expected?: VideoMetadata, bilibiliCookie = ""): Promise<VideoPlan> {
  if (!/https?:\/\//i.test(input)) throw new Error("请粘贴抖音或 B 站的视频分享链接。");
  const url = extractLink(input);
  const parsed = new URL(url);
  const { hostname } = parsed;
  if (isBilibiliLink(parsed)) return resolveBilibili(parsed, false, expected?.sourceId?.split(":")[1], bilibiliCookie);
  if (!/(^|\.)(douyin|iesdouyin)\.com$/.test(hostname)) throw new Error("请粘贴抖音或 B 站的视频分享链接。");

  const plan = await resolveDouyin(input, cookie, browserResolve);
  const { title, artist, duration, cover, sourceId } = plan.resource;
  const stream = plan.streams[0];
  if (!stream?.url) throw new Error("平台没有返回可用的视频。");
  return {
    metadata: { title, artist, platform: "douyin", cover: coverUrl(cover), duration: positiveDuration(duration), sourceId },
    videoUrls: [stream.url],
    audioUrls: [],
    headers: stream.headers || {},
  };
}

export function videoErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "保存失败，请稍后重试。";
  return (message === "fetch failed" ? "网络连接失败，平台视频节点暂不可用，请稍后重试。" : message)
    .replace(/https?:\/\/[^\s]+/g, "[资源地址]").slice(0, 500);
}

export async function saveVideo(
  resolve: () => Promise<VideoPlan>, outputDir: string, temp: string, task: VideoTask, signal: AbortSignal,
  persistSource: () => void, preparePublish: (candidate: PublishedCandidate) => void,
) {
  const files: string[] = [];
  try {
    existingDirectory(outputDir);
    const plan = await resolve().catch(error => {
      if (!isNetworkFailure(error) && task.interrupted) task.needsReview = true;
      throw error;
    });
    signal.throwIfAborted();
    if (task.sourceId && (task.sourceId !== plan.metadata.sourceId || task.platform !== plan.metadata.platform)) {
      task.needsReview = true;
      throw new Error("来源视频已变化，请重新确认链接。");
    }
    Object.assign(task, plan.metadata);
    persistSource();
    const get = async (urls: string[], name: string, start: number, end: number) => {
      const dest = path.join(temp, `${task.id}-${name}`);
      files.push(dest);
      let lastError: unknown;
      for (const url of urls) {
        try {
          await download(url, dest, signal, n => { task.progress = Math.round(start + n / 70 * (end - start)); }, plan.headers);
          return dest;
        } catch (error) {
          lastError = error;
          await unlink(dest).catch(() => {});
          signal.throwIfAborted();
        }
      }
      throw lastError;
    };

    task.message = "正在下载视频…";
    const videoFile = await get(plan.videoUrls, "video", 0, plan.audioUrls.length ? 80 : 99);
    let audioFile = "";
    if (plan.audioUrls.length) {
      task.message = "正在下载音轨…";
      audioFile = await get(plan.audioUrls, "audio", 80, 99);
    }
    task.message = "正在整理视频…";
    task.progress = undefined;
    const result = path.join(temp, `${task.id}-result.mp4`);
    files.push(result);
    await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", videoFile,
      ...(audioFile ? ["-i", audioFile] : []), "-map", "0:v:0", "-map", audioFile ? "1:a:0" : "0:a:0?",
      "-c", "copy", "-movflags", "+faststart", result], signal);

    signal.throwIfAborted();
    const dir = existingDirectory(outputDir);
    const digest = await checksum(result);
    const published = await publishAudio(result, dir, task.title || "视频", task.id, "mp4", signal, undefined, true,
      file => preparePublish({ ...file, checksum: digest }));
    task.filePath = published.filePath;
    task.checksum = digest;
    task.status = "completed";
    task.message = "视频已保存。";
  } catch (error) {
    if (!signal.aborted) {
      task.status = "failed";
      task.message = videoErrorMessage(error);
    }
  } finally {
    task.progress = undefined;
    await Promise.all(files.map(file => unlink(file).catch(() => {})));
  }
}
