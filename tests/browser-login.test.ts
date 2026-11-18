import test from "node:test";
import assert from "node:assert/strict";
import { inspectCurrentDouyinUser } from "../server/browser.ts";

test("the current-login store confirms the signed-in self page without waiting for a profile network response", () => {
  const checked = inspectCurrentDouyinUser("https://www.douyin.com/user/self", {
    uid: "123456",
    nickname: "测试账号",
    sec_uid: "fixture",
  });
  assert.equal(checked?.status, "connected");
  assert.equal(checked?.nickname, "测试账号");
});
test("anonymous users, viewed authors and off-site pages cannot confirm a browser login", () => {
  for (const user of [
    null,
    {},
    { uid: "0" },
    { uid: 0 },
    { uid: "undefined" },
    { sec_uid: "guest-author" },
  ])
    assert.equal(
      inspectCurrentDouyinUser("https://www.douyin.com/user/self", user),
      undefined,
    );
  for (const url of [
    "https://www.douyin.com/user/author",
    "https://www.douyin.com/video/123",
    "https://www.douyin.com.evil.example/user/self",
    "http://www.douyin.com/user/self",
  ])
    assert.equal(inspectCurrentDouyinUser(url, { uid: "123456" }), undefined);
});
