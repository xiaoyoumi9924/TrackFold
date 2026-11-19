import type { AudioMetadata, LibrarySettings } from "./types.ts";

export type DesktopAction =
  | { type: "settings" }
  | { type: "paste"; text: string }
  | { type: "timer"; deadline: number | null }
  | { type: "stop-playback" };

export type ExportFormat = "mp3" | "m4a" | "wav" | "original";
export type ExportOptions = LibrarySettings & { format: ExportFormat; directory: string };
export type ExportPreset = ExportOptions & { id: string; label: string };
export const exportFormats: Record<ExportFormat, string> = { mp3: "MP3", m4a: "M4A", wav: "WAV", original: "保留来源音轨" };
export const presetExamples: ExportPreset[] = [
  { id: "example-listening", label: "日常听歌", format: "mp3", naming: "artist-title", embedCover: true, directory: "" },
  { id: "example-editing", label: "剪辑素材", format: "wav", naming: "title", embedCover: false, directory: "" },
];
export function outputTitle(metadata: AudioMetadata, naming: LibrarySettings["naming"]) {
  if (!metadata.artist || metadata.artist === "本地文件") return metadata.title;
  if (naming === "artist-title") return `${metadata.artist} - ${metadata.title}`;
  if (naming === "title-artist") return `${metadata.title} - ${metadata.artist}`;
  return metadata.title;
}

export function titlePart(title: string) {
  const sanitized = title.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "audio";
  const safe = /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])(?:\.|$)/i.test(sanitized) ? `_${sanitized}` : sanitized;
  const encoder = new TextEncoder();
  let result = "", length = 0;
  for (const char of safe) {
    length += encoder.encode(char).length;
    if (length > 180) break;
    result += char;
  }
  return result;
}
export function actualExtension(format: string, sourceFormat?: string) {
  if (format !== "original") return format;
  const codec = sourceFormat?.toLowerCase();
  return codec === "flac" || codec === "mp3" ? codec : "m4a";
}
