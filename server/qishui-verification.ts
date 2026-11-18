// These are protocol destinations, not user-configurable proxy targets.
export function verificationTarget(input: unknown) {
  if (typeof input !== "string") throw new Error("平台验证地址无效。");
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "api.qishui.com",
      "auth.zijieapi.com",
      "verify.zijieapi.com",
      "bff-pc.qishui.com",
    ].includes(url.hostname) ||
    !/^\/(passport|ucenter_web)\//.test(url.pathname)
  )
    throw new Error("平台验证地址不受支持。");
  return url.href;
}
export function verificationScript(input: any) {
  const raw =
    typeof input === "string"
      ? input
      : input?.host && input?.path
        ? `https://${input.host}${input.path.startsWith("/") ? "" : "/"}${input.path}`
        : "";
  const url = new URL(raw);
  const domains = [
    "qishui.com",
    "douyin.com",
    "zijieapi.com",
    "bytegoofy.com",
    "bytescm.com",
    "bytedance.com",
    "bytednsdoc.com",
    "bytetos.com",
    "yhgfb-cn-static.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !domains.some((d) => url.hostname === d || url.hostname.endsWith("." + d))
  )
    throw new Error("平台验证组件地址无效。");
  return url.href;
}
export function verificationFields(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      return verificationFields(JSON.parse(value));
    } catch {
      return Object.fromEntries(new URLSearchParams(value));
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
}

export const verificationCsp =
  "default-src 'self'; script-src 'self' https://*.qishui.com https://*.douyin.com https://*.zijieapi.com https://*.bytegoofy.com https://*.bytescm.com https://*.bytedance.com https://*.bytednsdoc.com https://*.bytetos.com https://*.yhgfb-cn-static.com; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' https://lf-ucenter-web.yhgfb-cn-static.com; frame-src https://*.qishui.com https://*.zijieapi.com https://*.douyin.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export const verificationHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>汽水账号验证</title><style>body{margin:24px;background:#f5f6f2;color:#253a32;font:14px/1.8 -apple-system,BlinkMacSystemFont,sans-serif}h1{font-size:22px}p{max-width:65ch}button{background:white;border:1px solid #d5dfd0;border-radius:8px;padding:10px 16px;color:#2f6350;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #2f6350;outline-offset:3px}#error{color:#8d421e}</style><h1>汽水账号验证</h1><p id="status" role="status">正在准备验证窗口…</p><p id="error" role="alert" hidden></p><button id="retry" hidden>重新加载验证组件</button><script src="/verification.js"></script></html>`;
