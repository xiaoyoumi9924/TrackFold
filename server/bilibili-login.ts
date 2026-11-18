import { randomUUID } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import type { Inspection } from "./accounts.ts";
import { platformFetch } from "./providers.ts";
import QRCode from "qrcode";

const passport = "https://passport.bilibili.com/x/passport-login/web/qrcode";
const referer = "https://www.bilibili.com/";
const loginLifetime = 180_000;

type LoginResponse = { code: number; data?: { url?: string; qrcode_key?: string; code?: number } };
type Ticket = {
  id: string;
  key: string;
  image: string;
  expiresAt: number;
  phase: "waiting" | "scanned" | "expired" | "confirmed";
};

export async function inspectBilibili(cookie: string): Promise<Inspection> {
  const response = await platformFetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: { Referer: referer, Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (result.code === -101 || result.data?.isLogin === false)
    return { status: "expired", message: "B 站登录已失效，请重新扫码。" };
  const user = result.data;
  if (result.code !== 0 || user?.isLogin !== true || !Number.isSafeInteger(user.mid) || user.mid <= 0)
    return { status: "unverified", message: "B 站暂未确认账号，请稍后检查。" };
  return {
    status: "connected",
    message: "B 站账号已登录。",
    nickname: typeof user.uname === "string" ? user.uname.slice(0, 100) : undefined,
  };
}

function sessionCookie(response: Response, landing?: string) {
  for (const value of response.headers.getSetCookie()) {
    const match = value.match(/^SESSDATA=([^;\s]+)(?:;|$)/);
    if (match) return "SESSDATA=" + match[1];
  }
  if (landing) {
    const url = URL.parse(landing);
    if (url && ["https://www.bilibili.com", "https://passport.bilibili.com", "https://account.bilibili.com"].includes(url.origin)) {
      const session = url.searchParams.get("SESSDATA");
      if (session && !/[;\s\x00-\x1f\x7f]/.test(session)) return "SESSDATA=" + session;
    }
  }
  return "";
}

export class BilibiliLogin {
  private ticket?: Ticket;
  private generation = 0;
  private polling?: { id: string; result: Promise<ReturnType<BilibiliLogin["current"]>> };

  constructor(private readonly onConfirmed: (cookie: string, account: Inspection) => Promise<unknown>) {}

  current() {
    const ticket = this.ticket;
    if (!ticket) return null;
    if (ticket.phase !== "confirmed" && Date.now() >= ticket.expiresAt) ticket.phase = "expired";
    const { key: _key, ...visible } = ticket;
    return visible;
  }

  cancel(id?: string) {
    if (id && this.ticket?.id !== id) return;
    this.generation++;
    this.ticket = undefined;
  }

  async create() {
    const generation = ++this.generation;
    this.ticket = undefined;
    const response = await platformFetch(passport + "/generate", { headers: { Referer: referer }, signal: AbortSignal.timeout(10000) });
    const { code, data } = await response.json() as LoginResponse;
    if (code !== 0 || !data?.url || !/^[A-Za-z0-9_-]{8,128}$/.test(data.qrcode_key || ""))
      throw new Error("B 站暂未提供登录二维码，请稍后重试。");
    const url = new URL(data.url);
    if (!["https://account.bilibili.com", "https://passport.bilibili.com"].includes(url.origin) || url.username || url.password)
      throw new Error("B 站返回了无法确认的扫码地址。");
    const image = await QRCode.toDataURL(url.href, { width: 230, margin: 2 });
    if (generation !== this.generation) return this.current();
    this.ticket = { id: randomUUID(), key: data.qrcode_key!, expiresAt: Date.now() + loginLifetime, image, phase: "waiting" };
    return this.current();
  }

  poll(id: string) {
    const ticket = this.ticket;
    if (!ticket || ticket.id !== id || ["expired", "confirmed"].includes(this.current()!.phase))
      return Promise.resolve(this.current());
    if (this.polling?.id === id) return this.polling.result;
    const result = this.pollTicket(ticket).finally(() => {
      if (this.polling?.id === id) this.polling = undefined;
    });
    this.polling = { id, result };
    return result;
  }

  private async pollTicket(ticket: Ticket) {
    const query = new URLSearchParams({ qrcode_key: ticket.key });
    const response = await platformFetch(passport + "/poll?" + query, { headers: { Referer: referer }, signal: AbortSignal.timeout(10000) });
    const { code, data } = await response.json() as LoginResponse;
    if (this.ticket !== ticket || this.current()?.phase === "expired") return this.current();
    if (code !== 0) throw new Error("B 站暂未确认扫码，请稍后重试。");
    switch (data?.code) {
      case 86101: break;
      case 86090: ticket.phase = "scanned"; break;
      case 86038: ticket.phase = "expired"; break;
      case 0: {
        const cookie = sessionCookie(response, data?.url);
        if (!cookie) throw new Error("B 站没有返回登录凭据，请刷新二维码后重试。");
        const account = await inspectBilibili(cookie);
        if (this.ticket !== ticket) return this.current();
        if (account.status !== "connected") throw new Error("B 站未确认登录，请刷新二维码后重试。");
        await this.onConfirmed(cookie, account);
        ticket.phase = "confirmed";
        break;
      }
      default: throw new Error("B 站暂未确认扫码，请稍后重试。");
    }
    return this.current();
  }
}
