import { randomUUID } from "node:crypto";

// Electron utility processes expose this private, non-network channel.
export const parentPort = (process as typeof process & { parentPort?: {
  postMessage(value: unknown): void;
  on(name: "message", listener: (event: { data: any }) => void): void;
} }).parentPort;
const waiting = new Map<string, (value: string | null) => void>();
const opening = new Map<string, (error?: string) => void>();
parentPort?.on("message", ({ data }) => {
  if (data?.type === "picker-result" && typeof data.id === "string") {
    waiting.get(data.id)?.(typeof data.path === "string" ? data.path : null);
    waiting.delete(data.id);
  }
  if (data?.type === "open-path-result" && typeof data.id === "string") {
    opening.get(data.id)?.(typeof data.error === "string" ? data.error : undefined);
    opening.delete(data.id);
  }
});
export function desktopPicker(kind: "file" | "folder", initial: string) {
  return new Promise<string | null>((resolve) => {
    const id = randomUUID();
    waiting.set(id, resolve);
    parentPort!.postMessage({ type: "picker", id, kind, initial });
  });
}
export function openVerificationWindow(url: string) {
  parentPort?.postMessage({type:"qishui-verification",url});
}
export function desktopOpenPath(action: "folder" | "reveal", file: string) {
  return new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    opening.set(id, error => error ? reject(new Error(error)) : resolve());
    parentPort!.postMessage({ type: "open-path", id, action, file });
  });
}
