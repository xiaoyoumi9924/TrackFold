import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { parentPort, desktopPicker } from "./desktop-bridge.ts";
let opened = false;
export async function chooseNative(kind: "folder" | "file", initial: string) {
  if (process.platform !== "darwin")
    throw new Error("当前系统请使用手动填写路径。");
  if (opened)
    throw Object.assign(new Error("已有一个选择窗口，请先完成或取消。"), {
      status: 409,
    });
  opened = true;
  if (parentPort) {
    try { return await desktopPicker(kind, initial); }
    finally { opened = false; }
  }
  const script = `on run argv
    try
      if item 1 of argv is "folder" then
        set selectedItem to choose folder with prompt "选择拾音的新音频保存位置" default location (POSIX file (item 2 of argv))
      else
        set selectedItem to choose file with prompt "选择这条任务原来的音频文件" default location (POSIX file (item 2 of argv))
      end if
      return POSIX path of selectedItem
    on error number -128
      return "__SHIYIN_CANCELLED__"
    end try
  end run`;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "osascript",
        ["-e", script, kind, existsSync(initial) ? initial : os.homedir()],
        { encoding: "utf8", maxBuffer: 16384 },
        (error, stdout) => {
          if (error)
            reject(
              new Error("未能打开选择窗口，请使用手动路径，或检查系统提示。"),
            );
          else resolve(stdout.replace(/\r?\n$/, ""));
        },
      );
    });
    return result === "__SHIYIN_CANCELLED__" ? null : result;
  } finally {
    opened = false;
  }
}
