import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import path from "node:path";
import type { AccountPlatform, AccountState } from "../shared/types.ts";
import { platformFetch } from "./providers.ts";

const platforms = ["qishui", "douyin", "bilibili"] as const;
type Credentials = Partial<Record<AccountPlatform, string>>;
export type Inspection = Pick<
  AccountState,
  "status" | "message" | "nickname" | "vip"
>;
export function normalizeCookie(platform: AccountPlatform, input: string) {
  const value = input.trim();
  if (value.length > 30000 || /[\r\n\u0000-\u001f\u007f]/.test(value))
    throw new Error("登录信息格式无效，请粘贴单行 Cookie。");
  if (!value) return "";
  if (platform === "bilibili") {
    if (!/^SESSDATA=[^;\s]+$/.test(value)) throw new Error("B 站登录信息无效，请重新扫码。");
    return value;
  }
  if (platform === "qishui" && !value.includes("="))
    return `sessionid=${value}`;
  if (
    !value
      .split(";")
      .some((part) => /^(sessionid|sessionid_ss|sid_tt)=.+/.test(part.trim()))
  )
    throw new Error(
      "未找到有效的登录字段，请填写 sessionid 或包含登录信息的完整 Cookie。",
    );
  return value;
}
export function interpretAccount(
  platform: AccountPlatform,
  payload: any,
): Inspection {
  const code =
    payload?.status_code ?? payload?.status_info?.status_code ?? payload?.code;
  const message = String(
    payload?.status_info?.status_msg ||
      payload?.status_msg ||
      payload?.message ||
      "",
  );
  if (
    code === 1000016 ||
    code === 8 ||
    code === 401 ||
    /未登录|登录.*失效|重新登录|not.?login|session.*expir/i.test(message)
  )
    return { status: "expired", message: "登录已失效，请重新连接账号。" };
  if (code != null && code !== 0)
    return { status: "error", message: "平台暂时未确认账号，请稍后再检查。" };
  const user =
    payload?.my_info ||
    payload?.user ||
    payload?.user_info ||
    payload?.me?.user ||
    payload?.me ||
    payload?.data?.user ||
    payload?.data?.user_info ||
    payload?.data?.my_info ||
    payload?.data ||
    payload;
  const uid = user?.uid || user?.user_id || user?.id || user?.sec_uid;
  if (!uid || String(uid) === "0")
    return {
      status: "unverified",
      message: "已保存登录信息，但平台尚未确认登录状态。",
    };
  const vip = user?.is_vip ?? user?.vip_info?.is_vip ?? payload?.is_vip;
  return {
    status: "connected",
    message:
      platform === "qishui"
        ? "账号已验证，歌曲权限以每首资源的实际返回为准。"
        : "账号已验证，可重新解析视频。",
    nickname:
      typeof (user.nickname ?? user.name) === "string"
        ? (user.nickname ?? user.name).slice(0, 100)
        : undefined,
    ...(typeof vip === "boolean"
      ? { vip }
      : vip === 0 || vip === 1
        ? { vip: vip === 1 }
        : {}),
  };
}
export async function inspectQishui(cookie: string): Promise<Inspection> {
  try {
    const r = await platformFetch(
      "https://api.qishui.com/luna/pc/me?aid=386088&device_platform=windows",
      { headers: { Cookie: cookie } },
    );
    const text = await r.text();
    if (!text.trim())
      return {
        status: "unverified",
        message: "平台返回空响应，暂时无法确认登录。",
      };
    return interpretAccount("qishui", JSON.parse(text));
  } catch {
    return {
      status: "error",
      message: "账号检查暂未成功，请检查网络后重试；已保存的信息仍保留。",
    };
  }
}
export class AccountStore {
  private credentials: Credentials = {};
  private states: Record<AccountPlatform, AccountState>;
  private revisions = { qishui: 0, douyin: 0, bilibili: 0 };
  private pending = new Map<
    AccountPlatform,
    { revision: number; promise: Promise<AccountState> }
  >();
  private key: Buffer;
  constructor(
    private directory: string,
    browserProfileExists = false,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "session.key");
    if (!existsSync(file))
      writeFileSync(file, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(file);
    try {
      const b = readFileSync(path.join(directory, "sessions.enc"));
      const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      this.credentials = JSON.parse(
        Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
      );
    } catch {}
    let saved: any = {};
    try {
      saved = JSON.parse(
        readFileSync(path.join(directory, "accounts.json"), "utf8"),
      );
    } catch {}
    this.states = Object.fromEntries(
      platforms.map((platform) => {
        const has =
          !!this.credentials[platform] ||
          (platform === "douyin" && browserProfileExists);
        return [
          platform,
          {
            platform,
            status: has ? "unverified" : "not_connected",
            source: this.credentials[platform]
              ? ["local", "qr"].includes(saved[platform]?.source)
                ? saved[platform].source
                : "manual"
              : has
                ? "browser"
                : "none",
            hasCredentials: has,
            message: has
              ? "已保存本机登录记录，点击检查确认是否仍有效。"
              : "尚未连接。公开资源可以先直接解析。",
            checkedAt: saved[platform]?.checkedAt,
          },
        ];
      }),
    ) as Record<AccountPlatform, AccountState>;
  }
  cookie(platform: AccountPlatform) {
    return this.credentials[platform] || "";
  }
  state(platform: AccountPlatform) {
    return { ...this.states[platform] };
  }
  all() {
    return { qishui: this.state("qishui"), douyin: this.state("douyin"), bilibili: this.state("bilibili") };
  }
  private persist() {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      c.update(JSON.stringify(this.credentials)),
      c.final(),
    ]);
    writeFileSync(
      path.join(this.directory, "sessions.enc"),
      Buffer.concat([iv, c.getAuthTag(), data]),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(this.directory, "accounts.json"),
      JSON.stringify(this.states, null, 2),
      { mode: 0o600 },
    );
  }
  update(values: Credentials, source: "manual" | "local" | "qr" = "manual") {
    // Validate the entire update before changing either account.
    const prepared: Credentials = {};
    for (const p of platforms)
      if (values[p] !== undefined) prepared[p] = normalizeCookie(p, values[p]!);
    for (const p of platforms) {
      if (prepared[p] === undefined) continue;
      this.revisions[p]++;
      this.credentials[p] = prepared[p];
      this.states[p] = {
        platform: p,
        status: prepared[p] ? "unverified" : "not_connected",
        source: prepared[p] ? source : "none",
        hasCredentials: !!prepared[p],
        message: prepared[p]
          ? "登录信息已保存，等待平台检查。"
          : "已断开本工具中的账号连接。",
      };
    }
    this.persist();
  }
  browserLoginOpened() {
    this.revisions.douyin++;
    // A new browser login must not be overwritten by an earlier manual Cookie.
    delete this.credentials.douyin;
    this.states.douyin = {
      platform: "douyin",
      status: "logging_in",
      source: "browser",
      hasCredentials: this.states.douyin.hasCredentials,
      loginWindowOpen: true,
      message: "请在独立窗口完成登录。完成后点击“检查登录状态”。",
    };
    this.persist();
  }
  qishuiQrOpened() {
    this.revisions.qishui++;
    this.states.qishui = {
      ...this.states.qishui,
      status: "logging_in",
      message: "请使用已登录的抖音 App 扫码，并在手机上确认。",
    };
    this.persist();
  }
  qishuiQrEnded(message: string) {
    this.revisions.qishui++;
    this.states.qishui = {
      ...this.states.qishui,
      status: this.cookie("qishui") ? "unverified" : "not_connected",
      message,
    };
    this.persist();
  }
  qishuiQrProgress(phase: string, message: string) {
    if (
      this.states.qishui.status !== "logging_in" ||
      phase === "confirmed" ||
      phase === "expired"
    )
      return;
    const next =
      phase === "scanned"
        ? "扫码已收到，正在等待汽水完成登录。手机已确认时无需重复操作。"
        : message;
    if (next && this.states.qishui.message !== next) {
      this.states.qishui = { ...this.states.qishui, message: next };
      this.persist();
    }
  }
  browserLoginClosed() {
    this.revisions.douyin++;
    this.states.douyin = {
      ...this.states.douyin,
      status: "unverified",
      source: "browser",
      loginWindowOpen: false,
      message: "登录窗口已关闭，正在检查实际账号状态。",
    };
    this.persist();
  }
  async check(
    platform: AccountPlatform,
    inspectBrowser: (cookie: string) => Promise<Inspection>,
    inspectMusic = inspectQishui,
  ) {
    const revision = this.revisions[platform],
      existing = this.pending.get(platform);
    if (existing?.revision === revision) return existing.promise;
    if (platform !== "douyin" && !this.cookie(platform))
      return this.state(platform);
    const cookie = this.cookie(platform);
    this.states[platform] = {
      ...this.states[platform],
      status: "checking",
      message: "正在向平台检查登录状态…",
    };
    const promise = (async () => {
      let result: Inspection;
      try {
        result =
          platform === "qishui"
            ? await inspectMusic(cookie)
            : await inspectBrowser(cookie);
      } catch {
        result = {
          status: "error",
          message: "平台暂时无法确认登录，请稍后重试。",
        };
      }
      if (this.revisions[platform] !== revision) return this.state(platform);
      this.states[platform] = {
        ...this.states[platform],
        ...result,
        nickname: result.nickname,
        vip: result.vip,
        checkedAt: new Date().toISOString(),
        hasCredentials:
          !!cookie ||
          result.status === "connected" ||
          (this.states[platform].source === "browser" &&
            result.status !== "not_connected"),
        ...(platform === "douyin" && !cookie
          ? { source: "browser" as const }
          : {}),
      };
      this.persist();
      return this.state(platform);
    })();
    this.pending.set(platform, { revision, promise });
    try {
      return await promise;
    } finally {
      if (this.pending.get(platform)?.promise === promise)
        this.pending.delete(platform);
    }
  }
}
