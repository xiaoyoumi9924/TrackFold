import { randomUUID } from "node:crypto";
import type { Job, Resource } from "../shared/types.ts";

export interface Plan {
  resource: Resource;
  streams: {
    id: string;
    url: string;
    backupUrls?: string[];
    format: string;
    auth?: string;
    headers?: Record<string, string>;
  }[];
  inputFile?: string;
  createdAt?: number;
  expiresAt?: number;
}
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const sourceDomains = [
  "bilibili.com",
  "b23.tv",
  "bilivideo.com",
  "bilivideo.cn",
  "mountaintoys.cn",
  "hdslb.com",
  "douyin.com",
  "douyinstatic.com",
  "qishui.com",
  "iesdouyin.com",
  "amemv.com",
  "douyinvod.com",
  "bytecdn.cn",
  "bytecdn.com",
  "pstatp.com",
  "snssdk.com",
  "ibytedtos.com",
  "byteimg.com",
  "douyinpic.com",
  "bdxiguaimg.com",
  "zjcdn.com",
];
export function allowedUrl(value: string) {
  const u = new URL(value);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !(["4483", "8082"].includes(u.port) && ["mountaintoys.cn", "bilivideo.cn", "bilivideo.com"].some(d => u.hostname.endsWith("." + d)))) ||
    !sourceDomains.some((d) => u.hostname === d || u.hostname.endsWith("." + d))
  )
    throw new Error(`平台资源域名暂未支持（${u.host}）。`);
  return u;
}
export function extractLink(text: string) {
  const match = text.match(/https?:\/\/[^\s<>"\]\[\u00a0]+/);
  if (!match) throw new Error("请粘贴汽水音乐、抖音或 B 站的分享链接。");
  const value = match[0].replace(/[，。；！）)]+$/, "");
  allowedUrl(value);
  return value;
}
export async function platformFetch(url: string, init: RequestInit = {}) {
  let current = url;
  let headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", UA);
  for (let i = 0; i < 7; i++) {
    const target = allowedUrl(current);
    if (target.protocol === "http:" && (headers.has("Cookie") || headers.has("Authorization")))
      throw new Error("登录信息只能通过 HTTPS 发送。");
    const r = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(20000),
      headers,
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const next = new URL(r.headers.get("location") || "", current);
      if (next.origin !== new URL(current).origin) {
        headers = new Headers(headers);
        headers.delete("Cookie");
        headers.delete("Authorization");
      }
      current = next.href;
      continue;
    }
    if (!r.ok)
      throw Object.assign(
        new Error(`平台暂时未返回资源（${r.status}），请稍后重试。`),
        { status: r.status },
      );
    return r;
  }
  throw new Error("分享链接跳转次数过多。");
}
export function completeness(
  full: number,
  actual: number,
  previewDuration?: number,
): Resource["completeness"] {
  if (
    previewDuration &&
    Math.abs(actual - previewDuration) < 1.5 &&
    full > actual + 1
  )
    return "preview";
  if (full && actual && actual < full - 1.5) return "preview";
  return "unknown";
}
function modelOf(value: any) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}
function coverOf(value: any) {
  if (typeof value === "string") return value;
  if (value?.uri && value?.urls?.[0])
    return `${value.urls[0]}${value.uri}~c5_375x375.jpg`;
  return value?.url_list?.[0] || value?.urlList?.[0] || value?.urls?.[0];
}
function qualityLabel(value: string) {
  return (
    (
      {
        medium: "标准音质",
        higher: "高音质",
        highest: "极高音质",
        lossless: "无损音质",
        hi_res: "Hi-Res",
        spatial: "空间音频",
      } as Record<string, string>
    )[value] || "可用音质"
  );
}
export function buildQishuiPlan(
  track: any,
  player: any,
  origin: "seo" | "account",
  additionalNote = "",
): Plan {
  const model = modelOf(player?.video_model);
  if (!track?.name || !model?.video_list?.length)
    throw new Error("该歌曲暂时没有可用的播放资源。");
  const full = Number(track.duration) / 1000,
    duration = Number(model.video_duration) || 0;
  const preview =
    Number(track.audition_info?.duration_ms || track.preview?.duration) / 1000;
  let state = completeness(full, duration, preview);
  const fullVid = String(track.vid || ""),
    previewVid = String(track.audition_info?.vid || track.preview?.vid || "");
  if (
    String(model.video_id || "") === previewVid &&
    previewVid &&
    full > duration + 0.5
  )
    state = "preview";
  const matchesDuration = full > 0 && Math.abs(full - duration) < 1;
  const matchesFullVid =
    fullVid && String(model.video_id) === fullVid && fullVid !== previewVid;
  const matchedAccount =
    origin === "account" &&
    [String(track.id), fullVid].includes(String(player.media_id || "")) &&
    matchesFullVid;
  if (
    state === "unknown" &&
    matchesDuration &&
    (!track.label_info?.only_vip_playable || matchedAccount)
  )
    state = "full";
  const note =
    state === "preview"
      ? "平台当前只提供试听片段。账号连接与歌曲可用权限会分别检查。"
      : state === "full"
        ? "资源标识与歌曲完整时长相符。"
        : "完整性尚未确认，请核对实际资源时长。";
  const streams = model.video_list
    .map((stream: any, i: number) => ({
      id: String(i),
      url: stream.main_url || stream.backup_url,
      backupUrls: stream.main_url && stream.backup_url && stream.main_url !== stream.backup_url
        ? [stream.backup_url] : undefined,
      format: stream.video_meta?.vtype || stream.format || "m4a",
      auth:
        stream.encrypt_info?.spade_a ||
        stream.encrypt_info?.play_auth ||
        stream.play_auth ||
        stream.spade_a ||
        player.play_auth ||
        player.spade_a,
      meta: stream.video_meta || stream,
    }))
    .filter((v: any) => v.url);
  if (!streams.length) throw new Error("平台未返回可用音频地址。");
  const expiries = [Number(player.expire_at), Number(model.url_expire)]
    .filter((x) => x > 1e9)
    .map((x) => (x < 1e12 ? x * 1000 : x));
  return {
    resource: {
      token: randomUUID(),
      platform: "qishui",
      sourceId: String(track.id),
      title: track.name,
      artist: (track.artists || []).map((a: any) => a.name).join(" / "),
      cover: coverOf(track.album?.url_cover),
      duration,
      expectedDuration: full,
      completeness: state,
      note: note + (additionalNote ? " " + additionalNote : ""),
      choices: streams.map((v: any) => ({
        id: v.id,
        label:
          qualityLabel(v.meta.quality) +
          (Number(v.meta.bitrate) > 0
            ? ` · ${Math.round(Number(v.meta.bitrate) / 1000)} kbps`
            : ""),
        format: v.format,
        bitrate: Number(v.meta.bitrate) || undefined,
        quality: v.meta.quality,
      })),
    },
    streams,
    createdAt: Date.now(),
    expiresAt: expiries.length ? Math.min(...expiries) : undefined,
  };
}
type QishuiResolveOptions = {
  signal?: AbortSignal;
  preview?: boolean;
  douyinOriginal?: (id: string, signal?: AbortSignal) => Promise<Plan>;
};

