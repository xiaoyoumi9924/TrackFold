import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBilibiliAudio, resolveVideo } from "../server/video.ts";

const videoId = "BV1Example02";
const videoUrl = `https://www.bilibili.com/video/${videoId}`;
const audioStream = "https://cdn.bilivideo.com/part-audio.m4s";
const videoStream = "https://cdn.bilivideo.com/part-video.m4s";
const combinedStream = "https://cdn.bilivideo.com/part-video.mp4";
const parts = [{ cid: 101, part: "开场", duration: 10 }, { cid: 202, part: "正片", duration: 40 }];

test("B 站 short and direct links resolve the same part for audio, and refresh follows CID", async (t) => {
  let pages = parts;
  const requestedParts: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "b23.tv") return new Response(null, { status: 302,
      headers: { Location: url.pathname === "/short" ? `${videoUrl}?p=2` : videoUrl } });
    if (url.origin === new URL(videoUrl).origin) {
      const response = new Response();
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    if (url.pathname === "/x/web-interface/view")
      return Response.json({ code: 0, data: { bvid: videoId, title: "测试视频", pages, owner: { name: "作者" } } });
    assert.equal(url.pathname, "/x/player/playurl");
    requestedParts.push(url.searchParams.get("cid")!);
    return Response.json({ code: 0, data: { dash: {
      video: [{ baseUrl: videoStream }],
      audio: [{ id: 30280, bandwidth: 192000, codecs: "mp4a.40.2", base_url: audioStream,
        backup_url: ["https://backup.bilivideo.com/part-audio.m4s"] }],
    } } });
  });

  const direct = await resolveBilibiliAudio(new URL(`${videoUrl}?p=2`));
  const short = await resolveBilibiliAudio(new URL("https://b23.tv/short"));
  const shortWithPage = await resolveBilibiliAudio(new URL("https://b23.tv/select?p=2"));
  const video = await resolveVideo(`${videoUrl}?p=2`, "", async () => assert.fail("unexpected Douyin resolution"));
  assert.equal(direct.resource.sourceId, `${videoId}:202`);
  assert.equal(short.resource.sourceId, direct.resource.sourceId);
  assert.equal(shortWithPage.resource.sourceId, direct.resource.sourceId);
  assert.equal(video.audioPlan?.resource.sourceId, direct.resource.sourceId);
  assert.equal(direct.resource.title, "测试视频 P2 正片");
  assert.equal(direct.resource.videoAudioMode, "audio-only");
  assert.deepEqual(direct.streams.map(stream => stream.url), [audioStream]);
  assert.equal(direct.streams[0].backupUrls?.length, 1);

  const differentPart = await resolveBilibiliAudio(new URL(`${videoUrl}?p=1`));
  assert.notEqual(differentPart.resource.sourceId, direct.resource.sourceId);
  pages = [...parts].reverse();
  const refreshed = await resolveBilibiliAudio(new URL(videoUrl), direct.resource.sourceId);
  assert.equal(refreshed.resource.sourceId, direct.resource.sourceId);
  assert.deepEqual(requestedParts, ["202", "202", "202", "202", "101", "202"]);
  pages = [parts[0]];
  await assert.rejects(resolveBilibiliAudio(new URL(videoUrl), direct.resource.sourceId), /没有找到指定分 P/);
});

test("B 站 selects a single combined stream with a visible download warning and rejects missing tracks", async (t) => {
  let data: unknown = { durl: [{ url: combinedStream }] };
  t.mock.method(globalThis, "fetch", async (input: string) => Response.json({ code: 0,
    data: input.includes("/view?") ? { pages: parts, title: "测试视频" } : data,
  }));
  const plan = await resolveBilibiliAudio(new URL(videoUrl));
  assert.equal(plan.resource.videoAudioMode, "combined");
  assert.match(plan.resource.note, /需要下载视频数据/);
  assert.equal(plan.streams[0].url, combinedStream);
  data = { durl: [{ url: combinedStream }, { url: combinedStream }] };
  await assert.rejects(resolveBilibiliAudio(new URL(videoUrl)), /多段格式/);
  data = { dash: { video: [{ base_url: videoStream }] } };
  await assert.rejects(resolveBilibiliAudio(new URL(videoUrl)), /没有返回可提取的音轨/);
});
