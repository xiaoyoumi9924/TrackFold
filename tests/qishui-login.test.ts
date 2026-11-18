import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { QishuiLogin, qrImage, passportUrl } from "../server/qishui-login.ts";
const image = "data:image/png;base64,iVBORw0KGgo=";
function context(respond: (url: string) => any) {
  const send = async (url: string) => {
    const data = await respond(url);
    return {
      status: () => 200,
      ok: () => true,
      headers: () => ({}),
      json: async () => data,
    };
  };
  return {
    get: send,
    post: send,
    storageState: async () => ({ cookies: [] }),
    dispose: async () => {},
  } as any;
}
const createPayload = () => ({
  data: {
    token: "private-test-token",
    qrcode: image,
    expire_time: Math.floor(Date.now() / 1000) + 180,
    copywriting: '{"title":"请使用抖音 APP 扫码"}',
  },
});
test("generating and waiting for scan never declares a successful login or exposes raw token", async () => {
  let confirmed = 0;
  const login = new QishuiLogin(
    async () => {
      confirmed++;
    },
    async () =>
      context((u) =>
        u.includes("get_qrcode")
          ? createPayload()
          : { data: { status: "new" } },
      ),
  );
  const view = await login.create();
  assert.equal(view.phase, "new");
  assert.deepEqual(login.current(), view);
  const restored = login.current()!;
  restored.phase = "confirmed";
  assert.equal(login.current()?.phase, "new");
  assert.equal(JSON.stringify(view).includes("private-test-token"), false);
  assert.equal((await login.poll(view.id)).phase, "new");
  assert.equal(confirmed, 0);
  await login.cancel();
  assert.equal(login.current(), null);
});
test("phone confirmation requires an actual session before storing credentials", async () => {
  let confirmed = 0;
  const login = new QishuiLogin(
    async () => {
      confirmed++;
    },
    async () =>
      context((u) =>
        u.includes("get_qrcode")
          ? createPayload()
          : { data: { status: "confirmed" } },
      ),
  );
  const view = await login.create();
  assert.equal((await login.poll(view.id)).phase, "verification");
  assert.equal(confirmed, 0);
  await login.cancel();
});
test("a confirmed session is processed exactly once, using official account validation callback", async () => {
  let calls = 0;
  const login = new QishuiLogin(
    async (cookie) => {
      assert.equal(cookie, "sessionid=fixture-session-id");
      calls++;
    },
    async () =>
      context((u) =>
        u.includes("get_qrcode")
          ? createPayload()
          : {
              data: {
                status: "confirmed",
                auth: { sessionid: "fixture-session-id" },
              },
            },
      ),
  );
  const view = await login.create();
  assert.equal((await login.poll(view.id)).phase, "confirmed");
  await login.poll(view.id);
  assert.equal(calls, 1);
  await login.cancel();
});
test("cancelled QR request cannot authenticate later; old QR cannot cancel a replacement", async () => {
  let calls = 0,
    release!: (p: any) => void;
  const gate = new Promise((r) => (release = r));
  const login = new QishuiLogin(
    async () => {
      calls++;
    },
    async () =>
      context((u) => (u.includes("get_qrcode") ? createPayload() : gate)),
  );
  const first = await login.create();
  const pending = login.poll(first.id);
  await login.cancel(first.id);
  release({
    data: { status: "confirmed", auth: { sessionid: "fixture-session-id" } },
  });
  await assert.rejects(pending, /取消/);
  assert.equal(calls, 0);
  const next = await login.create();
  await assert.rejects(login.cancel(first.id), /更换/);
  assert.equal((await login.poll(next.id)).phase, "confirmed");
  await login.cancel();
});
test("QR images and authentication redirects reject executable or third-party content", () => {
  assert.equal(
    passportUrl("https://auth.zijieapi.com/passport/sso/"),
    "https://auth.zijieapi.com/passport/sso/",
  );
  assert.equal(qrImage(image), image);
  for (const s of [
    "data:image/svg+xml,<svg/>",
    "javascript:alert(1)",
    "https://evil.example/qr",
  ])
    assert.throws(() => qrImage(s));
  for (const url of [
    "http://api.qishui.com/",
    "https://qishui.com.evil.example/",
    "https://user:pass@api.qishui.com/",
  ])
    assert.throws(() => passportUrl(url));
});
test("a confirmed session returned in session_cookie is captured even without Set-Cookie", async () => {
  const mock = context((url) =>
    url.includes("get_qrcode")
      ? createPayload()
      : {
          data: {
            status: "confirmed",
            session_cookie:
              "sessionid_ss=fixture-secure-session; uid_tt=fixture-user",
          },
        },
  );
  let cookie = "";
  const login = new QishuiLogin(
    async (value) => {
      cookie = value;
    },
    async () => mock,
  );
  const view = await login.create();
  assert.equal((await login.poll(view.id)).phase, "confirmed");
  assert.match(cookie, /sessionid_ss=fixture-secure-session/);
  await login.cancel();
});
test("QR confirmation uses a form POST and accepts an issued secure session cookie", async () => {
  let posts = 0,
    confirmed = "";
  const mock = context(() => createPayload());
  mock.post = async (url: string, options: any) => {
    posts++;
    assert.equal(new URL(url).pathname, "/passport/web/check_qrconnect/");
    const form = new URLSearchParams(options.data);
    assert.equal(form.get("is_frontier"), "false");
    assert.equal(form.get("token"), "private-test-token");
    assert.equal(
      options.headers["x-ss-stub"],
      createHash("md5").update(options.data).digest("hex").toUpperCase(),
    );
    assert.equal(options.maxRedirects, 0);
    return {
      ok: () => true,
      json: async () => ({ data: { status: "confirmed" } }),
    };
  };
  mock.storageState = async () => ({
    cookies: [
      {
        domain: ".qishui.com",
        name: "sessionid_ss",
        value: "secure-test-session",
      },
    ],
  });
  const login = new QishuiLogin(
    async (cookie) => {
      confirmed = cookie;
    },
    async () => mock,
  );
  const view = await login.create();
  assert.equal((await login.poll(view.id)).phase, "confirmed");
  assert.equal(confirmed, "sessionid_ss=secure-test-session");
  assert.equal(posts, 1);
  await login.cancel();
});
test("an issued session survives an optional app redirect without requesting it", async () => {
  let stored = "";
  const mock = context((url) => {
    assert.ok(
      url.includes("get_qrcode"),
      "must not follow an optional deep link after receiving a session",
    );
    return createPayload();
  });
  mock.post = async () => ({
    ok: () => true,
    json: async () => ({
      data: {
        status: "confirmed",
        redirect_url: "luna://login/done",
      },
    }),
  });
  mock.storageState = async () => ({
    cookies: [
      {
        domain: ".qishui.com",
        name: "sessionid",
        value: "fixture-existing-session",
      },
    ],
  });
  const login = new QishuiLogin(
    async (cookie) => {
      stored = cookie;
    },
    async () => mock,
  );
  const view = await login.create();
  assert.equal((await login.poll(view.id)).phase, "confirmed");
  assert.equal(stored, "sessionid=fixture-existing-session");
  await login.cancel();
});
test("server-issued frontier flag is retained and the passport device survives QR replacement and restart", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shiyin-qr-device-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let seenDevice = "",
    posts = 0;
  const factory = async () => {
    const mock = context((url) => {
      const u = new URL(url);
      if (seenDevice) assert.equal(u.searchParams.get("device_id"), seenDevice);
      else seenDevice = u.searchParams.get("device_id")!;
      assert.match(seenDevice, /^\d{16}$/);
      assert.equal(u.searchParams.get("iid"), u.searchParams.get("install_id"));
      return {
        ...createPayload(),
        data: { ...createPayload().data, is_frontier: true },
      };
    });
    mock.post = async (_url: string, options: any) => {
      posts++;
      assert.equal(
        new URLSearchParams(options.data).get("is_frontier"),
        "true",
      );
      return {
        ok: () => true,
        json: async () => ({
          data: { status: "3", auth: { sessionid: "fixture-session-id" } },
        }),
      };
    };
    mock.storageState = async () => ({
      cookies: [
        {
          name: "sessionid",
          value: "must-not-persist",
          domain: "api.qishui.com",
        },
        { name: "odin_tt", value: "guest-device", domain: ".qishui.com" },
      ],
    });
    return mock;
  };
  const login = new QishuiLogin(async () => {}, factory, directory);
  const first = await login.create();
  assert.equal((await login.poll(first.id)).phase, "confirmed");
  await login.cancel();
  await login.create();
  await login.cancel();
  const restarted = new QishuiLogin(async () => {}, factory, directory);
  await restarted.create();
  await restarted.cancel();
  assert.equal(posts, 1);
  const saved = readFileSync(
    path.join(directory, "passport-device.json"),
    "utf8",
  );
  assert.equal(saved.includes("must-not-persist"), false);
  assert.equal(saved.includes("guest-device"), true);
});
test("rate limiting cools down without confusing it with a second-verification challenge", async () => {
  const mock = context(() => createPayload());
  let calls = 0;
  mock.post = async () => {
    calls++;
    return {
      ok: () => true,
      json: async () => ({ data: { error_code: 7, status: "scanned" } }),
    };
  };
  const login = new QishuiLogin(
    async () => {
      throw Error("must not authenticate");
    },
    async () => mock,
  );
  const qr = await login.create();
  const result = await login.poll(qr.id);
  assert.equal(result.phase, "cooldown");
  assert.equal(result.platformCode, 7);
  await login.poll(qr.id);
  assert.equal(calls, 1);
  await login.cancel();
});