export async function resolveQishui(input: string, cookie = "", options?: QishuiResolveOptions): Promise<Plan> {
  const r = await platformFetch(extractLink(input));
  const trackId =
    new URL(r.url).searchParams.get("track_id") ||
    input.match(/track_id=(\d+)/)?.[1];
  if (!trackId)
    throw new Error(
      new URL(r.url).searchParams.has("playlist_id")
        ? "这是汽水歌单。可以先打开歌单，再选择要提取的歌曲。"
        : "没有找到歌曲编号，请复制单首歌曲的分享链接。",
    );
  return resolveQishuiTrack(trackId, cookie, options);
}
function accountPlayerMatches(track: any, player: any) {
  const mediaId = String(player?.media_id || "");
  if (mediaId === track.id) return true;
  const modelId = String(modelOf(player?.video_model)?.video_id || "");
  return !!modelId && mediaId === modelId &&
    (!track.vid || [track.vid, track.audition_info?.vid, track.preview?.vid].includes(modelId));
}

async function readQishuiAccountPlan(
  track: any, mediaType: "track" | "ugc_clip", cookie: string, signal?: AbortSignal, base?: Plan,
) {
  const query = new URLSearchParams({
    aid: "386088", device_platform: "web", media_type: mediaType,
    media_id: track.id, queue_type: "search_one_track",
  });
  const payload = await (await platformFetch(`https://api.qishui.com/luna/media-player?${query}`, {
    headers: { Cookie: cookie }, signal,
  })).json() as any;
  if (payload.status_code || payload.status_info?.status_code) return;
  const infos = Array.isArray(payload.player_infos) ? payload.player_infos : [payload.player_info];
  const candidates: Plan[] = [];
  for (const info of infos) {
    if (!accountPlayerMatches(track, info)) continue;
    try {
      const plan = buildQishuiPlan(track, info, "account");
      if (!base || (plan.resource.duration >= base.resource.duration - 0.5 &&
          (base.resource.completeness !== "full" || plan.resource.completeness === "full"))) candidates.push(plan);
    } catch { /* Other returned quality groups may still be playable. */ }
  }
  return candidates.sort((a, b) => b.resource.duration - a.resource.duration)[0];
}

