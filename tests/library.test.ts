import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  findSaved,
  clipRange,
  metadataOf,
  outputTitle,
} from "../server/library.ts";
import { run, probe, convert, prepareArtwork } from "../server/media.ts";
import type { Job, Resource } from "../shared/types.ts";

const resource: Resource = {
  token: "new",
  platform: "qishui",
  sourceId: "song",
  title: "同名歌曲",
  artist: "歌手",
  duration: 200,
  completeness: "full",
  note: "",
  choices: [],
};
const job: Job = {
  id: "saved",
  title: resource.title,
  artist: resource.artist,
  platform: "qishui",
  sourceId: "song",
  status: "completed",
  progress: 100,
  message: "",
  format: "original",
  completeness: "full",
  createdAt: "",
};
test("history reuses only matching available full files, never previews, edits or another version", () => {
  assert.equal(
    findSaved([job], resource, "original", undefined, () => true)?.id,
    "saved",
  );
  for (const changed of [
    { completeness: "preview" as const },
    { sourceId: "other-version" },
    { platform: "douyin" as const },
    { format: "mp3" },
    { parentJobId: "parent" },
    { status: "failed" as const },
    { clip: { start: 0, end: 10, fadeIn: 0, fadeOut: 0 } },
    { selection: { bitrate: 128000 } },
  ])
    assert.equal(
      findSaved(
        [{ ...job, ...changed }],
        resource,
        "original",
        undefined,
        () => true,
      ),
      undefined,
    );
  assert.equal(
    findSaved([job], resource, "original", undefined, () => false),
    undefined,
  );
  assert.equal(
    findSaved(
      [job],
      { ...resource, completeness: "preview" },
      "original",
      undefined,
      () => true,
    ),
    undefined,
  );
});
test("clip time validation rejects invalid and overlapping fades before a task is queued", () => {
  const good = { start: 1, end: 3.5, fadeIn: 0.3, fadeOut: 0.5 };
  assert.deepEqual(clipRange(good, 6), good);
  for (const changed of [
    { start: -1 },
    { start: 3.5 },
    { end: 7 },
    { end: NaN },
    { fadeIn: -1 },
    { fadeIn: 2, fadeOut: 2 },
    { start: "1" },
  ])
    assert.throws(() => clipRange({ ...good, ...changed }, 6));
});
test("metadata keeps version text and readable names while rejecting multiline and blank titles", () => {
  const metadata = metadataOf(
    { title: "歌曲（现场版）", artist: "歌手", album: "" },
    { title: "旧标题", artist: "" },
  );
  assert.equal(outputTitle(metadata, "artist-title"), "歌手 - 歌曲（现场版）");
  assert.equal(outputTitle(metadata, "title"), "歌曲（现场版）");
  assert.throws(() => metadataOf({ title: " " }, metadata));
  assert.throws(() => metadataOf({ artist: "a\nb" }, metadata));
});
test("real media writes readable tags and attached artwork; precise clips have the expected duration and fades", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shiyin-media-"));
  const signal = AbortSignal.timeout(30000);
  try {
    const source = path.join(directory, "source.flac"),
      cover = path.join(directory, "cover.jpg");
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-c:a",
        "flac",
        source,
      ],
      signal,
    );
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=64x64",
        "-frames:v",
        "1",
        cover,
      ],
      signal,
    );
    for (const format of ["m4a", "mp3", "flac"]) {
      const output = path.join(directory, `tagged.${format}`);
      const result = await convert(
        source,
        output,
        format,
        "测试",
        6,
        signal,
        () => {},
        false,
        {
          metadata: {
            title: "片段测试",
            artist: "测试歌手",
            album: "测试专辑",
          },
          artwork: cover,
        },
      );
      assert.ok(Math.abs(result.duration - 6) < 0.1);
      assert.equal(result.tags.title, "片段测试");
      assert.equal(result.tags.artist, "测试歌手");
      assert.equal(result.tags.album, "测试专辑");
      assert.equal(result.attachedPicture, true, format);
      if (format === "m4a")
        assert.ok(await prepareArtwork(undefined, output, directory, signal));
    }
    const clipped = path.join(directory, "clip.wav");
    const result = await convert(
      source,
      clipped,
      "wav",
      "片段",
      6,
      signal,
      () => {},
      false,
      {
        metadata: { title: "片段", artist: "" },
        clip: { start: 1.25, end: 3.75, fadeIn: 0.4, fadeOut: 0.4 },
      },
    );
    assert.ok(Math.abs(result.duration - 2.5) < 0.002);
    const raw = path.join(directory, "clip.raw");
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        clipped,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "8000",
        raw,
      ],
      signal,
    );
    const pcm = await readFile(raw);
    const rms = (start: number, end: number) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += pcm.readFloatLE(i * 4) ** 2;
      return Math.sqrt(sum / (end - start));
    };
    const middle = rms(8000, 8800);
    assert.ok(rms(0, 160) < middle * 0.1, "fade-in starts quietly");
    assert.ok(rms(19840, 20000) < middle * 0.1, "fade-out ends quietly");
    assert.equal((await probe(source)).duration, 6, "source remains unchanged");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
