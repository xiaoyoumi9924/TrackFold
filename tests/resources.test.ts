import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQishuiPlan,
  douyinOriginalPlan,
  planNeedsRefresh,
  selectEquivalentChoice,
  platformFetch,
  resolveQishuiTrack,
} from "../server/providers.ts";
const track = {
  id: "123",
  name: "测试歌曲",
  vid: "full-vid",
  duration: 65161,
  label_info: { only_vip_playable: true },
  preview: { vid: "preview-vid", duration: 60000 },
  artists: [{ name: "测试作者" }],
};
function player(duration: number, vid: string, quality = "highest") {
  return {
    media_id: "123",
    video_model: JSON.stringify({
      video_id: vid,
      video_duration: duration,
      video_list: [
        {
          main_url: "https://v.example.douyinvod.com/test",
          backup_url: "https://v-backup.douyinvod.com/test",
          video_meta: { quality, vtype: "m4a", bitrate: 256000 },
          encrypt_info: { spade_a: "fixture-authorization" },
        },
      ],
    }),
  };
}
test("account streams read nested authorization without exposing it in public resource metadata", () => {
  const plan = buildQishuiPlan(track, player(60, "preview-vid"), "account");
  assert.equal(plan.streams[0].auth, "fixture-authorization");
  assert.deepEqual(plan.streams[0].backupUrls, ["https://v-backup.douyinvod.com/test"]);
  assert.equal(
    JSON.stringify(plan.resource).includes("fixture-authorization"),
    false,
  );
  assert.equal(plan.resource.completeness, "preview");
});
test("full account resource requires full identity and matching media id, not only a close duration", () => {
  assert.equal(
    buildQishuiPlan(track, player(65.161, "full-vid"), "account").resource
      .completeness,
    "full",
  );
  assert.equal(
    buildQishuiPlan(track, player(65.161, "other-vid"), "account").resource
      .completeness,
    "unknown",
  );
  assert.equal(
    buildQishuiPlan(
      track,
      { ...player(65.161, "full-vid"), media_id: "other" },
      "account",
    ).resource.completeness,
    "unknown",
  );
});
test("expired plans refresh and quality selection survives changed stream indices", () => {
  const plan = buildQishuiPlan(track, player(60, "preview-vid"), "account");
  assert.equal(planNeedsRefresh({ ...plan, expiresAt: 10000 }, 10001), true);
  assert.equal(
    planNeedsRefresh(
      { ...plan, inputFile: "/tmp/source", expiresAt: 10000 },
      10001,
    ),
    false,
  );
  plan.resource.choices[0].id = "changed";
  assert.equal(
    selectEquivalentChoice(plan, {
      quality: "highest",
      format: "m4a",
      bitrate: 256000,
    }),
    "changed",
  );
  assert.throws(
    () => selectEquivalentChoice(plan, { quality: "lossless", format: "flac" }),
    /原音质/,
  );
});
test("account headers are not forwarded to a different origin during a redirect", async (t) => {
  const requests: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests.push(new Headers(init.headers));
    return requests.length === 1
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.douyinvod.com/audio" },
        })
      : new Response("ok");
  });
  await platformFetch("https://api.qishui.com/account", {
    headers: { Cookie: "sessionid=test-only", Authorization: "test-only" },
  });
  assert.equal(requests[0].get("cookie"), "sessionid=test-only");
  assert.equal(requests[1].has("cookie"), false);
  assert.equal(requests[1].has("authorization"), false);
});
test("authenticated lookup works when the share page has metadata but no player", async (t) => {
  const id = "7616760890513360923";
  const metadata = { ...track, id };
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === "beta-luna.douyin.com") {
      assert.equal(new Headers(init.headers).has("cookie"), false);
      return Response.json({ seo_track: { track: metadata } });
    }
    assert.equal(url.searchParams.get("media_type"), "track");
    assert.equal(url.searchParams.get("media_id"), id);
    assert.equal(new Headers(init.headers).get("cookie"), "sessionid=fixture");
    return Response.json({ player_infos: [
      { ...player(200, "unrelated-vid"), media_id: "unrelated-vid" },
      { ...player(65.161, "full-vid"), media_id: "full-vid" },
    ] });
  });
  const plan = await resolveQishuiTrack(id, "sessionid=fixture");
  assert.deepEqual(calls, ["beta-luna.douyin.com", "api.qishui.com"]);
  assert.equal(plan.resource.sourceId, id);
  assert.equal(plan.resource.completeness, "full");
  assert.equal(plan.resource.duration, 65.161);
});
test("original clips can be previewed using their authenticated media type", async (t) => {
  const id = "7685268412867545875";
  const mediaTypes: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "beta-luna.douyin.com") return Response.json({ status_code: 1000091 });
    const mediaType = url.searchParams.get("media_type")!;
    mediaTypes.push(mediaType);
    if (mediaType === "track") return Response.json({ status_code: 1000005 });
    return Response.json({ player_infos: [{ ...player(21, "clip-vid"), media_id: "clip-vid" }] });
  });
  const plan = await resolveQishuiTrack(id, "sessionid=fixture", { preview: true });
  assert.deepEqual(mediaTypes, ["track", "ugc_clip"]);
  assert.equal(plan.resource.sourceId, id);
  assert.equal(plan.resource.duration, 21);
  assert.equal(plan.resource.completeness, "unknown");
  await assert.rejects(resolveQishuiTrack(id, "sessionid=fixture"), /没有返回/);
  await assert.rejects(resolveQishuiTrack(id, "", { preview: true }), /试听资源/);
  assert.deepEqual(mediaTypes, ["track", "ugc_clip"]);
});
test("a missing Qishui track can use the same numbered Douyin sound", async (t) => {
  const id = "7685268412867545875";
  const sound = {
    status_code: 0,
    music_info: { id_str: id, title: "@天冷冷创作的原声", author: "天冷冷", duration: 21,
      play_url: { url_list: ["https://lf26-music-east.douyinstatic.com/sample.mp3"] } },
  };
  t.mock.method(globalThis, "fetch", async () => Response.json({ status_code: 1000091 }));
  assert.equal(douyinOriginalPlan("7685268412867545876", sound), undefined);
  const result = await resolveQishuiTrack(id, "", { douyinOriginal: async requested => douyinOriginalPlan(requested, sound)! });
  assert.equal(result.resource.sourceId, id);
  assert.equal(result.resource.audioSource, "douyin");
  assert.equal(result.resource.completeness, "preview");
  assert.equal(result.resource.duration, 21);
  assert.equal(result.resource.title, "天冷冷创作的原声");
});
