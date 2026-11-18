import assert from "node:assert/strict";
import { test } from "node:test";
import { BilibiliLogin, inspectBilibili } from "../server/bilibili-login.ts";

test("B 站扫码只有在官网确认身份后才保存会话", async t => {
  const recorded: string[] = [];
  let status = 86101;
  let verified = false;
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/generate")) return Response.json({ code: 0, data: {
      url: "https://account.bilibili.com/h5/login?oauthKey=demo",
      qrcode_key: "example-ticket",
    } });
    if (url.pathname.endsWith("/poll")) {
      assert.equal(url.searchParams.get("qrcode_key"), "example-ticket");
      const headers = new Headers();
      if (status === 0) headers.set("Set-Cookie", "SESSDATA=test-cookie; Path=/; HttpOnly");
      return Response.json({ code: 0, data: { code: status } }, { headers });
    }
    assert.equal(url.href, "https://api.bilibili.com/x/web-interface/nav");
    assert.equal(new Headers(options.headers).get("cookie"), "SESSDATA=test-cookie");
    return Response.json(verified ? { code: 0, data: { isLogin: true, mid: 123, uname: "示例账号" } }
      : { code: -101, data: { isLogin: false } });
  });
  const login = new BilibiliLogin(async (cookie, account) => {
    assert.equal(account.nickname, "示例账号");
    recorded.push(cookie);
  });
  const ticket = (await login.create())!;
  assert.match(ticket.image, /^data:image\/png;base64,/);
  assert.equal("key" in ticket, false);
  assert.equal((await login.poll(ticket.id))?.phase, "waiting");
  status = 86090;
  assert.equal((await login.poll(ticket.id))?.phase, "scanned");
  status = 0;
  await assert.rejects(login.poll(ticket.id), /未确认登录/);
  assert.deepEqual(recorded, []);
  verified = true;
  assert.equal((await login.poll(ticket.id))?.phase, "confirmed");
  assert.deepEqual(recorded, ["SESSDATA=test-cookie"]);
  login.cancel(ticket.id);
  assert.equal(login.current(), null);
  verified = false;
  assert.equal((await inspectBilibili("SESSDATA=test-cookie")).status, "expired");
});
