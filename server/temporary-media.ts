import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

const staleAfter = 24 * 60 * 60 * 1000;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const legacyScratch = new RegExp(`^(?:${uuid}|separate-${uuid}|试听-[A-Za-z0-9]{6})$`);
const legacyFile = new RegExp(`^(?:[a-f0-9]{32}|wave-${uuid}\\.jpg|${uuid}-(?:audio|video|result\\.mp4))$`);

export function reportLocalFailure(operation: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  console.warn(code ? `${operation}（${code}）` : operation);
}

export async function removeTemporary(file: string, recursive = false) {
  try {
    await rm(file, { force: true, recursive });
  } catch (error) {
    reportLocalFailure("临时文件未能清理", error);
  }
}

function processExited(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function clearStaleMedia(directory: string) {
  try {
    if (!(await lstat(directory)).isDirectory()) return;
    const cutoff = Date.now() - staleAfter;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const session = /^run-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
      const ownedDirectory = entry.isDirectory() && (session ? processExited(Number(session[1])) : legacyScratch.test(entry.name));
      if (!ownedDirectory && !(entry.isFile() && legacyFile.test(entry.name))) continue;
      const file = path.join(directory, entry.name);
      try {
        const info = await lstat(file);
        if (info.mtimeMs < cutoff && (ownedDirectory ? info.isDirectory() : info.isFile()))
          await removeTemporary(file, ownedDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          reportLocalFailure("无法检查临时文件", error);
      }
    }
  } catch (error) {
    reportLocalFailure("无法扫描临时文件目录", error);
  }
}
