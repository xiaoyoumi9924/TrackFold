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
import { actualExtension, originalAudioOutput, originalAudioNote } from "../shared/preferences.ts";

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

test("local original export replaces legacy lossy copies when source packets can be kept", () => {
  const local = { ...resource, platform: "local" as const };
  for (const [codec, extension] of [["pcm_s24le", "wav"], ["opus", "opus"], ["vorbis", "ogg"]]) {
    const selection = { format: codec };
    const old = { ...job, platform: local.platform, selection, filename: "old.m4a" };
    const fresh = { ...old, id: "fresh", filename: `new.${extension}` };
    assert.equal(findSaved([old], local, "original", selection, () => true), undefined);
    assert.equal(findSaved([fresh, old], local, "original", selection, () => true), fresh);
  }
});

test("original export preserves PCM, Opus and Vorbis packets and names the AAC fallback", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shiyin-original-audio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const signal = AbortSignal.timeout(30000);
  const cases = [
    { codec: "pcm_s24le", extension: "wav", bits: 24 },
    { codec: "pcm_f32le", extension: "wav", bits: 32 },
    { codec: "opus", extension: "opus", bits: 0 },
    { codec: "vorbis", extension: "ogg", bits: 0 },
  ];
  const hash = (file: string) => run("ffmpeg", [
    "-v", "error", "-i", file, "-map", "0:a:0", "-c:a", "copy", "-f", "hash", "-hash", "sha256", "-",
  ], signal);
  for (const { codec, extension, bits } of cases) {
    const source = path.join(directory, `${codec}-source.${extension}`);
    const output = path.join(directory, `${codec}-output.${actualExtension("original", codec)}`);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      "sine=frequency=513:sample_rate=48000:duration=2", "-ac", "2", "-c:a", codec, "-strict", "experimental", source], signal);
    assert.equal(path.extname(output), "." + extension);
    assert.equal(originalAudioOutput(codec).copy, true);
    const result = await convert(source, output, extension, "保留音轨", 2, signal, () => {}, true);
    assert.equal(result.codec, codec);
    assert.equal(result.tags.title, "保留音轨");
    assert.equal(await hash(output), await hash(source));
    const stream = JSON.parse(await run("ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,bits_per_sample", "-of", "json", output,
    ], signal)).streams[0];
    assert.equal(stream.sample_rate, "48000");
    assert.equal(stream.channels, 2);
    assert.equal(stream.bits_per_sample, bits);
  }

  const explicitWav = path.join(directory, "explicit.wav");
  assert.equal((await convert(path.join(directory, "pcm_s24le-source.wav"), explicitWav, "wav",
    "剪辑素材", 2, signal, () => {})).codec, "pcm_s16le");

  const aiff = path.join(directory, "source.aiff"), fallback = path.join(directory, "fallback.m4a");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "pcm_s16be", aiff], signal);
  assert.deepEqual(originalAudioOutput("pcm_s16be"), { extension: "m4a", copy: false });
  assert.match(originalAudioNote("pcm_s16be"), /M4A（AAC 192 kbps）/);
  assert.equal((await convert(aiff, fallback, "m4a", "输出提示", 1, signal, () => {}, true)).codec, "aac");
});
