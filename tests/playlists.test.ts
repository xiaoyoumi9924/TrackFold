import test from "node:test";
import assert from "node:assert/strict";
import { playlistId, playlistPage, readPlaylist } from "../server/playlists.ts";
import { Batches } from "../server/batches.ts";
import type { PlaylistImport, Resource } from "../shared/types.ts";
import type { platformFetch } from "../server/providers.ts";
const id = "7434476168507637799";
const trackId = (n: number) => (7420006432714688528n + BigInt(n)).toString();
const row = (n: number) => ({
  entity: {
    track_wrapper: {
      track: {
        id: trackId(n),
        name: `歌曲 ${n}`,
        duration: 10000,
        artists: [{ name: "歌手" }],
        url: "must-not-store",
      },
    },
  },
});
const page = (
  rows: any[],
  more = false,
  cursor = "50",
  total = rows.length,
) => ({
  playlist: { id, title: "测试歌单", count_tracks: total },
  media_resources: rows,
  ...(more ? { has_more: true } : {}),
  next_cursor: cursor,
  session_id: "must-not-store",
});
const response = (data: any) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
test("playlist identifiers accept public share, web and short links but reject foreign or song inputs", async () => {
  const fetcher: typeof platformFetch = async () => {
    const r = response({});
    Object.defineProperty(r, "url", {
      value: `https://music.douyin.com/qishui/share/playlist?playlist_id=${id}`,
    });
    return r;
  };
  for (const value of [
    id,
    `歌单 https://music.douyin.com/qishui/share/playlist?playlist_id=${id}`,
    `https://www.qishui.com/playlist/${id}`,
    "https://qishui.douyin.com/s/test/",
  ])
    assert.equal(await playlistId(value, fetcher), id);
  for (const bad of [
    "https://example.invalid/playlist/1234567",
    `https://www.douyin.com/video/${id}`,
    `https://music.douyin.com/qishui/share/track?track_id=${id}`,
    "0001234567",
  ])
    await assert.rejects(playlistId(bad, fetcher));
});
test("playlist normalization keeps stable IDs and metadata, and never propagates audio/session fields", () => {
  const result = playlistPage(
    page([
      row(0),
      {
        entity: {
          track_wrapper: {
            track: { id: 7420006432714688000, name: "unsafe numeric id" },
          },
        },
      },
      { entity: { video: { id: "other" } } },
    ]),
    id,
  );
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, trackId(0));
  assert.equal(result.tracks[0].duration, 10);
  assert.equal(result.skipped, 2);
  assert(!JSON.stringify(result).includes("must-not-store"));
  assert.throws(
    () => playlistPage({ ...page([]), playlist: { id: "other" } }, id),
    /编号不一致/,
  );
  assert.throws(() => playlistPage({ status_code: 1000016 }, id), /有效.*账号/);
  assert.throws(
    () => playlistPage({ status_code: 1000005 }, id),
    /不存在或不可访问/,
  );
});
test("pagination follows has_more even when platform totals undercount and merges duplicates", async () => {
  const cursors: string[] = [];
  const fetcher: typeof platformFetch = async (url, init) => {
    assert.equal(
      new Headers(init?.headers).get("Cookie"),
      "sessionid=private-fixture",
    );
    const c = new URL(url).searchParams.get("cursor")!;
    cursors.push(c);
    return response(
      c === "0"
        ? page([row(0), row(1)], true, "50", 1)
        : page([row(1), row(2)], false, "60", 1),
    );
  };
  const result = await readPlaylist(id, "sessionid=private-fixture", {
    fetcher,
  });
  assert.deepEqual(cursors, ["0", "50"]);
  assert.equal(result.tracks.length, 3);
  assert.equal(result.source.reachedEnd, true);
  assert.match(result.source.notice, /平台标注 1 首/);
  assert.match(result.source.notice, /重复/);
  assert(!JSON.stringify(result).includes("private-fixture"));
  assert(!JSON.stringify(result).includes("must-not-store"));
});
test("midway failure and repeated cursors never return a misleading partial success", async () => {
  let count = 0;
  await assert.rejects(
    readPlaylist(id, "", {
      fetcher: async () => {
        if (count++) throw new Error("page unavailable");
        return response(page([row(0)], true));
      },
    }),
    /page unavailable/,
  );
  await assert.rejects(
    readPlaylist(id, "", {
      fetcher: async () => response(page([row(0)], true, "0")),
    }),
    /分页未前进/,
  );
});
test("large lists stop explicitly at 500 tracks without claiming to reach the final page", async () => {
  let count = 0;
  const result = await readPlaylist(id, "", {
    fetcher: async () => {
      const index = count++;
      return response(
        page(
          Array.from({ length: 50 }, (_, i) => row(index * 50 + i)),
          true,
          String((index + 1) * 50),
          800,
        ),
      );
    },
  });
  assert.equal(result.tracks.length, 500);
  assert.equal(count, 10);
  assert.equal(result.source.reachedEnd, false);
  assert.match(result.source.notice, /500.*上限/);
});
test("cancelling playlist read stops before another page or import can be produced", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    readPlaylist(id, "", {
      signal: controller.signal,
      fetcher: async () => {
        calls++;
        controller.abort();
        return response(page([row(0)], true));
      },
    }),
  );
  assert.equal(calls, 1);
});
function imported(): PlaylistImport {
  return {
    source: {
      id,
      title: "测试歌单",
      url: `https://music.douyin.com/qishui/share/playlist?playlist_id=${id}`,
      reachedEnd: true,
      notice: "已读到末页",
      retrievedAt: new Date().toISOString(),
    },
    tracks: Array.from({ length: 25 }, (_, n) => ({
      id: trackId(n),
      title: `歌曲 ${n}`,
      artist: "歌手",
      duration: 10,
    })),
  };
}
test("import only lists songs; parsing is bounded, explicit and validates the full selection atomically", async () => {
  const calls: string[] = [];
  const store = new Batches(
    [],
    () => {},
    async (input) => {
      const sourceId = new URL(input).searchParams.get("track_id")!;
      calls.push(sourceId);
      return {
        token: sourceId,
        platform: "qishui",
        sourceId,
        title: "资源",
        artist: "歌手",
        duration: 10,
        completeness: "preview",
        note: "试听",
        choices: [],
      } as Resource;
    },
  );
  const batch = store.importPlaylist(imported());
  assert.equal(calls.length, 0);
  assert(batch.items.every((i) => i.status === "listed"));
  assert.throws(
    () =>
      store.resolveSelected(
        batch.id,
        batch.items.slice(0, 21).map((i) => i.id),
      ),
    /1 至 20/,
  );
  assert.throws(
    () => store.resolveSelected(batch.id, [batch.items[0].id, "foreign"]),
    /状态已变化/,
  );
  assert.equal(calls.length, 0);
  store.resolveSelected(batch.id, [batch.items[1].id]);
  for (let n = 0; n < 20 && store.get(batch.id).status === "resolving"; n++)
    await new Promise((r) => setImmediate(r));
  const result = store.get(batch.id);
  assert.deepEqual(calls, [trackId(1)]);
  assert.equal(result.items[1].status, "ready");
  assert.equal(result.items[0].status, "listed");
  const restarted = new Batches(
    [result],
    () => {},
    async () => {
      throw new Error("must not auto-resolve");
    },
  );
  assert.equal(restarted.get(batch.id).items[0].status, "listed");
  assert.equal(restarted.get(batch.id).items[1].status, "stale");
});
test("selected playlist songs cannot be silently substituted by a different resource ID", async () => {
  const store = new Batches(
    [],
    () => {},
    async () => ({
      token: "other",
      platform: "qishui",
      sourceId: trackId(99),
      title: "wrong song",
      artist: "x",
      duration: 10,
      completeness: "full",
      note: "",
      choices: [],
    }),
  );
  const batch = store.importPlaylist(imported());
  store.resolveSelected(batch.id, [batch.items[0].id]);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.get(batch.id).items[0].status, "failed");
  assert.match(store.get(batch.id).items[0].message, /编号不一致/);
});


