import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

type BrowserName = "chrome" | "msedge";
type Candidate = { name: BrowserName | "chromium"; executablePath: string };

function brandedPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string) {
  if (platform === "win32") {
    const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA];
    const paths = (relative: string) => roots.filter((root): root is string => !!root && path.win32.isAbsolute(root))
      .map(root => path.win32.join(root, relative));
    return {
      msedge: paths("Microsoft\\Edge\\Application\\msedge.exe"),
      chrome: paths("Google\\Chrome\\Application\\chrome.exe"),
    };
  }
  if (platform === "darwin") {
    const paths = (name: string) => ["/Applications", path.join(home, "Applications")]
      .map(root => path.join(root, `${name}.app`, "Contents", "MacOS", name));
    return { chrome: paths("Google Chrome"), msedge: paths("Microsoft Edge") };
  }
  return {
    chrome: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
    msedge: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"],
  };
}

export function douyinBrowsers(platform = process.platform, env = process.env, home = os.homedir(), exists: (executable: string) => boolean = existsSync): Candidate[] {
  const paths = brandedPaths(platform, env, home);
  const order: BrowserName[] = platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  const candidates: Candidate[] = order.flatMap(name => {
    const executablePath = paths[name].find(exists);
    return executablePath ? [{ name, executablePath }] : [];
  });
  const executablePath = chromium.executablePath();
  if (exists(executablePath)) candidates.push({ name: "chromium", executablePath });
  return candidates;
}

export function douyinBrowserProfile(profile: string, name: Candidate["name"]) {
  // Chrome and the development Chromium previously used the original profile.
  return name === "msedge" ? `${profile}-edge` : profile;
}

export async function launchDouyinBrowser(profile: string, show: boolean, candidates = douyinBrowsers()): Promise<BrowserContext> {
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      return await chromium.launchPersistentContext(douyinBrowserProfile(profile, candidate.name), {
        headless: !show,
        executablePath: candidate.executablePath,
        viewport: { width: 1280, height: 850 },
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw new Error("未能启动抖音解析浏览器。请检查 Chrome 或 Edge 是否能正常打开，再重试。", { cause: failure });
  throw new Error("未找到 Google Chrome 或 Microsoft Edge。请安装其中一个浏览器后重试。");
}
