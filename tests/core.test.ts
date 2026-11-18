import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedUrl,
  completeness,
  extractLink,
  findVideo,
} from "../server/providers.ts";
test("short VIP track remains a preview even when it exceeds 90 percent of the song", () => {
  assert.equal(completeness(65.161, 60.001, 60.047), "preview");
  assert.equal(completeness(200, 30), "preview");
  assert.equal(completeness(65.161, 65.161, 60), "unknown");
});
test("share text accepts user samples and rejects untrusted network targets", () => {
  assert.equal(
    extractLink("汽水《碎碎念》 https://qishui.douyin.com/s/iXEyut6c/\u00a0"),
    "https://qishui.douyin.com/s/iXEyut6c/",
  );
  for (const bad of [
    "http://127.0.0.1/a",
    "https://douyin.com.evil.example/a",
    "https://user:pass@douyin.com/a",
    "file:///tmp/a",
    "https://douyin.com:8080/a",
  ])
    assert.throws(() => allowedUrl(bad));
});
test("only the requested Douyin work is selected from a response", () => {
  const payload = {
    recommend: [{ aweme_id: "other", video: {} }],
    data: {
      aweme_detail: { aweme_id: "target", desc: "requested", video: {} },
    },
  };
  assert.equal(findVideo(payload, "target").desc, "requested");
  assert.equal(findVideo(payload, "missing"), null);
});
