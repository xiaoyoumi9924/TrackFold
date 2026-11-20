import { spawn, execFile } from "node:child_process";
import { constants, accessSync, createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { run } from "./media.ts";
import { mediaProcessEnvironment } from "./media-environment.ts";

const model = "UVR-MDX-NET-Inst_HQ_3.onnx";
const expectedHash = "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc";
const metadataHash = "1aca8f9bcc57233bc714029663a9ec2345d9c7721f91e5e08f46392a879c6a9a";
const release = "20260127";
const runtimeRoot = path.join(
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "拾音")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "拾音")
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "拾音"),
  "separation-runtime",
);

const pythonBuilds = {
  "linux-x64": {
    archive: `cpython-3.12.12+${release}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/cpython-3.12.12%2B${release}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: "da2b48a8ba9969d57b75544b818210c5f574e86640776cd885ffc17b50c3569a",
    executable: "python/bin/python3",
  },
  "win32-x64": {
    archive: `cpython-3.12.12+${release}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/cpython-3.12.12%2B${release}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    sha256: "7c9d0edbec05c86171509ba093d7dbb7993fcc87215463b9463832e07a26b100",
    executable: "python/python.exe",
  },
} as const;
const torchWheels = {
  "linux-x64": "https://download.pytorch.org/whl/cpu/torch-2.15.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl#sha256=0955c7e3446326293f48af18fad67872fa31dee5a36a87690eb9e5be8b465be3",
  "win32-x64": "https://download.pytorch.org/whl/cpu/torch-2.15.0%2Bcpu-cp312-cp312-win_amd64.whl#sha256=5af9fb357790db09e62484b12032304f046c22c4b1895ca88c4cf5987ea369ca",
} as const;
const modelFiles = [
  {
    name: model,
    urls: [
      "https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/UVR-MDX-NET-Inst_HQ_3.onnx",
      "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx",
    ],
    sha256: expectedHash,
  },
  {
    name: "mdx_model_data.json",
    urls: ["https://raw.githubusercontent.com/TRvlvr/application_data/main/mdx_model_data/model_data_new.json"],
    sha256: metadataHash,
  },
] as const;

function buildKey() {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
}
function supportFiles() {
  const key = buildKey();
  return key ? { key, python: pythonBuilds[key], torchWheel: torchWheels[key] } : undefined;
}
function pythonCandidates(directory: string) {
  return process.platform === "win32"
    ? [path.join(directory, "python", "python.exe"), path.join(directory, "Scripts", "python.exe")]
    : [path.join(directory, "python", "bin", "python3"), path.join(directory, "bin", "python")];
}
export function separationRuntime() {
  const directory = process.env.SHIYIN_SEPARATOR_RUNTIME || runtimeRoot;
  const python = pythonCandidates(directory).find(existsSync) || pythonCandidates(directory)[0];
  const models = path.join(directory, "models");
  const modelPath = path.join(models, model);
  const metadataPath = path.join(models, "mdx_model_data.json");
  const modelPresent = existsSync(modelPath);
  const metadataPresent = existsSync(metadataPath);
  let runtimePresent = false;
  try { accessSync(python, process.platform === "win32" ? constants.F_OK : constants.X_OK); runtimePresent = true; } catch {}
  return { directory, python, models, modelPath, metadataPath, modelPresent, metadataPresent,
    runtimePresent, available: runtimePresent && modelPresent && metadataPresent };
}
function separationEnvironment() {
  const env = mediaProcessEnvironment();
  if (process.platform !== "win32") env.PATH ||= "/usr/bin:/bin";
  const ffmpeg = process.env.SHIYIN_FFMPEG_PATH;
  if (ffmpeg) env.PATH = [path.dirname(ffmpeg), env.PATH].filter(Boolean).join(path.delimiter);
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONNOUSERSITE = "1";
  return env;
}

type InstallationState = { state: "installing" | "error"; message: string };
let installationState: InstallationState | undefined;
let installationTask: Promise<void> | undefined;
let installationController: AbortController | undefined;
function runtimeDetails(runtime = separationRuntime()) {
  return {
    directory: runtime.directory,
    runtime: runtime.runtimePresent ? "已找到" : "缺少或不可执行",
    model: runtime.modelPresent ? "已找到" : "缺少",
    metadata: runtime.metadataPresent ? "已找到" : "缺少",
  };
}
function setInstallationMessage(message: string) {
  if (installationState?.state === "installing") installationState.message = message;
}

async function downloadVerified(urls: readonly string[], output: string, expected: string, label: string, signal: AbortSignal) {
  let failure: unknown;
  for (const url of urls) {
    setInstallationMessage(`正在下载${label}…`);
    try {
      signal.throwIfAborted();
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]), headers: { "User-Agent": "Shiyin separation setup" } });
      if (!response.ok || !response.body) throw new Error(`下载失败（${response.status}）。`);
      const hash = createHash("sha256");
      const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal });
      if (hash.digest("hex") !== expected) throw new Error(`${label} 校验失败，已停止安装。`);
      return;
    } catch (error) {
      await rm(output, { force: true });
      failure = error;
    }
  }
  throw failure instanceof Error ? failure : new Error(`${label}下载失败，请检查网络后重试。`);
}

function runInstallerProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { output = (output + String(chunk)).slice(-5000); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(output.trim() || `${command} 执行失败。`)));
  });
}

