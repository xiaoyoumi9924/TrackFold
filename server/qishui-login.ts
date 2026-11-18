import {
  randomUUID,
  randomBytes,
  randomInt,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { request, type APIRequestContext } from "playwright";
import QRCode from "qrcode";
import {
  verificationTarget,
  verificationScript,
  verificationFields,
} from "./qishui-verification.ts";

export type QrPhase =
  | "new"
  | "scanned"
  | "confirmed"
  | "expired"
  | "verification"
  | "error"
  | "cooldown";
export interface QrView {
  id: string;
  image: string;
  expiresAt: number;
  phase: QrPhase;
  message: string;
  platformCode?: number;
  verificationRequired?: boolean;
}
type StoredCookies = Awaited<
  ReturnType<APIRequestContext["storageState"]>
>["cookies"];
interface PassportDevice {
  version: 1;
  deviceId: string;
  installId: string;
  cookies: StoredCookies;
}
function loadDevice(directory?: string): PassportDevice {
  const file = directory && path.join(directory, "passport-device.json");
  if (file && existsSync(file)) {
    const device = JSON.parse(readFileSync(file, "utf8"));
    if (
      device.version !== 1 ||
      !/^\d{16}$/.test(device.deviceId) ||
      !/^\d{15}$/.test(device.installId) ||
      !Array.isArray(device.cookies)
    )
      throw new Error(
        "本机扫码设备记录损坏，请检查数据目录中的 passport-device.json。",
      );
    return device;
  }
  const digits = (n: number) =>
    String(randomInt(1, 10)) +
    Array.from({ length: n - 1 }, () => randomInt(0, 10)).join("");
  const device: PassportDevice = {
    version: 1,
    deviceId: digits(16),
    installId: digits(15),
    cookies: [],
  };
  if (file) {
    mkdirSync(directory!, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(device), { mode: 0o600, flag: "wx" });
  }
  return device;
}
interface Session {
  view: QrView;
  context: APIRequestContext;
  token: string;
  params: Record<string, string>;
  lastPoll: number;
  pending?: Promise<QrView>;
  completed: boolean;
  frontier: boolean;
  portrait: string;
  cooldownUntil: number;
  secondVerify?: any;
  secondVerified?: boolean;
  expandedDecision?: any;
}
export function passportUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !(
      u.hostname === "auth.zijieapi.com" ||
      ["qishui.com", "douyin.com"].some(
        (d) => u.hostname === d || u.hostname.endsWith("." + d),
      )
    )
  )
    throw new Error("平台验证地址无效。");
  return u.href;
}
export function qrImage(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  if (
    /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(decoded) &&
    decoded.length < 300000
  )
    return decoded;
  throw new Error("平台未返回有效二维码，请刷新重试。");
}
function instruction(value: any) {
  try {
    const p = JSON.parse(value);
    return [p.title, p.desc]
      .filter(Boolean)
      .join("。")
      .replace(/\[\/?[^\]]*\]/g, "");
  } catch {
    return "请使用已登录账号的抖音 App 扫码，在手机上确认。";
  }
}
function returnedSession(value: any, depth = 0): string | undefined {
  if (typeof value === "string" && value.length < 100000) {
    try {
      return returnedSession(JSON.parse(value), depth + 1);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object" || depth > 4) return;
  for (const name of ["sessionid", "session_id"])
    if (
      typeof value[name] === "string" &&
      /^[A-Za-z0-9._-]{8,512}$/.test(value[name])
    )
      return value[name];
  for (const name of ["auth", "extra", "data", "login_info"]) {
    const found = returnedSession(value[name], depth + 1);
    if (found) return found;
  }
}
export class QishuiLogin {
  private session?: Session;
  private device?: PassportDevice;
  private diagnostic(stage: string, data: Record<string, unknown>) {
    if (!this.directory) return;
    const file = path.join(this.directory, "qishui-login-diagnostic.json");
    let events: any[] = [];
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      events = Array.isArray(saved.events) ? saved.events : [];
    } catch {}
    const event = { at: new Date().toISOString(), stage, ...data };
    writeFileSync(
      file,
      JSON.stringify(
        { ...event, events: [...events.slice(-19), event] },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  private sessionKey() {
    const file = path.join(this.directory!, "session.key");
    if (!existsSync(file))
      writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
    const key = readFileSync(file);
    if (key.length !== 32) throw new Error("本机登录密钥不可用。");
    return key;
  }
  private async checkpoint(s: Session) {
    if (!this.directory || this.session !== s) return;
    const file = path.join(this.directory, "qishui-qr.enc");
    if (s.completed || s.view.phase === "expired") {
      rmSync(file, { force: true });
      return;
    }
    const cookies = (await s.context.storageState()).cookies;
    if (this.session !== s) return;
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.sessionKey(), iv);
    const { context: _, pending: __, ...state } = s;
    const content = Buffer.from(JSON.stringify({ version: 1, state, cookies }));
    const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
    writeFileSync(
      file + ".pending",
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      { mode: 0o600 },
    );
    renameSync(file + ".pending", file);
  }
  async restore() {
    if (!this.directory || this.session) return false;
    const file = path.join(this.directory, "qishui-qr.enc");
    if (!existsSync(file)) return false;
    try {
      const encrypted = readFileSync(file);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.sessionKey(),
        encrypted.subarray(0, 12),
      );
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const saved = JSON.parse(
        Buffer.concat([
          decipher.update(encrypted.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      const state = saved.state;
      if (
        saved.version !== 1 ||
        !state ||
        !/^[a-f0-9-]{36}$/.test(state.view?.id) ||
        typeof state.token !== "string" ||
        !state.token ||
        state.completed ||
        typeof state.view.expiresAt !== "number" ||
        state.view.expiresAt < Date.now() ||
        state.view.expiresAt > Date.now() + 600000 ||
        !Array.isArray(saved.cookies)
      ) {
        rmSync(file, { force: true });
        return false;
      }
      this.device = loadDevice(this.directory);
      const context = this.makeContext
        ? await this.makeContext()
        : await request.newContext({
            userAgent: "LunaPC/3.0.0(290101097)",
            storageState: { cookies: saved.cookies, origins: [] },
          });
      this.session = { ...state, context, lastPoll: 0, pending: undefined };
      return true;
    } catch {
      rmSync(file, { force: true });
      return false;
    }
  }
  async suspend() {
    const s = this.session;
    if (!s) return;
    if (s.pending) await s.pending.catch(() => {});
    await this.checkpoint(s);
    this.session = undefined;
    await s.context.dispose().catch(() => {});
  }
  current(): QrView | null {
    return this.session ? { ...this.session.view } : null;
  }
  constructor(
    private onConfirmed: (cookie: string) => Promise<void>,
    private makeContext?: () => Promise<APIRequestContext>,
    private directory?: string,
  ) {}
  private async rememberDevice(s: Session) {
    if (!this.directory || !this.device) return;
    const stored = await s.context.storageState();
    this.device.cookies = stored.cookies.filter(
      (c) =>
        [
          "odin_tt",
          "ttwid",
          "msToken",
          "passport_csrf_token",
          "passport_csrf_token_default",
        ].includes(c.name) &&
        ["api.qishui.com", "qishui.com"].includes(c.domain.replace(/^\./, "")),
    );
    const file = path.join(this.directory, "passport-device.json");
    writeFileSync(file + ".pending", JSON.stringify(this.device), {
      mode: 0o600,
    });
    renameSync(file + ".pending", file);
  }
  private requestHeaders(s: Session, trace: string, body?: string) {
    return {
      Accept: "application/json, text/javascript",
      "User-Agent": "LunaPC/3.0.0(290101097)",
      "x-tt-passport-verify-portrait": s.portrait,
      "x-tt-passport-trace-id": trace,
      ...(body === undefined
        ? {}
        : {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-ss-stub": createHash("md5")
              .update(body)
              .digest("hex")
              .toUpperCase(),
          }),
    };
  }
  private async get(session: Session, url: string) {
    let target = passportUrl(url);
    for (let i = 0; i < 5; i++) {
      const response = await session.context.get(target, {
        maxRedirects: 0,
        timeout: 15000,
      });
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        target = passportUrl(new URL(response.headers().location, target).href);
        continue;
      }
      if (!response.ok())
        throw new Error("平台登录服务暂时不可用，请稍后刷新。");
      return response;
    }
    throw new Error("登录跳转次数过多，请重新获取二维码。");
  }
  async create() {
    await this.cancel();
    this.device ||= loadDevice(this.directory);
    const context = await (this.makeContext
      ? this.makeContext()
      : request.newContext({
          userAgent: "LunaPC/3.0.0(290101097)",
          storageState: { cookies: this.device.cookies, origins: [] },
        }));
    const params = {
      aid: "386088",
      passport_jssdk_version: "2.4.13",
      passport_jssdk_type: "normal",
      is_from_ttaccountsdk: "1",
      next: "https://api.qishui.com",
      need_logo: "false",
      need_short_url: "false",
      is_new_login: "1",
      language: "zh",
      account_sdk_source: "web",
      p_js_v: "2.4.13",
      p_js_t: "pro",
      p_zt: "3.3.5",
      p_ver: "1.0.29",
      request_host: "app%3A%2F%2Fresources",
      p_bd: "1.0.0.41",
      is_from_iesaccountsaas: "1",
      device_platform: "PC",
      version_code: "3.5.2",
      account_sdk_source_info: "00",
      device_id: this.device.deviceId,
      install_id: this.device.installId,
      did: this.device.deviceId,
      iid: this.device.installId,
      msToken: randomBytes(88).toString("base64url") + "==",
    };
    const session: Session = {
      view: {
        id: randomUUID(),
        image: "",
        expiresAt: Date.now() + 180000,
        phase: "new",
        message: "",
      },
      context,
      token: "",
      params,
      lastPoll: 0,
      completed: false,
      frontier: false,
      portrait: randomUUID() + ".login",
      cooldownUntil: 0,
    };
    this.session = session;
    try {
      const trace = randomBytes(4).toString("hex");
      const response = await context.get(
        "https://api.qishui.com/passport/web/get_qrcode/?" +
          new URLSearchParams({ ...params, biz_trace_id: trace }),
        {
          headers: this.requestHeaders(session, trace),
          maxRedirects: 0,
          timeout: 15000,
        },
      );
      if (!response.ok())
        throw new Error("平台暂时未能生成二维码，请稍后重试。");
      const p = await response.json();
      if (p.data?.error_code || !p.data?.token)
        throw new Error("平台未能生成二维码，请稍后刷新。");
      if (this.session !== session) throw new Error("本次登录已取消。");
      session.token = p.data.token;
      session.frontier = p.data.is_frontier === true;
      let image;
      try {
        image = await QRCode.toDataURL(passportUrl(p.data.qrcode_index_url), {
          width: 240,
          margin: 2,
        });
      } catch {
        image = qrImage(p.data.qrcode || "");
      }
      session.view = {
        ...session.view,
        image,
        expiresAt: Math.min(
          Number(p.data.expire_time) > 1e9
            ? Number(p.data.expire_time) * 1000
            : Date.now() + (Number(p.data.expire_time) || 180) * 1000,
          Date.now() + 300000,
        ),
        message: instruction(p.data.copywriting),
      };
      await this.rememberDevice(session);
      await this.checkpoint(session);
      return { ...session.view };
    } catch (e) {
      if (this.session === session) this.session = undefined;
      await context.dispose();
      throw e;
    }
  }
  async poll(id: string) {
    const s = this.session;
    if (!s || s.view.id !== id) throw new Error("二维码已失效，请重新获取。");
    if (s.completed || s.view.phase === "expired") return { ...s.view };
    if (Date.now() > s.view.expiresAt) {
      s.view = {
        ...s.view,
        phase: "expired",
        message: "二维码已过期，请刷新。",
      };
      await this.checkpoint(s);
      return { ...s.view };
    }
    if (s.pending) return s.pending;
    if (s.secondVerify && !s.secondVerified) return { ...s.view };
    if (Date.now() < s.cooldownUntil || Date.now() - s.lastPoll < 2500)
      return { ...s.view };
    s.pending = this.performPoll(s);
    try {
      return await s.pending;
    } finally {
      s.pending = undefined;
      await this.checkpoint(s);
    }
  }
  private async performPoll(s: Session): Promise<QrView> {
    s.lastPoll = Date.now();
    try {
      // Passport confirms login with a form POST, retaining the QR's cookie jar.
      // A GET may report scan progress without completing the session exchange.
      const trace = randomBytes(4).toString("hex");
      const query = new URLSearchParams({ ...s.params, biz_trace_id: trace });
      const form = new URLSearchParams({
        need_logo: "false",
        need_short_url: "false",
        is_frontier: String(s.frontier),
        token: s.token,
        is_new_login: "1",
        next: "https://api.qishui.com",
        ...(s.secondVerified
          ? {
              ...verificationFields(s.secondVerify?.biz_params),
              isResend: "true",
            }
          : {}),
      }).toString();
      const response = await s.context.post(
        "https://api.qishui.com/passport/web/check_qrconnect/?" + query,
        {
          data: form,
          headers: this.requestHeaders(s, trace, form),
          timeout: 15000,
          maxRedirects: 0,
        },
      );
      if (!response.ok()) throw new Error("平台登录检查暂时不可用。");
      const p = await response.json();
      if (this.session !== s) throw new Error("本次登录已取消。");
      const d = p.data || {};
      const code = Number(d.error_code || 0);
      const redirect = d.redirect_url || d.redirectUrl;
      let redirectDestination;
      if (typeof redirect === "string")
        try {
          const u = new URL(redirect);
          redirectDestination = { origin: u.origin, path: u.pathname };
        } catch {}
      this.diagnostic("passport-result", {
        code,
        status:
          typeof d.status === "string" || typeof d.status === "number"
            ? d.status
            : undefined,
        fields: Object.keys(d),
        redirect: redirectDestination,
      });
      s.view.platformCode = code;
      await this.rememberDevice(s);
      if (code === 2046) {
        s.secondVerify = d;
        s.secondVerified = false;
        s.expandedDecision = undefined;
        s.view = {
          ...s.view,
          phase: "verification",
          verificationRequired: true,
          expiresAt: Date.now() + 600000,
          message:
            "手机扫码已完成，汽水还要求在电脑端验证账号。请打开账号验证窗口继续，无需重扫。",
        };
        return { ...s.view };
      }
      if (code === 7) {
        s.cooldownUntil = Date.now() + 5000;
        s.view = {
          ...s.view,
          phase: "cooldown",
          message:
            "平台暂时限制了检查频率，正在稍候继续确认。请不要反复刷新二维码。",
        };
        return { ...s.view };
      }
      if (code !== 0) {
        s.view = {
          ...s.view,
          phase:
            code === 2 || /过期|expired/.test(String(d.description))
              ? "expired"
              : "verification",
          message:
            code === 2046
              ? "平台要求账号二次验证，本次扫码尚未完成。请在官方汽水客户端完成验证。"
              : "平台没有完成扫码确认，请稍后重新连接。",
        };
        return { ...s.view };
      }
      const status = String(d.status).toLowerCase();
      if (["new", "0", "1"].includes(status)) {
        s.view.phase = "new";
        s.view.message = "请使用已登录的手机抖音 App 扫码，并在手机确认。";
        return { ...s.view };
      }
      if (["scanned", "2"].includes(status)) {
        s.view = {
          ...s.view,
          phase: "scanned",
          message:
            "扫码已收到，正在等待汽水完成登录。手机已确认时无需重复操作。",
        };
        return { ...s.view };
      }
      if (["expired", "timeout", "cancelled"].includes(status)) {
        s.view = {
          ...s.view,
          phase: "expired",
          message: "二维码已失效或已取消，请刷新。",
        };
        return { ...s.view };
      }
      if (
        ["confirmed", "success", "3"].includes(status) ||
        d.logged_in === true
      ) {
        const redirect = d.redirect_url || d.redirectUrl;
        let redirectSession: string | undefined;
        const alreadyIssued = (await s.context.storageState()).cookies.some(
          (c) =>
            /^(sessionid|sessionid_ss|sid_tt)$/.test(c.name) &&
            c.value &&
            /^(\.)?(api\.)?qishui\.com$/.test(c.domain),
        );
        if (
          redirect &&
          !alreadyIssued &&
          !returnedSession(d) &&
          !d.session_cookie &&
          !d.cookie
        ) {
          this.diagnostic("session-exchange", {
            hasIssuedSession: false,
            redirectOrigin:
              typeof redirect === "string"
                ? new URL(redirect).origin
                : undefined,
          });
          const exchange = await this.get(s, passportUrl(redirect));
          try {
            redirectSession = returnedSession(await exchange.json());
          } catch {}
        }
        if (this.session !== s) throw new Error("本次登录已取消。");
        const storage = await s.context.storageState();
        const pairs = storage.cookies
          .filter((c) => {
            const domain = c.domain.replace(/^\./, "");
            return (
              ("api.qishui.com" === domain ||
                "api.qishui.com".endsWith("." + domain)) &&
              c.value &&
              !/[\r\n;]/.test(c.value)
            );
          })
          .map((c) => `${c.name}=${c.value}`);
        for (const material of [
          d.session_cookie,
          d.cookie,
          p.session_cookie,
          p.cookie,
        ]) {
          if (typeof material !== "string") continue;
          for (const pair of material.split(";"))
            if (
              /^\s*(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|uid_tt_ss|passport_csrf_token)=[^\r\n;]+$/.test(
                pair,
              )
            ) {
              const clean = pair.trim();
              if (
                !pairs.some(
                  (existing) =>
                    existing.split("=", 1)[0] === clean.split("=", 1)[0],
                )
              )
                pairs.push(clean);
            }
        }
        const sessionid = returnedSession(d) || redirectSession;
        if (sessionid && !pairs.some((v) => v.startsWith("sessionid=")))
          pairs.push(`sessionid=${sessionid}`);
        if (!pairs.some((v) => /^(sessionid|sessionid_ss|sid_tt)=/.test(v))) {
          s.view = {
            ...s.view,
            phase: "verification",
            message:
              "手机已确认，但平台尚未返回汽水登录信息。请按手机提示完成验证后重试。",
          };
          return { ...s.view };
        }
        if (this.session !== s) throw new Error("本次登录已取消。");
        await this.onConfirmed(pairs.join("; "));
        s.completed = true;
        s.view = {
          ...s.view,
          phase: "confirmed",
          verificationRequired: false,
          message: "扫码确认已完成，实际登录结果请查看上方账号状态。",
        };
        return { ...s.view };
      }
      s.view = {
        ...s.view,
        phase: "verification",
        message: "请按手机提示完成验证，再检查账号状态。",
      };
      return { ...s.view };
    } catch (error) {
      if (this.session !== s) throw new Error("本次登录已取消。");
      this.diagnostic("passport-error", {
        phase: s.view.phase,
        code: s.view.platformCode,
        kind:
          error instanceof SyntaxError
            ? "invalid-json"
            : /平台验证地址/.test(String((error as any)?.message))
              ? "redirect-rejected"
              : /Timeout|超时/.test(String((error as any)?.message))
                ? "timeout"
                : "request-or-session-exchange",
        errorCode:
          typeof (error as any)?.code === "string"
            ? (error as any).code
            : undefined,
      });
      s.view = {
        ...s.view,
        phase: "error",
        message: "本次登录检查暂未成功，可稍后重试或刷新二维码。",
      };
      return { ...s.view };
    }
  }
  private verificationSession(id: string) {
    const s = this.session;
    if (
      !s ||
      s.view.id !== id ||
      !s.secondVerify ||
      s.completed ||
      Date.now() > s.view.expiresAt
    )
      throw new Error("本次账号验证已结束，请返回设置查看状态。");
    return s;
  }
  async verificationSetup(id: string) {
    const s = this.verificationSession(id);
    if (!s.expandedDecision) {
      let decision = { ...s.secondVerify };
      if (decision.verify_from === "verify_center") {
        const body = new URLSearchParams(
          verificationFields({ ...decision, ...s.params, aid: 386088 }),
        ).toString();
        const response = await this.verificationRequest(id, {
          url: "https://api.qishui.com/passport/safe/pack_verify_ways_data/?aid=386088",
          method: "POST",
          headers: {
            "x-tt-passport-verify-portrait":
              decision.verify_portrait_id || s.portrait,
          },
          body,
        });
        const data = JSON.parse(response.body);
        if (data.data?.error_code)
          throw new Error("平台暂时未能加载验证方式，请稍后重试。");
        decision = { ...decision, ...(data.data || data) };
      }
      decision.url = verificationScript(decision.url);
      s.expandedDecision = decision;
      await this.checkpoint(s);
    }
    return {
      decision: s.expandedDecision,
      generalParams: s.params,
      script: verificationScript(s.expandedDecision.url),
    };
  }
  async verificationRequest(id: string, input: any) {
    const s = this.verificationSession(id);
    const url = verificationTarget(input?.url);
    const method = String(input?.method || "GET").toUpperCase();
    if (!["GET", "POST"].includes(method))
      throw new Error("验证请求方式不受支持。");
    const body = typeof input.body === "string" ? input.body : "";
    if (body.length > 100000) throw new Error("验证请求过长。");
    const trace = randomBytes(4).toString("hex");
    const headers: Record<string, string> = {
      ...this.requestHeaders(s, trace, method === "POST" ? body : undefined),
    };
    for (const [name, value] of Object.entries(input.headers || {}))
      if (
        /^(content-type|x-tt-passport-[\w-]+|x-secsdk-[\w-]+)$/i.test(name) &&
        typeof value === "string" &&
        !/[\r\n]/.test(value)
      )
        headers[name] = value;
    const response = await s.context.fetch(url, {
      method,
      headers,
      ...(method === "POST" ? { data: body } : {}),
      maxRedirects: 0,
      timeout: 60000,
    });
    if (this.session !== s) throw new Error("本次账号验证已取消。");
    const text = await response.text();
    if (text.length > 2000000) throw new Error("平台验证响应过长。");
    await this.checkpoint(s);
    return {
      status: response.status(),
      body: text,
      contentType: response.headers()["content-type"] || "application/json",
    };
  }
  async completeVerification(id: string) {
    const s = this.verificationSession(id);
    if (s.pending) await s.pending;
    s.secondVerified = true;
    s.cooldownUntil = 0;
    s.lastPoll = 0;
    // A widget callback only authorizes retrying Passport. It never establishes
    // an authenticated account; Passport plus the /me check still decide that.
    s.view = {
      ...s.view,
      verificationRequired: false,
      phase: "scanned",
      message: "电脑端验证已提交，正在等待汽水完成登录。",
    };
    return this.poll(id);
  }
  async cancel(id?: string) {
    if (id && this.session?.view.id !== id)
      throw new Error("二维码已更换，请刷新页面。");
    const previous = this.session;
    this.session = undefined;
    if (this.directory)
      rmSync(path.join(this.directory, "qishui-qr.enc"), { force: true });
    if (previous) await previous.context.dispose().catch(() => {});
  }
}
