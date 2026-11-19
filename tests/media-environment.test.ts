import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../server/media.ts";

test("FFmpeg and FFprobe inherit only the media process environment", async (t) => {
  const fixture = {
    SHIYIN_FFMPEG_PATH: process.execPath,
    SHIYIN_FFPROBE_PATH: process.execPath,
    SHIYIN_ACCESS_TOKEN: "fixture-not-a-token",
    SODA_APP_DIR: "fixture",
    NODE_OPTIONS: "--no-warnings",
    MEDIA_TEST_PRIVATE_KEY: "fixture",
  };
  for (const [key, value] of Object.entries(fixture)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const keys = JSON.stringify(Object.keys(fixture));
  const inspect = `JSON.stringify({ inherited: ${keys}.filter(key => key in process.env), hasPath: "PATH" in process.env })`;
  const expected = { inherited: [], hasPath: "PATH" in process.env };
  for (const tool of ["ffmpeg", "ffprobe"]) {
    assert.deepEqual(JSON.parse(await run(tool, ["-p", inspect])), expected);
  }
});