async function installRuntime(signal: AbortSignal) {
  const support = supportFiles();
  if (!support) throw new Error("目前可自动配置人声分离组件的系统是 Windows x64 和 Linux x64。");
  const destination = process.env.SHIYIN_SEPARATOR_RUNTIME || runtimeRoot;
  const customDestination = !!process.env.SHIYIN_SEPARATOR_RUNTIME;
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const backup = !customDestination && existsSync(destination) ? `${destination}.backup-${randomUUID()}` : undefined;
  if (customDestination && existsSync(destination))
    throw new Error("检测到已有的人声分离组件目录。请移除不完整的自定义目录后再安装。");
  if (backup) await rename(destination, backup);
  let stage: string | undefined;
  let published = false;
  const env = separationEnvironment();
  try {
    stage = await mkdtemp(path.join(parent, ".shiyin-separation-install-"));
    const archivePath = path.join(stage, support.python.archive);
    await downloadVerified([support.python.url], archivePath, support.python.sha256, "Python 运行环境", signal);
    setInstallationMessage("正在展开 Python 运行环境…");
    await runInstallerProcess("tar", ["-xzf", archivePath, "-C", stage], stage, env, signal);
    await rm(archivePath, { force: true });

    const python = path.join(stage, support.python.executable);
    if (!existsSync(python)) throw new Error("下载的 Python 环境结构不完整。");
    setInstallationMessage("正在安装人声分离运行依赖（首次配置需要一些时间）…");
    await runInstallerProcess(python, ["-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", support.torchWheel], stage, env, signal);
    await runInstallerProcess(python, ["-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "audio-separator[cpu]==0.48.0", "onnxruntime==1.32.0"], stage, env, signal);

    const models = path.join(stage, "models");
    mkdirSync(models, { recursive: true, mode: 0o700 });
    for (const file of modelFiles)
      await downloadVerified(file.urls, path.join(models, file.name), file.sha256, file.name === model ? "分离模型" : "模型配置", signal);
    setInstallationMessage("正在检查人声分离组件…");
    await promisify(execFile)(python, ["-c", "from audio_separator.utils.cli import main; from audio_separator.separator import Separator; import onnxruntime, torch"], { env, signal, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    JSON.parse(await readFile(path.join(models, "mdx_model_data.json"), "utf8"));

    if (existsSync(destination)) throw new Error("人声分离组件目录已出现，未覆盖现有文件。");
    await rename(stage, destination);
    published = true;
    const installed = await checkSeparationRuntime(true);
    if (!installed.available) throw new Error(installed.message);
    if (backup) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (published) await rm(destination, { recursive: true, force: true });
    if (backup && existsSync(backup) && !existsSync(destination)) await rename(backup, destination);
    throw error;
  }
}

export async function startSeparationInstallation() {
  if (!supportFiles()) throw new Error("目前可自动配置人声分离组件的系统是 Windows x64 和 Linux x64。");
  if (installationTask) return { state: "installing", message: installationState?.message || "正在准备人声分离组件…" };
  const current = await checkSeparationRuntime();
  if (current.available) return { state: "available", message: "人声分离组件已就绪。" };
  if (installationTask) return { state: "installing", message: installationState?.message || "正在准备人声分离组件…" };
  installationState = { state: "installing", message: "正在准备人声分离组件…" };
  installationController = new AbortController();
  installationTask = installRuntime(installationController.signal)
    .then(() => { installationState = undefined; })
    .catch(error => {
      const detail = error instanceof Error ? error.message : "组件安装失败。";
      installationState = { state: "error", message: `安装失败：${detail.replace(/https?:\/\/[^\s]+/g, "[下载地址]").slice(0, 500)}` };
    })
    .finally(() => { installationTask = undefined; installationController = undefined; });
  return { state: "installing", message: installationState.message };
}

export function separationInstallationBusy() {
  return !!installationTask;
}

export function cancelSeparationInstallation() {
  installationController?.abort();
  return installationTask;
}

export async function checkSeparationRuntime(verifyDuringInstall = false) {
  const runtime = separationRuntime();
  const details = runtimeDetails(runtime);
  const installable = !!supportFiles();
  if (installationState?.state === "installing" && !verifyDuringInstall)
    return { available: false, state: "installing", details, installable, message: installationState.message };
  if (!runtime.runtimePresent)
    return { available: false, state: "missing-runtime", details, installable, message: installationState?.message || (installable ? "人声分离组件尚未安装。" : "当前系统没有可自动配置的人声分离组件。") };
  if (!runtime.modelPresent || !runtime.metadataPresent)
    return { available: false, state: "missing-model", details, installable, message: installationState?.message || "缺少模型或模型配置。" };
  try {
    const config = JSON.parse(await readFile(runtime.metadataPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid metadata");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(runtime.modelPath)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== expectedHash) {
      details.model = "校验失败";
      return { available: false, state: "error", details, installable, message: "人声分离模型校验失败，请更换完整模型。" };
    }
    details.model = "已校验";
    details.metadata = "可读取";
  } catch {
    return { available: false, state: "error", details, installable, message: "模型或配置无法读取，请重新检查本机组件。" };
  }
  try {
    await promisify(execFile)(runtime.python, ["-c", "from audio_separator.utils.cli import main; from audio_separator.separator import Separator; import onnxruntime"], { env: separationEnvironment(), timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
    details.runtime = "可用";
    return { available: true, state: "available", details, installable: false, message: "人声分离可用。" };
  } catch {
    details.runtime = "启动失败";
    return { available: false, state: "error", details, installable, message: installationState?.message || "运行组件无法启动，请重新安装人声分离组件。" };
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
      env: separationEnvironment(),
      signal,
      windowsHide: true,
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
