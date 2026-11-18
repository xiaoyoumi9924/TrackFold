import { randomUUID } from "node:crypto";

// Electron utility processes expose this private, non-network channel.
export const parentPort = (process as typeof process & { parentPort?: {
  postMessage(value: unknown): void;
  on(name: "message", listener: (event: { data: any }) => void): void;
} }).parentPort;
const waiting = new Map<string, (value: string | null) => void>();
parentPort?.on("message", ({ data }) => {
  if (data?.type === "picker-result" && typeof data.id === "string") {
    waiting.get(data.id)?.(typeof data.path === "string" ? data.path : null);
    waiting.delete(data.id);
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
