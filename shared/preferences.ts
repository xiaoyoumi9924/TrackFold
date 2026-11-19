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
const wavCopyCodecs = new Set([
  "pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s64le", "pcm_f32le", "pcm_f64le",
  "pcm_alaw", "pcm_mulaw", "adpcm_ms", "adpcm_ima_wav",
]);
const sourceContainers = new Map([
  ["mp3", "mp3"], ["flac", "flac"], ["aac", "m4a"], ["alac", "m4a"],
  ["opus", "opus"], ["vorbis", "ogg"],
]);
export const originalTranscodeNote = "此音轨将转码为 M4A（AAC 192 kbps）。";
export function originalAudioOutput(sourceCodec?: string) {
  const codec = sourceCodec?.toLowerCase() || "";
  const direct = wavCopyCodecs.has(codec) ? "wav" : sourceContainers.get(codec);
  return { extension: direct || "m4a", copy: !!direct };
}
export function actualExtension(format: string, sourceFormat?: string) {
  return format === "original" ? originalAudioOutput(sourceFormat).extension : format;
}
export function supportsAttachedCover(extension: string) {
  return ["mp3", "m4a", "flac"].includes(extension);
}
export function originalAudioNote(codec?: string, embedCover = false) {
  if (!codec) return "保存时检测实际音轨，无法直接复制时将转码为 M4A（AAC 192 kbps）。";
  const output = originalAudioOutput(codec);
  if (!output.copy) return originalTranscodeNote;
  const cover = embedCover && !supportsAttachedCover(output.extension) ? " 此格式的导出文件不附带封面。" : "";
  return `输出为 ${output.extension.toUpperCase()}，原样复制音轨。${cover}`;
}
