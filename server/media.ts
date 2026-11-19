import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioMetadata, ClipRange } from "../shared/types.ts";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { platformFetch } from "./providers.ts";
export function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
  onLine?: (text: string) => void,
  captureStderr = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable =
      command === "ffmpeg"
        ? process.env.SHIYIN_FFMPEG_PATH || command
        : command === "ffprobe"
          ? process.env.SHIYIN_FFPROBE_PATH || command
          : command;
    const p = spawn(executable, args, {
      signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
      onLine?.(d.toString());
    });
    p.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-6000);
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(captureStderr ? err : out)
        : reject(
            new Error(
              signal?.aborted
                ? "任务已取消"
                : err.slice(-1500) || `${command} 无法运行`,
            ),
          ),
    );
  });
}
export async function probe(file: string, signal?: AbortSignal) {
  const data = JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ],
      signal,
    ),
  );
  const audio = data.streams?.find((s: any) => s.codec_type === "audio");
  if (!audio) throw new Error("文件中没有可提取的音轨。");
  return {
    duration: Number(data.format?.duration || audio.duration || 0),
    codec: audio.codec_name,
    size: Number(data.format?.size || 0),
    tags: Object.fromEntries(
      Object.entries({ ...data.format?.tags, ...audio.tags }).map(
        ([key, value]) => [key.toLowerCase(), String(value)],
      ),
    ),
    attachedPicture: data.streams?.some(
      (s: any) => s.codec_type === "video" && s.disposition?.attached_pic === 1,
    ) as boolean,
  };
}
export async function download(
  url: string,
  dest: string,
  signal: AbortSignal,
  progress: (n: number) => void,
  headers?: Record<string, string>,
  maxBytes = 1024 * 1024 * 1024,
) {
  const r = await platformFetch(url, { signal, headers });
  if (!r.body) throw new Error("平台返回空文件。");
  const total = Number(r.headers.get("content-length"));
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        return cb(new Error(`资源大小超过 ${maxBytes / 1024 / 1024} MB 上限。`));
      if (total) progress(Math.min(70, (bytes / total) * 70));
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(r.body as any),
    counter,
    createWriteStream(dest),
    { signal },
  );
  if (bytes === 0) throw new Error("平台未返回音频内容。");
}
export async function convert(
  input: string,
  output: string,
  format: string,
  title: string,
  duration: number,
  signal: AbortSignal,
  progress: (n: number) => void,
  preserve = false,
  options: {
    metadata?: AudioMetadata;
    artwork?: string;
    clip?: ClipRange;
    loudnessFilter?: string;
  } = {},
) {
  const info = await probe(input, signal);
  let codec: string[];
  if (format === "wav") codec = ["-c:a", "pcm_s16le"];
  else if (
    preserve &&
    !options.clip && !options.loudnessFilter &&
    ((format === "mp3" && info.codec === "mp3") ||
      (format === "flac" && info.codec === "flac"))
  )
    codec = ["-c:a", "copy"];
  else if (format === "mp3") codec = ["-c:a", "libmp3lame", "-q:a", "2"];
  else if (format === "flac") codec = ["-c:a", "flac"];
  else if (!options.clip && !options.loudnessFilter && ["aac", "alac"].includes(info.codec))
    codec = ["-c:a", "copy"];
  else codec = ["-c:a", "aac", "-b:a", "192k"];
  const filters: string[] = [];
  if (options.clip) {
    const c = options.clip;
    filters.push(`atrim=start=${c.start}:end=${c.end}`, "asetpts=PTS-STARTPTS");
    if (c.fadeIn) filters.push(`afade=t=in:st=0:d=${c.fadeIn}`);
    if (c.fadeOut)
      filters.push(
        `afade=t=out:st=${c.end - c.start - c.fadeOut}:d=${c.fadeOut}`,
      );
  }
  if (options.loudnessFilter) filters.push(options.loudnessFilter);
  const metadata = options.metadata || { title, artist: "" };
  const artwork = options.artwork && format !== "wav";
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
      input,
      ...(artwork
        ? [
            "-i",
            options.artwork!,
            "-map",
            "0:a:0",
            "-map",
            "1:v:0",
            "-c:v",
            "mjpeg",
            "-disposition:v:0",
            "attached_pic",
          ]
        : ["-map", "0:a:0", "-vn"]),
      ...(filters.length ? ["-af", filters.join(",")] : []),
      ...codec,
      ...(options.loudnessFilter ? ["-ar", "44100"] : []),
      ...Object.entries(metadata).flatMap(([key, value]) => [
        "-metadata",
        `${key}=${value || ""}`,
      ]),
      ...(options.clip ? ["-metadata", "lyrics="] : []),
      "-progress",
      "pipe:1",
      output,
    ],
    signal,
    (text) => {
      const n = text.match(/out_time_us=(\d+)/);
      if (n && duration)
        progress(
          75 +
            Math.min(
              20,
              (Number(n[1]) /
                1e6 /
                (options.clip
                  ? options.clip.end - options.clip.start
                  : duration)) *
                20,
            ),
        );
    },
  );
  return probe(output, signal);
}

// Artwork is decoded locally; FFmpeg never opens a remote URL.
export async function prepareArtwork(
  url: string | undefined,
  source: string,
  scratch: string,
  signal: AbortSignal,
) {
  let input = source;
  if ((await probe(source, signal)).attachedPicture) {
    input = source;
  } else if (url) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const response = await platformFetch(url, { signal: requestSignal });
    if (!/^image\//i.test(response.headers.get("content-type") || ""))
      throw new Error("封面不是图片");
    if (!response.body) throw new Error("封面为空");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 5 * 1024 * 1024) throw new Error("封面超过 5 MB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    input = path.join(scratch, "artwork-source");
    await writeFile(input, Buffer.concat(chunks));
  } else return undefined;
  const output = path.join(scratch, "cover.jpg");
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
      input,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=500:-2",
      output,
    ],
    signal,
  );
  return output;
}
