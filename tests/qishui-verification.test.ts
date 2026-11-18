import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { QishuiLogin } from "../server/qishui-login.ts";
import {
  verificationTarget,
  verificationScript,
} from "../server/qishui-verification.ts";
const image = "data:image/png;base64,iVBORw0KGgo=";
test("an unfinished second verification survives restart encrypted and cancellation deletes its resume capability", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shiyin-qr-resume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mock: any = {
    get: async () => ({
      ok: () => true,
      json: async () => ({
        data: { token: "private-resume-token", qrcode: image },
      }),
    }),
    post: async () => ({
      ok: () => true,
      json: async () => ({
        data: {
          error_code: 2046,
          verify_from: "verify",
          url: "https://lf3-cdn-tos.bytegoofy.com/a.js",
          biz_params: { ticket: "private-resume-ticket" },
        },
      }),
    }),
    storageState: async () => ({ cookies: [] }),
    dispose: async () => {},
  };
  const original = new QishuiLogin(
    async () => {
      throw Error("must not login");
    },
    async () => mock,
    directory,
  );
  const qr = await original.create();
  await original.poll(qr.id);
  await original.suspend();
  const file = path.join(directory, "qishui-qr.enc");
  const bytes = readFileSync(file);
  assert.equal(bytes.includes(Buffer.from("private-resume-token")), false);
  assert.equal(bytes.includes(Buffer.from("private-resume-ticket")), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const resumed = new QishuiLogin(
    async () => {},
    async () => mock,
    directory,
  );
  assert.equal(await resumed.restore(), true);
  assert.equal(resumed.current()!.id, qr.id);
  assert.equal(resumed.current()!.verificationRequired, true);
  assert.equal(
    (await resumed.verificationSetup(qr.id)).script,
    "https://lf3-cdn-tos.bytegoofy.com/a.js",
  );
  await resumed.cancel();
  assert.equal(existsSync(file), false);
  assert.equal(
    await new QishuiLogin(
      async () => {},
      async () => mock,
      directory,
    ).restore(),
    false,
  );
  writeFileSync(file, Buffer.from("corrupt-resume-record"));
  assert.equal(
    await new QishuiLogin(
      async () => {},
      async () => mock,
      directory,
    ).restore(),
    false,
  );
});
test("account verification cannot proxy arbitrary hosts, paths or script sources", () => {
  assert.equal(verificationScript("https://auth.zijieapi.com/ucenter_web/app/second_verification_web/dist/index.umd.production.js"),"https://auth.zijieapi.com/ucenter_web/app/second_verification_web/dist/index.umd.production.js");
  for (const url of [
    "http://api.qishui.com/passport/test",
    "https://api.qishui.com:443@evil.example/passport/test",
    "https://api.qishui.com.evil.example/passport/test",
    "https://127.0.0.1/passport/test",
    "https://api.qishui.com/unrelated/endpoint",
  ])
    assert.throws(() => verificationTarget(url));
  assert.equal(
    verificationTarget("https://api.qishui.com/passport/safe/test/"),
    "https://api.qishui.com/passport/safe/test/",
  );
  for (const url of [
    "javascript:alert(1)",
    "https://cdn.example/component.js",
    "http://lf3-cdn-tos.bytegoofy.com/a.js",
  ])
    assert.throws(() => verificationScript(url));
});
test("a 2046 challenge is retained; phone confirmation is not requested again; only Passport can finish login", async () => {
  let polls = 0,
    authenticated = 0;
  const mock: any = {
    get: async () => ({
      ok: () => true,
      json: async () => ({
        data: {
          token: "fixture-token",
          qrcode: image,
          is_frontier: false,
          expire_time: Date.now() / 1000 + 180,
        },
      }),
    }),
    post: async (_url: string, options: any) => {
      polls++;
      if (polls === 1)
        return {
          ok: () => true,
          json: async () => ({
            data: {
              error_code: 2046,
              verify_from: "verify",
              url: "https://lf3-cdn-tos.bytegoofy.com/component.js",
              biz_params: { ticket: "private-verify-ticket" },
            },
          }),
        };
      const form = new URLSearchParams(options.data);
      assert.equal(form.get("isResend"), "true");
      assert.equal(form.get("ticket"), "private-verify-ticket");
      assert.equal(form.get("token"), "fixture-token");
      return {
        ok: () => true,
        json: async () => ({
          data: {
            status: "confirmed",
            auth: { sessionid: "verified-fixture-session" },
          },
        }),
      };
    },
    storageState: async () => ({ cookies: [] }),
    dispose: async () => {},
  };
  const login = new QishuiLogin(
    async () => {
      authenticated++;
    },
    async () => mock,
  );
  const qr = await login.create();
  const challenge = await login.poll(qr.id);
  assert.equal(challenge.verificationRequired, true);
  assert.equal(challenge.platformCode, 2046);
  assert.equal(challenge.phase, "verification");
  assert.equal(
    JSON.stringify(challenge).includes("private-verify-ticket"),
    false,
  );
  await login.poll(qr.id);
  assert.equal(polls, 1);
  assert.equal(
    (await login.verificationSetup(qr.id)).script,
    "https://lf3-cdn-tos.bytegoofy.com/component.js",
  );
  assert.equal(authenticated, 0);
  assert.equal((await login.completeVerification(qr.id)).phase, "confirmed");
  assert.equal(authenticated, 1);
  await login.cancel();
  await assert.rejects(login.verificationSetup(qr.id));
});
test("widget completion alone cannot establish an account or revive an old QR", async () => {
  const mock: any = {
    get: async () => ({
      ok: () => true,
      json: async () => ({ data: { token: "fixture-token", qrcode: image } }),
    }),
    post: async () => ({
      ok: () => true,
      json: async () => ({
        data: {
          error_code: 2046,
          url: "https://lf3-cdn-tos.bytegoofy.com/a.js",
        },
      }),
    }),
    storageState: async () => ({ cookies: [] }),
    dispose: async () => {},
  };
  const login = new QishuiLogin(
    async () => {
      throw Error("must not authenticate");
    },
    async () => mock,
  );
  const qr = await login.create();
  await login.poll(qr.id);
  assert.equal(
    (await login.completeVerification(qr.id)).verificationRequired,
    true,
  );
  await login.cancel();
  await login.create();
  await assert.rejects(login.completeVerification(qr.id));
  await login.cancel();
});
