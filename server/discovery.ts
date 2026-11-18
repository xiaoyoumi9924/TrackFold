import { platformFetch } from "./providers.ts";

export interface DiscoveryItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
  album?: string;
  count?: number;
}
const idValid = (id: unknown): id is string =>
  typeof id === "string" && /^[1-9]\d{5,24}$/.test(id);
function checkResponse(payload: any) {
  const code = payload?.status_code ?? payload?.status_info?.status_code ?? 0;
  if (code !== 0)
    throw new Error("汽水暂未允许读取，请检查账号状态或稍后重试。");
}
async function readJson(
  url: string,
  cookie: string,
  fetcher = platformFetch,
  userAgent?: string,
) {
  const response = await fetcher(url, {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(userAgent ? { "User-Agent": userAgent } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  if (!body.trim())
    throw new Error("汽水接口返回空响应，暂时无法读取，请稍后重试。");
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("汽水返回的数据格式暂不可用，请稍后重试。");
  }
  checkResponse(payload);
  return payload;
}
export function parseSearch(payload: any): DiscoveryItem[] {
  checkResponse(payload);
  if (!Array.isArray(payload?.result_groups))
    throw new Error("汽水搜索结果格式未确认，请稍后重试。");
  const seen = new Set<string>();
  const result: DiscoveryItem[] = [];
  for (const group of payload.result_groups)
    for (const row of Array.isArray(group?.data) ? group.data : []) {
      const track = row?.entity?.track ?? row?.entity?.track_wrapper?.track;
      if (
        !idValid(track?.id) ||
        seen.has(track.id) ||
        typeof track.name !== "string"
      )
        continue;
      seen.add(track.id);
      result.push({
        id: track.id,
        title: track.name.slice(0, 500),
        artist: Array.isArray(track.artists)
          ? track.artists
              .map((a: any) => (typeof a?.name === "string" ? a.name : ""))
              .filter(Boolean)
              .join(" / ")
              .slice(0, 500)
          : "",
        duration: Number.isFinite(track.duration)
          ? Math.max(0, track.duration / 1000)
          : 0,
        album:
          typeof track.album?.name === "string"
            ? track.album.name.slice(0, 500)
            : "",
      });
    }
  return result;
}
export async function searchTracks(
  keyword: string,
  cookie: string,
  fetcher = platformFetch,
) {
  if (typeof keyword !== "string" || !keyword.trim() || keyword.length > 100)
    throw new Error("请输入不超过 100 字的歌名或歌手。");
  const params = new URLSearchParams({
    device_platform: "android",
    os: "android",
    ssmix: "a",
    cdid: "46556f98-1720-4248-83da-62b74b60b46a",
    channel: "xiaomi_8478_64",
    aid: "386088",
    app_name: "luna",
    version_code: "100198030",
    version_name: "19.8.0",
    manifest_version_code: "100198030",
    update_version_code: "100198030",
    resolution: "1080*1920",
    dpi: "480",
    device_type: "ABR-AL80",
    device_brand: "HUAWEI",
    language: "zh",
    os_api: "35",
    os_version: "15",
    ac: "wifi",
    device_model: "ABR-AL80",
    save_power: "0",
    font_size: "1.00",
    luna_first_launch_apk_type: "normal_apk",
    is_car_play: "0",
    battery: "0.99",
    network_speed: "10156",
    hybrid_version_code: "100198030",
    tz_name: "Asia/Shanghai",
    tz_offset: "28800",
    luna_register_time: "1784311292",
    package: "com.luna.music",
    charge: "0",
    luna_apk_type: "normal_apk",
    output_device_type: "Phone",
    volume: "1.00",
    brightness: "0.08",
    need_personal_recommend: "1",
    is_teen_mode: "0",
    sim_region: "cn",
    android_device_type: "default",
    iid: "2204957404569386",
    device_id: "2204957404565290",
    _rticket: String(Date.now()),
    q: keyword.trim(),
    cursor: "0",
    count: "20",
  });
  return parseSearch(
    await readJson(
      `https://api.qishui.com/luna/search/track?${params}`,
      cookie,
      fetcher,
      "com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)",
    ),
  );
}
export function parseMyPlaylists(payload: any) {
  checkResponse(payload);
  if (payload.playlists !== undefined && !Array.isArray(payload.playlists))
    throw new Error("汽水歌单列表格式发生变化，请稍后重试。");
  const seen = new Set<string>();
  const items: DiscoveryItem[] = [];
  for (const item of payload.playlists || []) {
    if (
      !idValid(item.id) ||
      seen.has(item.id) ||
      typeof item.title !== "string"
    )
      continue;
    seen.add(item.id);
    items.push({
      id: item.id,
      title: item.title.slice(0, 500),
      artist: "",
      duration: 0,
      ...(Number.isSafeInteger(item.count_tracks) && item.count_tracks >= 0
        ? { count: item.count_tracks }
        : {}),
    });
  }
  return {
    items,
    hasMore: payload.has_more === true || payload.has_more === 1,
    cursor: String(payload.next_cursor || ""),
    total:
      Number.isSafeInteger(payload.total_num) && payload.total_num >= 0
        ? payload.total_num
        : undefined,
  };
}
export async function myPlaylists(cookie: string, fetcher = platformFetch) {
  if (!cookie) throw new Error("请先在设置中连接汽水账号，再读取歌单。");
  const items: DiscoveryItem[] = [],
    seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      aid: "386088",
      device_platform: "windows",
      cursor,
      count: "50",
    });
    const parsed = parseMyPlaylists(
      await readJson(
        `https://api.qishui.com/luna/pc/me/playlist?${query}`,
        cookie,
        fetcher,
      ),
    );
    for (const item of parsed.items)
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    if (!parsed.hasMore)
      return {
        items,
        complete: parsed.total === undefined || items.length >= parsed.total,
      };
    if (
      !parsed.cursor ||
      cursors.has(parsed.cursor) ||
      parsed.cursor === cursor
    )
      throw new Error("歌单列表分页未完成，请稍后重试。");
    cursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  return { items, complete: false };
}
