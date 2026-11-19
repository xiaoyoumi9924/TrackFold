import type { BrowserContext, Page } from "playwright";
import { rm } from "node:fs/promises";
import { douyinOriginalPlan, findVideo, type Plan } from "./providers.ts";
import { interpretAccount, type Inspection } from "./accounts.ts";
import { douyinBrowserProfile, launchDouyinBrowser } from "./douyin-browser.ts";
let context: BrowserContext | undefined;
let launching: Promise<BrowserContext> | undefined;
let visible = false,
  activeParses = 0;
let loginClosed: (() => void) | undefined;
export function loginWindowOpen() {
  return !!context && visible;
}
export async function browserContext(
  profile: string,
  show = false,
): Promise<BrowserContext> {
  if (context) return context;
  if (launching) return launching;
  launching = (async () => {
    const own = await launchDouyinBrowser(profile, show);
    context = own;
    visible = show;
    own.on("close", () => {
      if (context === own) {
        const wasVisible = visible;
        context = undefined;
        visible = false;
        if (wasVisible) {
          const cb = loginClosed;
          loginClosed = undefined;
          cb?.();
        }
      }
    });
    return own;
  })();
  try {
    return await launching;
  } finally {
    launching = undefined;
  }
}
async function applyCookie(c: BrowserContext, cookie: string) {
  if (!cookie) return;
  await c.addCookies(
    cookie
      .split(";")
      .map((s) => s.trim().split(/=(.*)/s))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => ({
        name,
        value,
        domain: ".douyin.com",
        path: "/",
        secure: true,
      })),
  );
}
export async function resolveInBrowser(
  profile: string,
  id: string,
  cookie = "",
) {
  const c = await browserContext(profile);
  activeParses++;
  let page;
  try {
    await applyCookie(c, cookie);
    page = await c.newPage();
    let found: any;
    page.on("response", async (r) => {
      if (
        !/aweme|detail|feed/.test(r.url()) ||
        !r.headers()["content-type"]?.includes("json")
      )
        return;
      try {
        found ||= findVideo(await r.json(), id);
      } catch {}
    });
    await page.goto(`https://www.douyin.com/video/${id}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    for (let i = 0; i < 18; i++) {
      if (found) return found;
      const data = await page.evaluate(() => {
        const w = window as any;
        return [w._ROUTER_DATA, w.RENDER_DATA, w.__INITIAL_STATE__].filter(
          Boolean,
        );
      });
      for (const d of data) found ||= findVideo(d, id);
      if (found) return found;
      await page.waitForTimeout(1000);
    }
    throw new Error(
      "抖音暂未返回视频数据。请在设置中打开独立登录窗口，完成登录或验证后重试。",
    );
  } finally {
    await page?.close().catch(() => {});
    activeParses--;
  }
}
export async function resolveDouyinOriginalInBrowser(profile: string, id: string, cookie = "", signal?: AbortSignal): Promise<Plan> {
  const context = await browserContext(profile);
  signal?.throwIfAborted();
  activeParses++;
  let page: Page | undefined;
  const abort = () => { void page?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await applyCookie(context, cookie);
    page = await context.newPage();
    signal?.throwIfAborted();
    let plan: Plan | undefined;
    const capture = page.waitForResponse(async response => {
      const url = new URL(response.url());
      if (url.origin !== "https://www.douyin.com" || url.pathname !== "/aweme/v1/web/music/detail/" || !response.ok()) return false;
      try {
        plan ??= douyinOriginalPlan(id, await response.json());
        return !!plan;
      } catch { return false; }
    }, { timeout: 16000 }).catch(() => undefined);
    await page.goto(`https://www.douyin.com/music/${id}`, { waitUntil: "domcontentloaded", timeout: 16000 });
    await capture;
    signal?.throwIfAborted();
    if (!plan) throw new Error("抖音未返回同编号的可用原声。");
    return plan;
  } finally {
    signal?.removeEventListener("abort", abort);
    await page?.close().catch(() => {});
    activeParses--;
  }
}

export async function inspectDouyinLogin(
  profile: string,
  cookie = "",
): Promise<Inspection> {
  const c = await browserContext(profile);
  await applyCookie(c, cookie);
  const auth = (await c.cookies("https://www.douyin.com")).filter(
    (x) =>
      ["sessionid", "sessionid_ss", "sid_tt"].includes(x.name) &&
      x.value &&
      (x.expires < 0 || x.expires > Date.now() / 1000),
  );
  if (!auth.length)
    return {
      status: cookie ? "expired" : "not_connected",
      message: cookie
        ? "登录信息未生效，请重新登录。"
        : "尚未登录抖音。公开视频仍可先尝试提取。",
    };
  // The official page signs its own requests. An unsigned HTTP check can reject a
  // valid browser login; its response is not evidence that the browser expired.
  const p = await c.newPage();
  let identity: Inspection | undefined;
  p.on("response", async (r) => {
    const url = new URL(r.url());
    if (
      url.origin !== "https://www.douyin.com" ||
      url.pathname !== "/aweme/v1/web/user/profile/self/"
    )
      return;
    try {
      const result = interpretAccount("douyin", await r.json());
      if (["connected", "expired"].includes(result.status)) identity = result;
    } catch {}
  });
  try {
    await p.goto("https://www.douyin.com/user/self", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    for (let i = 0; i < 25; i++) {
      if (identity?.status === "connected") return identity;
      const current = await p.evaluate(() => {
        if (
          location.origin !== "https://www.douyin.com" ||
          location.pathname.replace(/\/$/, "") !== "/user/self"
        )
          return null;
        // Only the current-login store is eligible, never viewed authors or a
        // generic user cache which also exists for anonymous visitors.
        const own = (window as any).userInfoStore?.curLoginUserInfo;
        if (!own || typeof own !== "object") return null;
        return { uid: own.uid, sec_uid: own.sec_uid, nickname: own.nickname };
      });
      const stored = inspectCurrentDouyinUser(p.url(), current);
      if (stored) return stored;
      await p.waitForTimeout(500);
    }
    if (identity?.status === "expired") return identity;
    return {
      status: "unverified",
      message:
        "发现登录会话，但平台暂未确认账号。请完成窗口中的验证后重新检查。",
    };
  } catch {
    return {
      status: "error",
      message: "抖音账号检查暂未成功，请检查网络后重试。",
    };
  } finally {
    await p.close().catch(() => {});
  }
}
export function inspectCurrentDouyinUser(
  url: string,
  user: any,
): Inspection | undefined {
  const location = new URL(url);
  if (
    location.origin !== "https://www.douyin.com" ||
    location.pathname.replace(/\/$/, "") !== "/user/self"
  )
    return;
  if (
    !user ||
    !["string", "number"].includes(typeof user.uid) ||
    !/^[1-9]\d*$/.test(String(user.uid))
  )
    return;
  const result = interpretAccount("douyin", { status_code: 0, user });
  return result.status === "connected" ? result : undefined;
}
export async function openLogin(profile: string, onClosed?: () => void, onOpened?: () => void) {
  if (activeParses)
    throw new Error("视频正在解析，请等待解析结束后再打开登录窗口。");
  if (loginWindowOpen()) {
    onOpened?.();
    const p = context!.pages()[0] || (await context!.newPage());
    await p.bringToFront();
    return;
  }
  if (launching) await launching;
  if (context) await context.close();
  loginClosed = onClosed;
  const c = await browserContext(profile, true);
  onOpened?.();
  const p = c.pages()[0] || (await c.newPage());
  await p.goto("https://www.douyin.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
}
export async function forgetBrowser(profile: string) {
  if (activeParses) throw new Error("视频正在解析，请等待结束后再断开账号。");
  loginClosed = undefined;
  await closeBrowser();
  await rm(profile, { recursive: true, force: true });
  await rm(douyinBrowserProfile(profile, "msedge"), { recursive: true, force: true });
}
export async function closeBrowser() {
  loginClosed = undefined;
  if (launching) await launching.catch(() => {});
  if (context) await context.close();
}
