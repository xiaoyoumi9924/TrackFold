import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountStore,
  interpretAccount,
  normalizeCookie,
  type Inspection,
} from "../server/accounts.ts";
const absent = async (): Promise<Inspection> => ({
  status: "not_connected",
  message: "未登录",
});
test("QR progress replaces the initial phone instruction without claiming authentication", (t) => {
  const { accounts } = store(t);
  accounts.qishuiQrOpened();
  accounts.qishuiQrProgress(
    "verification",
    "手机扫码已完成，请在电脑继续验证。",
  );
  assert.equal(
    accounts.state("qishui").message,
    "手机扫码已完成，请在电脑继续验证。",
  );
  assert.equal(accounts.state("qishui").status, "logging_in");
  accounts.qishuiQrProgress("scanned", "请在手机确认");
  assert.match(accounts.state("qishui").message, /无需重复操作/);
  accounts.update({ qishui: "" });
  accounts.qishuiQrProgress("verification", "late");
  assert.equal(accounts.state("qishui").status, "not_connected");
});
function store(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shiyin-accounts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, accounts: new AccountStore(dir) };
}
test("saving a credential never claims authenticated; expired sessions stay expired", async (t) => {
  const { accounts } = store(t);
  accounts.update({ qishui: "test-session" });
  assert.equal(accounts.state("qishui").status, "unverified");
  await accounts.check("qishui", absent, async () =>
    interpretAccount("qishui", { status_code: 1000016 }),
  );
  assert.equal(accounts.state("qishui").status, "expired");
  assert.equal(accounts.state("qishui").hasCredentials, true);
});
test("only a returned account identity confirms login, and membership remains separate", () => {
  assert.equal(
    interpretAccount("qishui", { status_code: 0 }).status,
    "unverified",
  );
  const valid = interpretAccount("qishui", {
    status_code: 0,
    user: { uid: "123", nickname: "测试账号", is_vip: false },
  });
  assert.equal(valid.status, "connected");
  assert.equal(valid.vip, false);
  assert.equal(
    interpretAccount("qishui", { status_code: 0, user: { uid: "0" } }).status,
    "unverified",
  );
});
test("Soda PC my_info is an account identity and numeric membership is explicit", () => {
  assert.equal(
    interpretAccount("qishui", {
      my_info: { id: "123", name: "测试", is_vip: 1 },
    }).status,
    "connected",
  );
  assert.equal(
    interpretAccount("qishui", { my_info: { id: "123", is_vip: 0 } }).vip,
    false,
  );
  assert.equal(
    interpretAccount("qishui", { my_info: { id: "0", is_vip: 1 } }).status,
    "unverified",
  );
  assert.equal(
    interpretAccount("qishui", { status_info: { status_code: 401 } }).status,
    "expired",
  );
});
test("a browser login retires a stale manual Cookie and old pending checks cannot override it", async (t) => {
  const { accounts } = store(t);
  accounts.update({ douyin: "sessionid=old-test-session" });
  let release!: (v: Inspection) => void;
  const pending = accounts.check(
    "douyin",
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  accounts.browserLoginOpened();
  assert.equal(accounts.cookie("douyin"), "");
  release({ status: "expired", message: "old" });
  await pending;
  assert.equal(accounts.state("douyin").status, "logging_in");
  await accounts.check("douyin", async (cookie) => {
    assert.equal(cookie, "");
    return { status: "connected", message: "ok" };
  });
  assert.equal(accounts.state("douyin").status, "connected");
});
test("multi-account validation is atomic and credentials are absent from public state", (t) => {
  const { accounts, dir } = store(t);
  accounts.update({ qishui: "original-test-session" });
  assert.throws(() =>
    accounts.update({ qishui: "replacement", douyin: "bad\nvalue" }),
  );
  assert.equal(accounts.cookie("qishui"), "sessionid=original-test-session");
  assert.equal(
    JSON.stringify(accounts.all()).includes("original-test-session"),
    false,
  );
  assert.equal(
    readFileSync(path.join(dir, "sessions.enc")).includes(
      Buffer.from("original-test-session"),
    ),
    false,
  );
  assert.throws(() => normalizeCookie("douyin", "ttwid=visitor-only"));
});
test("disconnecting while a check is pending prevents a late result restoring login", async (t) => {
  const { accounts } = store(t);
  accounts.update({ qishui: "session-a" });
  let release!: (v: Inspection) => void;
  const gate = new Promise<Inspection>((r) => (release = r));
  const check = accounts.check("qishui", absent, () => gate);
  accounts.update({ qishui: "" });
  release({ status: "connected", nickname: "旧账号", message: "ok" });
  await check;
  assert.equal(accounts.state("qishui").status, "not_connected");
  assert.equal(accounts.cookie("qishui"), "");
});
test("checks are deduplicated and restart requires rechecking saved sessions", async (t) => {
  const { accounts, dir } = store(t);
  accounts.update({ qishui: "test-session" });
  let calls = 0;
  const inspect = async (): Promise<Inspection> => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { status: "connected", message: "ok" };
  };
  await Promise.all([
    accounts.check("qishui", absent, inspect),
    accounts.check("qishui", absent, inspect),
  ]);
  assert.equal(calls, 1);
  assert.equal(new AccountStore(dir).state("qishui").status, "unverified");
});