export async function resolveQishuiTrack(
  trackId: string, cookie = "", { signal, preview = false, douyinOriginal }: QishuiResolveOptions = {},
): Promise<Plan> {
  if (!/^[1-9]\d{5,24}$/.test(trackId)) throw new Error("歌曲编号无效。");
  let track: any;
  let base: Plan | undefined;
  let publicError: unknown;
  let originalCandidate = false;
  try {
    const seo = await (await platformFetch(
      `https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${trackId}&device_platform=web`,
      { signal },
    )).json() as any;
    originalCandidate = seo.status_code === 1000091;
    if (seo.seo_track?.track?.id === trackId) {
      track = seo.seo_track.track;
      originalCandidate ||= track.media_type === "ugc_clip";
      base = buildQishuiPlan(track, seo.track_player, "seo");
    }
  } catch (error) {
    signal?.throwIfAborted();
    publicError = error;
  }
  if (cookie && (track || preview)) {
    // The share page omits metadata for some originals. Only the preview route can use a player response alone.
    const metadata = track || { id: trackId, name: "汽水音乐" };
    const mediaTypes: ("track" | "ugc_clip")[] = preview && !base
      ? (track?.media_type === "ugc_clip" ? ["ugc_clip", "track"] : ["track", "ugc_clip"])
      : ["track"];
    let accountError: unknown;
    for (const mediaType of mediaTypes) {
      try {
        const plan = await readQishuiAccountPlan(metadata, mediaType, cookie, signal, base);
        if (plan) return plan;
      } catch (error) {
        signal?.throwIfAborted();
        accountError = error;
      }
    }
    if (base) {
      base.resource.note += accountError
        ? " 账号取流暂未成功，可检查登录状态后重试。"
        : " 本次账号请求未取得更完整的可用资源。";
    } else if (accountError) publicError = accountError;
  }
  if (base) return base;
  if (originalCandidate && douyinOriginal) {
    try { return await douyinOriginal(trackId, signal); }
    catch {
      signal?.throwIfAborted();
      if (cookie) {
        try {
          const plan = await readQishuiAccountPlan(track || { id: trackId, name: "抖音原声" }, "ugc_clip", cookie, signal);
          if (plan) {
            Object.assign(plan.resource, { audioSource: "douyin", completeness: "preview", note: "使用同编号的抖音原声音频。" });
            return plan;
          }
        } catch { signal?.throwIfAborted(); }
      }
      throw new Error("汽水和抖音暂未返回这段原声的可用音频。");
    }
  }
  if (publicError && (!track || !preview)) throw publicError;
  throw new Error(preview ? "汽水暂未提供这首歌的试听资源。" : "汽水没有返回该歌曲的可用资源。");
}