test("playlist update compares stable song IDs, preserves snapshots and refuses incomplete reads", async () => {
  const make = async (rows: any[], total = rows.length) => readPlaylist(id, "", { fetcher: async () => response(page(rows, false, "50", total)) });
  const saved: any[] = [];
  const batches = new Batches([], batch => saved.push(structuredClone(batch)), async () => { throw new Error("not called"); });
  const first = batches.importPlaylist(await make([row(0), row(1)]));
  const updated = batches.comparePlaylist(first.id, await make([row(1), row(2)]));
  assert.deepEqual(updated.playlistComparison?.addedIds, [trackId(2)]);
  assert.deepEqual(updated.playlistComparison?.removed.map(track => track.id), [trackId(0)]);
  assert.equal(updated.playlistComparison?.unchanged, 1);
  assert.equal(batches.get(first.id).items.length, 2);
  const reordered = batches.comparePlaylist(updated.id, await make([row(2), row(1)]));
  assert.deepEqual(reordered.playlistComparison?.addedIds, []);
  assert.deepEqual(reordered.playlistComparison?.removed, []);
  assert.throws(() => batches.comparePlaylist(first.id, { ...( {source: {...updated.playlist!, comparisonReady: false}, tracks: []} ) }), /不完整/);
  const legacy = batches.importPlaylist({source: {...first.playlist!, comparisonReady: undefined}, tracks: [first.items[0].track!]});
  assert.throws(() => batches.comparePlaylist(legacy.id, {source: updated.playlist!, tracks: []}), /不完整/);
  assert.equal((await make([row(0)], 2)).source.comparisonReady, false);
  const skipped = await make([row(0), {}]);
  assert.equal(skipped.source.comparisonReady, false);
  assert.throws(() => playlistPage({playlist: {id}}, id), /格式发生变化/);
});
