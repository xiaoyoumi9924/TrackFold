import test from "node:test";
import assert from "node:assert/strict";
import {
  myPlaylists,
  parseMyPlaylists,
  parseSearch,
  searchTracks,
} from "../server/discovery.ts";

test("search retains exact string IDs and never substitutes related versions", () => {
  const tracks = parseSearch({
    result_groups: [
      {
        data: [
          {
            entity: {
              track: {
                id: "7701932105854470207",
                name: "原版",
                duration: 65161,
                artists: [{ name: "歌手" }],
              },
            },
          },
          {
            entity: {
              track: {
                id: "7701932105854470208",
                name: "现场版",
                duration: 70000,
              },
            },
          },
          { entity: { track: { id: "7701932105854470207", name: "重复" } } },
          {
            entity: {
              track_wrapper: {
                track: {
                  id: "7701932105854470209",
                  name: "重制版",
                  duration: 90000,
                },
              },
            },
          },
          { entity: { track: { id: 7701932105854470207, name: "损失精度" } } },
        ],
      },
    ],
  });
  assert.deepEqual(
    tracks.map((t) => t.title),
    ["原版", "现场版", "重制版"],
  );
  assert.equal(tracks[0].id, "7701932105854470207");
  assert.equal(tracks[0].duration, 65.161);
  assert.throws(() => parseSearch({ status_code: 401 }), /账号/);
  assert.throws(() => parseSearch({}), /格式/);
});
test("empty platform search response is an error, not a false empty result", async () => {
  const fetcher: any = async () => new Response("", { status: 200 });
  await assert.rejects(searchTracks("歌手", "", fetcher), /空响应/);
  await assert.rejects(searchTracks("", "", fetcher), /输入/);
});
test("account playlist pagination deduplicates and rejects stalled cursors", async () => {
  let calls = 0;
  const fetcher: any = async () =>
    new Response(
      JSON.stringify(
        ++calls === 1
          ? {
              playlists: [{ id: "123456789", title: "歌单", count_tracks: 12 }],
              has_more: true,
              next_cursor: "next",
            }
          : {
              playlists: [
                { id: "123456789", title: "重复" },
                { id: "123456790", title: "第二张" },
              ],
              has_more: false,
            },
      ),
    );
  const result = await myPlaylists("sessionid=test", fetcher);
  assert.equal(result.items.length, 2);
  assert.equal(result.complete, true);
  assert.equal(result.items[0].count, 12);
  const repeat: any = async () =>
    new Response(
      JSON.stringify({ playlists: [], has_more: true, next_cursor: "x" }),
    );
  await assert.rejects(myPlaylists("sessionid=test", repeat), /分页/);
  await assert.rejects(myPlaylists("", fetcher), /连接汽水账号/);
  assert.throws(() => parseMyPlaylists({ playlists: {} }), /格式/);
});