export function douyinOriginalPlan(id: string, payload: any): Plan | undefined {
  const music = payload?.music_info;
  if (payload?.status_code !== 0 || music?.id_str !== id ||
      typeof music.title !== "string" || !music.title.trim() || music.is_restricted === true) return;
  const urls = Array.isArray(music.play_url?.url_list) ? music.play_url.url_list.filter((value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try { return allowedUrl(value).protocol === "https:"; } catch { return false; }
  }) : [];
  const [url, ...backupUrls] = [...new Set<string>(urls)];
  if (!url) return;
  const duration = Number(music.duration);
  return {
    resource: {
      token: randomUUID(), sourceId: id, platform: "qishui", audioSource: "douyin",
      title: music.title.replace(/^@(?=.+)/, ""), artist: String(music.author || music.owner_nickname || ""),
      cover: coverOf(music.cover_large || music.cover_medium),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      completeness: "preview", note: "使用同编号的抖音原声音频。",
      choices: [{ id: "original", label: "抖音原声", format: "audio", quality: "douyin_original" }],
    },
    streams: [{ id: "original", url, backupUrls, format: "audio", headers: { Referer: "https://www.douyin.com/", "User-Agent": UA } }],
    createdAt: Date.now(),
  };
}
export function planNeedsRefresh(plan: Plan, now = Date.now()) {
  return (
    !plan.inputFile &&
    ((plan.expiresAt !== undefined && plan.expiresAt < now + 30000) ||
      (plan.createdAt !== undefined && now - plan.createdAt > 10 * 60 * 1000))
  );
}
export function selectEquivalentChoice(
  plan: Plan,
  selection?: Job["selection"],
) {
  if (!selection)
    return plan.resource.choices
      .slice()
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.id;
  const matching = plan.resource.choices.filter(
    (c) =>
      (!selection.quality || c.quality === selection.quality) &&
      (!selection.format || c.format === selection.format),
  );
  const candidate = matching.sort(
    (a, b) =>
      Math.abs((a.bitrate || 0) - (selection.bitrate || 0)) -
      Math.abs((b.bitrate || 0) - (selection.bitrate || 0)),
  )[0];
  if (!candidate) throw new Error("原音质已不可用，请重新解析并选择音质。");
  return candidate.id;
}
export function findVideo(value: any, id: string, depth = 0): any {
  if (!value || typeof value !== "object" || depth > 16) return null;
  if (String(value.aweme_id || value.awemeId || "") === id && value.video)
    return value;
  for (const v of Object.values(value)) {
    const found = findVideo(v, id, depth + 1);
    if (found) return found;
  }
  return null;
}
export function douyinPlan(video: any, id: string): Plan {
  const v = video.video;
  const candidates = [
    v.play_addr,
    v.playAddr,
    ...(v.bit_rate || v.bitRate || []).map(
      (x: any) => x.play_addr || x.playAddr,
    ),
  ].filter(Boolean);
  const address = candidates
    .map((x) => x.url_list?.[0] || x.urlList?.[0] || x.src)
    .find(Boolean);
  if (!address) throw new Error("视频没有可用音轨，可能已删除或需要登录。");
  return {
    resource: {
      token: randomUUID(),
      platform: "douyin",
      sourceId: id,
      title: video.desc || video.caption || "抖音视频原声",
      artist: video.author?.nickname || "抖音作者",
      cover: coverOf(v.cover || v.origin_cover || v.originCover),
      duration: Number(v.duration || video.duration || 0) / 1000,
      completeness: "full",
      note: "提取该视频实际音轨，包含视频中的人声、音乐与环境声。",
      choices: [{ id: "original", label: "视频原声", format: "mp4" }],
    },
    createdAt: Date.now(),
    streams: [
      {
        id: "original",
        url: address.replace("http://", "https://"),
        format: "mp4",
        headers: { Referer: "https://www.douyin.com/", "User-Agent": UA },
      },
    ],
  };
}
export async function resolveDouyin(
  input: string,
  cookie: string,
  browserResolve: (id: string) => Promise<any>,
): Promise<Plan> {
  const url = new URL(extractLink(input));
  if (!/(^|\.)(douyin|iesdouyin)\.com$/.test(url.hostname))
    throw new Error("请粘贴抖音的视频分享链接。");
  url.protocol = "https:";
  const r = await platformFetch(url.href, {
    headers: cookie && url.hostname === "www.douyin.com" ? { Cookie: cookie } : {},
  });
  const id =
    r.url.match(/\/video\/(\d+)/)?.[1] ||
    new URL(r.url).searchParams.get("modal_id");
  if (!id) throw new Error("没有找到视频编号，首版支持单条视频分享链接。");
  const html = await r.text();
  let video: any = null;
  for (const pattern of [
    /<script[^>]*id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/,
    /window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/,
  ]) {
    const m = html.match(pattern);
    if (m) {
      try {
        video = findVideo(
          JSON.parse(decodeURIComponent(m[1].replace(/;\s*$/, ""))),
          id,
        );
      } catch {}
    }
    if (video) break;
  }
  if (!video) video = await browserResolve(id);
  return douyinPlan(video, id);
}
