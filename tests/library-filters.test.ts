import test from "node:test";
import assert from "node:assert/strict";
import {
  audioKind,
  fileFormat,
  filterLibrary,
  emptyLibraryFilters as defaults,
} from "../shared/library-filters.ts";
import type { Job } from "../shared/types.ts";
const base: Job = {
  id: "full",
  title: "完整歌曲",
  artist: "歌手",
  platform: "qishui",
  status: "completed",
  progress: 100,
  message: "",
  format: "original",
  filename: "歌手 - 完整歌曲.flac",
  completeness: "full",
  createdAt: "2026-11-17T02:00:00Z",
  fileExists: true,
};
const jobs: Job[] = [
  base,
  {
    ...base,
    id: "preview",
    title: "试听",
    completeness: "preview",
    format: "m4a",
    filename: "试听.m4a",
    fileExists: false,
    createdAt: "2026-11-17T01:00:00Z",
  },
  {
    ...base,
    id: "clip",
    title: "配乐片段",
    platform: "local",
    clip: { start: 1, end: 5, fadeIn: 0, fadeOut: 0 },
    filename: "配乐片段.WAV",
    metadata: { title: "配乐片段", artist: "歌手", album: "剪辑专辑" },
  },
  {
    ...base,
    id: "unknown",
    completeness: "unknown",
    platform: "douyin",
    filename: "未知.mp3",
  },
  { ...base, id: "pending", status: "processing" },
];
test("library keeps intentional excerpts separate from full and preview audio", () => {
  assert.equal(audioKind({ ...base, kind: "normalized", parentJobId: "source" }), "normalized");
  assert.deepEqual(filterLibrary([{ ...base, id:"normalized", kind:"normalized" }], { ...defaults, kind:"normalized" }).map(j => j.id), ["normalized"]);
  assert.equal(audioKind({ ...base, kind: "vocals", parentJobId: "source" }), "stem");
  assert.equal(audioKind({ ...base, kind: "instrumental", parentJobId: "source" }), "stem");
  assert.equal(audioKind(jobs[2]), "clip");
  assert.deepEqual(
    filterLibrary(jobs, { ...defaults, kind: "full" }).map((j) => j.id),
    ["full"],
  );
  assert.deepEqual(
    filterLibrary(jobs, { ...defaults, kind: "preview" }).map((j) => j.id),
    ["preview"],
  );
  assert.deepEqual(
    filterLibrary(jobs, { ...defaults, kind: "unknown" }).map((j) => j.id),
    ["unknown"],
  );
  assert.equal(filterLibrary(jobs, defaults).length, 4);
});
test("filters compose, use real output extensions and include album/file names in search", () => {
  assert.equal(fileFormat(jobs[0]), "flac");
  assert.equal(fileFormat(jobs[2]), "wav");
  assert.deepEqual(
    filterLibrary(jobs, {
      ...defaults,
      platform: "local",
      format: "wav",
      query: "剪辑专辑",
      file: "available",
    }).map((j) => j.id),
    ["clip"],
  );
  assert.equal(
    filterLibrary(jobs, { ...defaults, kind: "full", platform: "local" })
      .length,
    0,
  );
  assert.deepEqual(
    filterLibrary(jobs, { ...defaults, file: "missing" }).map((j) => j.id),
    ["preview"],
  );
  assert.deepEqual(
    filterLibrary(jobs, { ...defaults, query: "  完整歌曲.flac  " }).map(
      (j) => j.id,
    ),
    ["full"],
  );
});
test("sorting preserves input order and never mixes processing jobs into library", () => {
  const before = [...jobs];
  assert.equal(
    filterLibrary(jobs, { ...defaults, sort: "oldest" })[0].id,
    "preview",
  );
  assert.notEqual(filterLibrary(jobs, defaults)[0].id, "preview");
  assert.deepEqual(jobs, before);
});
