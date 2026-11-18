import React from "react";
import * as ReactDOM from "react-dom";

window.React = React;
window.ReactDOM = ReactDOM;
window.ucSecondVerifyReact = React;
window.ucSecondVerifyReactDom = ReactDOM;
const id = location.pathname.split("/").at(-1);
const base = `/api/login/qishui/qr/${encodeURIComponent(id)}/verification`;
const nativeFetch = window.fetch.bind(window);
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
const errorText = document.querySelector("#error");
const setStatus = (text) => {
  status.textContent = text;
};
window.addEventListener("securitypolicyviolation", (event) => {
  let resource;
  try {
    const url = new URL(event.blockedURI);
    resource = url.origin + url.pathname;
  } catch {
    resource = event.blockedURI?.split(":", 1)[0];
  }
  console.warn(
    "Verification resource blocked",
    event.effectiveDirective,
    resource,
  );
});
async function api(action, body = {}) {
  const response = await nativeFetch(base + "/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "验证暂未完成，请重试。");
  return data;
}
const officialTarget = (url) => {
  try {
    const u = new URL(url, location.href);
    return (
      u.protocol === "https:" &&
      [
        "api.qishui.com",
        "auth.zijieapi.com",
        "verify.zijieapi.com",
        "bff-pc.qishui.com",
      ].includes(u.hostname)
    );
  } catch {
    return false;
  }
};
// The official component runs in this isolated window. Its account requests use
// the QR's server-side cookie jar, with a fixed host/path allowlist at the server.
window.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!officialTarget(url)) return nativeFetch(input, init);
  const request = new Request(input, init);
  const result = await api("request", {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: ["GET", "HEAD"].includes(request.method) ? "" : await request.text(),
  });
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType },
  });
};
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const originalHeader = XMLHttpRequest.prototype.setRequestHeader;
const requests = new WeakMap();
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  if (!officialTarget(String(url))) {
    requests.delete(this);
    return originalOpen.call(this, method, url, ...rest);
  }
  requests.set(this, { method, url: String(url), headers: {} });
  Object.defineProperty(this, "readyState", {
    configurable: true,
    get: () => 1,
  });
};
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  const request = requests.get(this);
  if (request) request.headers[name] = value;
  else originalHeader.call(this, name, value);
};
XMLHttpRequest.prototype.send = function (body) {
  const request = requests.get(this);
  if (!request) return originalSend.call(this, body);
  request.body =
    typeof body === "string"
      ? body
      : body instanceof URLSearchParams
        ? body.toString()
        : "";
  api("request", request)
    .then((result) => {
      let response = result.body;
      if (this.responseType === "json") {
        try {
          response = JSON.parse(result.body);
        } catch {
          response = null;
        }
      }
      for (const [name, value] of Object.entries({
        readyState: 4,
        status: result.status,
        responseText: result.body,
        response,
        responseURL: request.url,
      }))
        Object.defineProperty(this, name, {
          configurable: true,
          get: () => value,
        });
      this.getResponseHeader = (name) =>
        name.toLowerCase() === "content-type" ? result.contentType : null;
      this.getAllResponseHeaders = () =>
        `content-type: ${result.contentType}\r\n`;
      for (const name of ["readystatechange", "load", "loadend"])
        this.dispatchEvent(new Event(name));
    })
    .catch(() => {
      this.dispatchEvent(new Event("error"));
      this.dispatchEvent(new Event("loadend"));
    });
};
function objectValue(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value || {};
}
let started = false;
async function start() {
  if (started) return;
  started = true;
  retry.hidden = true;
  errorText.hidden = true;
  setStatus("正在加载汽水官方验证组件…");
  try {
    const setup = await api("setup");
    const decision = setup.decision;
    window.$$account_verify_portrait_id = decision.verify_portrait_id || "";
    const eventParams = objectValue(decision.event_params);
    if (typeof window.ucWebSecondVerify !== "function")
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const resource = new URL(setup.script);
        resource.searchParams.set("aid", "386088");
        resource.searchParams.set(
          "verify_reason",
          eventParams.verify_reason || "",
        );
        resource.searchParams.set(
          "verify_scene",
          eventParams.verify_scene || "",
        );
        script.src = resource.href;
        script.onload = resolve;
        script.onerror = () =>
          reject(Error("汽水验证组件未能加载，请检查网络后重试。"));
        document.head.append(script);
      });
    if (typeof window.ucWebSecondVerify !== "function")
      throw Error("平台验证组件暂不可用，请稍后重试。");
    setStatus("请在官方组件中完成验证。验证码仅用于本次汽水登录。");
    let finished = false;
    window.ucWebSecondVerify({
      ...decision,
      aid: 386088,
      isNewVerifyUI: true,
      generalParams: setup.generalParams,
      event_params: eventParams,
      newSecondVerifyWebOptions: {
        host: "https://api.qishui.com",
        verifyAppName: "汽水音乐",
      },
      newSecondVerificationCall: { reportAppLog: () => {} },
      fun:
        decision.verify_from === "verify_center" ? "verify_center" : "verify",
      uc_account_verify_version: "1.0.29",
      monitorTime: {
        startTime: Date.now(),
        fetchEndTime: Date.now(),
        scriptLoadStartTime: 0,
        scriptLoadEndTime: Date.now(),
        renderStartTime: Date.now(),
      },
      verifyFinishCallback: async (result) => {
        if (finished) return;
        if (result?.status !== true) {
          started = false;
          setStatus("验证尚未完成，可在此重试。");
          retry.hidden = false;
          return;
        }
        finished = true;
        setStatus("验证已提交，正在核对汽水登录结果…");
        try {
          const view = await api("complete");
          setStatus(
            view.qr?.phase === "confirmed"
              ? "验证已完成，请返回拾音查看账号状态。"
              : "验证已提交，请返回拾音等待汽水确认。",
          );
        } catch {
          errorText.textContent = "登录结果暂未确认，请返回拾音检查账号状态。";
          errorText.hidden = false;
        }
      },
    });
  } catch (error) {
    errorText.textContent = error.message;
    errorText.hidden = false;
    retry.hidden = false;
    started = false;
    setStatus("验证暂未完成。");
  }
}
retry.addEventListener("click", start);
void start();
