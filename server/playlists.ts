import type { PlaylistImport, PlaylistTrack } from "../shared/types.ts";
import { extractLink, platformFetch } from "./providers.ts";

const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9]\d{5,24}$/.test(v);
function idFromUrl(url: URL) {
  const id =
    url.searchParams.get("playlist_id") ||
    url.pathname.match(/^\/playlist\/(\d+)\/?$/)?.[1];
  return validId(id) ? id : undefined;
}
export async function playlistId(
  input: string,
  fetcher = platformFetch,
  signal?: AbortSignal,
) {
  if (typeof input !== "string" || input.length > 5000)
    throw new Error("请粘贴一条汽水歌单分享链接或编号。");
  if (validId(input.trim())) return input.trim();
  const url = new URL(extractLink(input));
  if (
    ![
      "qishui.douyin.com",
      "music.douyin.com",
      "beta-luna.douyin.com",
      "qishui.com",
      "www.qishui.com",
    ].includes(url.hostname)
  )
    throw new Error("这里只支持汽水音乐歌单，请使用汽水 App 的歌单分享链接。");
  const direct = idFromUrl(url);
  if (direct) return direct;
  if (url.searchParams.has("track_id"))
    throw new Error("这是单首歌曲链接，请使用歌单的分享链接。");
  const response = await fetcher(url.href, { signal });
  const final = new URL(response.url);
  await response.body?.cancel();
  const id = idFromUrl(final);
  if (!id)
    throw new Error("未找到歌单编号。请打开歌单页面，重新复制分享链接。");
  return id;
}

export function playlistPage(payload: any, expected: string) {
  if (payload?.status_code) {
    if (payload.status_code === 1000016)
      throw new Error(
        "歌单需要有效的汽水账号，请连接后重试。公开歌单也可能因平台验证暂时不可读。",
      );
    if (payload.status_code === 1000005)
      throw new Error("歌单不存在或不可访问，请检查分享链接及歌单是否公开。");
    throw new Error(
      "平台暂未允许读取此歌单，请检查登录状态、公开设置或稍后重试。",
    );
  }
  if (payload?.playlist?.id !== expected)
    throw new Error("平台返回的歌单编号不一致，已停止导入。");
  if (
    !Array.isArray(payload.media_resources)
  )
    throw new Error("歌单歌曲列表格式发生变化，请稍后重试。");
  let skipped = 0;
  const tracks: PlaylistTrack[] = [];
  for (const row of payload.media_resources || []) {
    const track = row?.entity?.track_wrapper?.track;
    if (!track || !validId(track.id)) {
      skipped++;
      continue;
    }
    tracks.push({
      id: track.id,
      title:
        typeof track.name === "string"
          ? track.name.slice(0, 500)
          : "未命名歌曲",
      artist: Array.isArray(track.artists)
        ? track.artists
            .filter((a: any) => typeof a?.name === "string")
            .map((a: any) => a.name)
            .join(" / ")
            .slice(0, 500) || "未知歌手"
        : "未知歌手",
      duration:
        Number.isFinite(track.duration) && track.duration > 0
          ? track.duration / 1000
          : 0,
    });
  }
  const more = payload.has_more === true || payload.has_more === 1;
  const cursor =
    payload.next_cursor === undefined ? "" : String(payload.next_cursor);
  if (more && (!cursor || cursor.length > 256 || /[\r\n]/.test(cursor)))
    throw new Error("平台没有返回有效的后续页，已停止导入，避免遗漏歌曲。");
  const total =
    Number.isSafeInteger(payload.playlist.count_tracks) &&
    payload.playlist.count_tracks >= 0
      ? payload.playlist.count_tracks
      : undefined;
  return {
    tracks,
    more,
    cursor,
    skipped,
    total,
    title:
      typeof payload.playlist.title === "string"
        ? payload.playlist.title.slice(0, 500)
        : "汽水歌单",
  };
}

export async function readPlaylist(
  input: string,
  cookie = "",
  options: { signal?: AbortSignal; fetcher?: typeof platformFetch } = {},
): Promise<PlaylistImport> {
  const fetcher = options.fetcher || platformFetch;
  const signal = () =>
    options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000);
  const id = await playlistId(input, fetcher, signal());
  const tracks: PlaylistTrack[] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  let cursor = "0",
    title = "汽水歌单",
    total: number | undefined,
    skipped = 0,
    duplicates = 0,
    reachedEnd = false,
    capped = false;
  for (let page = 0; page < 20; page++) {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({
      aid: "386088",
      app_name: "luna_pc",
      device_platform: "windows",
      playlist_id: id,
      cursor,
      count: "50",
    });
    const response = await fetcher(
      `https://api.qishui.com/luna/pc/playlist/detail?${query}`,
      { signal: signal(), headers: cookie ? { Cookie: cookie } : {} },
    );
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("平台歌单响应暂时无法读取，请稍后重试。");
    }
    const parsed = playlistPage(payload, id);
    options.signal?.throwIfAborted();
    title = parsed.title;
    total = parsed.total ?? total;
    skipped += parsed.skipped;
    for (const track of parsed.tracks) {
      if (ids.has(track.id)) {
        duplicates++;
        continue;
      }
      if (tracks.length === 500) {
        capped = true;
        break;
      }
      ids.add(track.id);
      tracks.push(track);
    }
    if (capped || (tracks.length === 500 && parsed.more)) {
      capped = true;
      break;
    }
    if (!parsed.more) {
      reachedEnd = true;
      break;
    }
    if (parsed.cursor === cursor || cursors.has(parsed.cursor))
      throw new Error(
        "平台分页未前进，已停止导入。请稍后重试，避免重复或遗漏。",
      );
    cursors.add(cursor);
    cursor = parsed.cursor;
  }
  if (!reachedEnd && !capped)
    throw new Error("歌单分页次数异常，未生成不完整清单。请稍后重试。");
  const notes = [
    reachedEnd
      ? "已按平台分页读取到末页。"
      : "已达到首版 500 首上限，本次仅导入前 500 首可识别歌曲。",
  ];
  if (total !== undefined && total !== tracks.length)
    notes.push(
      `平台标注 ${total} 首，本次返回 ${tracks.length} 首可识别歌曲；数量可能受不可用歌曲或平台统计影响。`,
    );
  if (skipped) notes.push(`已跳过 ${skipped} 条没有有效歌曲编号的条目。`);
  if (duplicates) notes.push(`已合并 ${duplicates} 条重复歌曲。`);
  options.signal?.throwIfAborted();
  return {
    source: {
      id,
      title,
      url: `https://music.douyin.com/qishui/share/playlist?playlist_id=${id}`,
      total,
      reachedEnd,
      comparisonReady: reachedEnd && skipped === 0 && (total === undefined || total === tracks.length),
      notice: notes.join(" "),
      retrievedAt: new Date().toISOString(),
    },
    tracks,
  };
}
