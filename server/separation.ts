import { spawn, execFile } from "node:child_process";
import { constants, accessSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { run } from "./media.ts";

const model = "UVR-MDX-NET-Inst_HQ_3.onnx";
const expectedHash = "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc";
export function separationRuntime() {
  const directory =
    process.env.SHIYIN_SEPARATOR_RUNTIME ||
    path.join(
      os.homedir(),
      "Library/Application Support/拾音/separation-runtime",
    );
  const python = path.join(directory, "bin/python"),
    models = path.join(directory, "models");
  const modelPath = path.join(models, model);
  const metadataPath = path.join(models, "mdx_model_data.json");
  const modelPresent = existsSync(modelPath);
  const metadataPresent = existsSync(metadataPath);
  let runtimePresent = false;
  try { accessSync(python, constants.X_OK); runtimePresent = true; } catch {}
  return { directory, python, models, modelPath, metadataPath, runtimePresent, modelPresent, metadataPresent,
    available: runtimePresent && modelPresent && metadataPresent };
}
export async function checkSeparationRuntime() {
  const runtime = separationRuntime();
  const details = {
    directory: runtime.directory,
    runtime: runtime.runtimePresent ? "已找到" : "缺少或不可执行",
    model: runtime.modelPresent ? "已找到" : "缺少",
    metadata: runtime.metadataPresent ? "已找到" : "缺少",
  };
  if (!runtime.runtimePresent)
    return { available: false, state: "missing-runtime", details, message: "缺少人声分离运行组件。" };
  if (!runtime.modelPresent || !runtime.metadataPresent)
    return { available: false, state: "missing-model", details, message: "缺少模型或模型配置。" };
  try {
    const config = JSON.parse(await readFile(runtime.metadataPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid metadata");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(runtime.modelPath)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== expectedHash) {
      details.model = "校验失败";
      return { available: false, state: "error", details, message: "人声分离模型校验失败，请更换完整模型。" };
    }
    details.model = "已校验";
    details.metadata = "可读取";
  } catch {
    return { available: false, state: "error", details, message: "模型或配置无法读取，请重新检查本机组件。" };
  }
  try {
    await promisify(execFile)(runtime.python, ["-c", "from audio_separator.utils.cli import main; from audio_separator.separator import Separator; import onnxruntime"], { timeout: 30000, maxBuffer: 1024 * 1024 });
    details.runtime = "可用";
    return { available: true, state: "available", details, message: "人声分离可用。" };
  } catch {
    details.runtime = "启动失败";
    return { available: false, state: "error", details, message: "运行组件无法启动，请检查 Python 和依赖。" };
  }
}
export async function separate(
  source: string,
  outputDir: string,
  signal: AbortSignal,
) {
  const runtime = separationRuntime();
  if (!runtime.available)
    throw new Error("本机尚未准备人声分离组件，请先完成组件安装。");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const decoded = path.join(outputDir, "source.wav");
  await run(
    "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s16le",
      decoded,
    ],
    signal,
  );
  const ffmpeg = process.env.SHIYIN_FFMPEG_PATH;
  const env = {
    ...process.env,
    PATH: `${ffmpeg ? path.dirname(ffmpeg) + path.delimiter : ""}${process.env.PATH || "/usr/bin:/bin"}`,
    PYTHONUNBUFFERED: "1",
  };
  const args = [
    "-c",
    "from audio_separator.utils.cli import main; main()",
    decoded,
    "--model_filename",
    model,
    "--model_file_dir",
    runtime.models,
    "--output_dir",
    outputDir,
    "--output_format",
    "WAV",
    "--custom_output_names",
    JSON.stringify({ Vocals: "vocals", Instrumental: "instrumental" }),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(runtime.python, args, {
      env,
      signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              signal.aborted
                ? "分离已取消。"
                : `人声分离未完成，请检查组件或更换音频。${stderr.includes("out of memory") ? " 设备内存不足。" : ""}`,
            ),
          ),
    );
  });
  const vocals = path.join(outputDir, "vocals.wav"),
    instrumental = path.join(outputDir, "instrumental.wav");
  if (!existsSync(vocals) || !existsSync(instrumental))
    throw new Error("分离结果不完整，请重试。");
  return { vocals, instrumental };
}
