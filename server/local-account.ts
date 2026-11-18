import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export function readLocalQishuiCookie(files?: string[]) {
  const base = path.join(os.homedir(), "Library");
  const candidates = [
    path.join(
      base,
      "Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Cookies",
    ),
    path.join(
      base,
      "Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Network/Cookies",
    ),
    path.join(base, "Application Support/SodaMusic/Network/Cookies"),
    path.join(base, "Application Support/SodaMusic/Cookies"),
  ];
  let found = false;
  let denied = false;
  for (const file of files || candidates) {
    let db: DatabaseSync | undefined;
    try {
      const fd = openSync(file, "r");
      closeSync(fd);
      found = true;
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db
        .prepare(
          "SELECT name,value,host_key,expires_utc FROM cookies WHERE name IN ('sessionid','sessionid_ss','sid_tt','sid_guard','passport_csrf_token','ttwid','uid_tt','uid_tt_ss') AND value != ''",
        )
        .all();
      const values = new Map<string, string>();
      for (const row of rows) {
        const host = String(row.host_key).replace(/^\./, "");
        if (
          !["qishui.com", "douyin.com"].some(
            (d) => host === d || host.endsWith("." + d),
          )
        )
          continue;
        const expiry = Number(row.expires_utc);
        if (expiry > 0 && expiry / 1e6 - 11644473600 < Date.now() / 1000)
          continue;
        const value = String(row.value);
        if (
          !/[\r\n\x00]/.test(value) &&
          (!values.has(String(row.name)) || host.endsWith("qishui.com"))
        )
          values.set(String(row.name), value);
      }
      if (values.has("sessionid"))
        return [...values]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(String((error as any)?.code)))
        denied = true;
    } finally {
      db?.close();
    }
  }
  throw Object.assign(
    new Error(
      denied
        ? "macOS 未授权读取汽水 App 的私有目录。请使用“扫码登录汽水”连接，无需读取客户端数据；汽水 App 原有登录不受影响。"
        : found
          ? "客户端登录信息已加密、过期或暂不可读。请先在汽水客户端确认登录，或手动填写 sessionid。"
          : "未找到汽水客户端登录信息。请先在汽水音乐中登录，或手动填写 sessionid。",
    ),
    {
      code: denied
        ? "QISHUI_PERMISSION_DENIED"
        : found
          ? "QISHUI_LOCAL_ENCRYPTED"
          : "QISHUI_LOCAL_MISSING",
    },
  );
}
