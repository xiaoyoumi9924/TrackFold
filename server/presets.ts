import path from "node:path";
import { exportFormats, type ExportPreset } from "../shared/preferences.ts";
import { librarySettings } from "./library.ts";

export function validatePreset(value: unknown, id: string): ExportPreset {
  const input = value as ExportPreset | undefined;
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 60 || /[\u0000-\u001f]/.test(label)) throw new Error("请输入 1 至 60 字的预设名称。");
  if (!input || !Object.hasOwn(exportFormats, input.format)) throw new Error("请选择有效的导出格式。");
  const directory = input.directory;
  if (typeof directory !== "string" || directory.includes("\0") || directory.length > 4096 || (directory && !path.isAbsolute(directory)))
    throw new Error("预设目录需要填写完整路径。");
  return { ...librarySettings(input), id, label, format: input.format, directory };
}
