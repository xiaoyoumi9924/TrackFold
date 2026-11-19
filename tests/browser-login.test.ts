import test from "node:test";
import assert from "node:assert/strict";
import { inspectCurrentDouyinUser } from "../server/browser.ts";
import { douyinBrowserProfile, douyinBrowsers } from "../server/douyin-browser.ts";

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

test("Windows finds Edge without Chrome and prefers Edge when both are installed", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chrome = "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.deepEqual(douyinBrowsers("win32", env, "", candidate => candidate === edge), [
    { name: "msedge", executablePath: edge },
  ]);
  assert.deepEqual(douyinBrowsers("win32", env, "", candidate => [edge, chrome].includes(candidate)).map(b => b.name), ["msedge", "chrome"]);
});

test("Linux recognizes Edge and Chrome and Edge keeps its own persistent login profile", () => {
  const installed = new Set(["/opt/microsoft/msedge/msedge", "/usr/bin/google-chrome-stable"]);
  assert.deepEqual(douyinBrowsers("linux", {}, "", candidate => installed.has(candidate)).map(b => b.name), ["chrome", "msedge"]);
  assert.equal(douyinBrowserProfile("test-profile", "chrome"), "test-profile");
  assert.equal(douyinBrowserProfile("test-profile", "msedge"), "test-profile-edge");
});
