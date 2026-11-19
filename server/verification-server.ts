import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { QishuiLogin } from "./qishui-login.ts";
import { verificationCsp, verificationHtml } from "./qishui-verification.ts";

type VerificationLogin = Pick<QishuiLogin,
  "current" | "verificationSetup" | "verificationRequest" | "completeVerification">;

export function createVerificationServer(
  login: VerificationLogin,
  scriptPath: string,
  errorMessage: (error: unknown) => string,
) {
  const app = express();
  const route = "/qishui-verify/:id/:grant";
  let grant: { id: string; value: string } | undefined;
  let finishingId: string | undefined;
  let starting: Promise<Server> | undefined;
  let origin = "";
  let closing = false;

  function currentChallenge(id: string) {
    const qr = login.current();
    return !closing && finishingId !== id && qr?.id === id && qr.verificationRequired && qr.expiresAt > Date.now();
  }

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    const source = req.get("Origin");
    const site = req.get("Sec-Fetch-Site");
    if ("http://" + req.get("Host") !== origin ||
        (source && source !== origin) ||
        (req.method === "POST" && source !== origin) ||
        (site && site !== "same-origin" && site !== "none")) {
      res.status(403).json({ error: "请求来源不受支持。" });
      return;
    }
    next();
  });
  app.use(route, (req, res, next) => {
    const { id, grant: supplied } = req.params;
    if (!grant || grant.id !== id || grant.value !== supplied || !currentChallenge(id)) {
      res.status(410).json({ error: "本次账号验证已结束，请返回拾音查看状态。" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.get(route, (_, res) => {
    res.set("Content-Security-Policy", verificationCsp).type("html").send(verificationHtml);
  });
  app.get("/verification.js", (_, res) => res.sendFile(scriptPath));
  app.post(route + "/verification/setup", async (req, res) => {
    res.json(await login.verificationSetup(String(req.params.id)));
  });
  app.post(route + "/verification/request", async (req, res) => {
    res.json(await login.verificationRequest(String(req.params.id), req.body));
  });
  app.post(route + "/verification/complete", async (req, res) => {
    const id = String(req.params.id);
    grant = undefined;
    finishingId = id;
    try {
      const { phase } = await login.completeVerification(id);
      res.json({ phase });
    } finally {
      if (finishingId === id) finishingId = undefined;
    }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: errorMessage(error) });
  });

  return {
    async open(id: string) {
      if (!currentChallenge(id)) throw new Error("当前没有需要继续的账号验证。");
      starting ??= new Promise<Server>((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve(server);
        });
      }).catch(error => {
        starting = undefined;
        throw error;
      });
      await starting;
      if (!currentChallenge(id)) throw new Error("本次账号验证已结束，请返回拾音查看状态。");
      if (grant?.id !== id) grant = { id, value: randomBytes(32).toString("base64url") };
      return `${origin}/qishui-verify/${encodeURIComponent(id)}/${grant.value}`;
    },
    async close() {
      closing = true;
      grant = undefined;
      const server = await starting?.catch(() => undefined);
      if (server) {
        await new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  };
}
