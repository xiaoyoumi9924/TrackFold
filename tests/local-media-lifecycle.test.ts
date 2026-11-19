import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { Job } from "../shared/types.ts";

function wav() {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 320; attempt++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Expected state was not reached");
}

test("local media survives concurrent recovery and cache pressure, and damaged records do not block startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiyin-lifecycle-"));
  const data = path.join(root, "data");
  const output = path.join(root, "output");
  const temp = path.join(data, "temp");
  await mkdir(temp, { recursive: true });
  const oldUpload = path.join(temp, "a".repeat(32));
  const recentUpload = path.join(temp, "b".repeat(32));
  const otherFile = path.join(temp, "keep.txt");
  const liveDirectory = path.join(temp, `run-${process.pid}-abcdef`);
  await mkdir(liveDirectory);
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const file of [oldUpload, recentUpload, otherFile]) await writeFile(file, "fixture");
  for (const file of [liveDirectory, oldUpload, otherFile]) await utimes(file, oldTime, oldTime);

  const sample = wav();
  const sourceId = createHash("sha256").update(sample).digest("hex");
  const dbFile = path.join(data, "tasks.sqlite");
  const db = new DatabaseSync(dbFile);
  const recoveryIds = ["recovery-a", "recovery-b"];
  for (const table of ["jobs", "video_jobs", "batches", "pending_outputs"]) {
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run("damaged", "{");
  }
  for (const id of recoveryIds) {
    const job: Job = {
      id, title: id, artist: "", platform: "local", status: "failed", progress: 0,
      message: "等待恢复", interrupted: true, format: "mp3", createdAt: new Date().toISOString(),
      completeness: "full", sourceId, outputDir: output,
    };
    db.prepare("INSERT INTO jobs VALUES (?,?)").run(id, JSON.stringify(job));
    db.prepare("INSERT INTO pending_outputs VALUES (?,?)").run(id, "null");
  }
  db.close();

  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts", "--production"], {
    env: { ...process.env, PORT: "0", SHIYIN_ACCESS_TOKEN: "", SHIYIN_APP_ROOT: process.cwd(), SHIYIN_DATA_DIR: data, SHIYIN_OUTPUT_DIR: output },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let address = "", stderr = "", startup = "";
  child.stdout.on("data", chunk => {
    startup += String(chunk);
    address ||= startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] || "";
  });
  child.stderr.on("data", chunk => { stderr += String(chunk); });

  try {
    await until(() => {
      assert.equal(child.exitCode, null, stderr);
      return !!address;
    });
    async function request(route: string, value?: unknown, method = value === undefined ? "GET" : "POST") {
      const response = await fetch(address + route, {
        method,
        headers: value instanceof FormData ? undefined : { "content-type": "application/json" },
        body: value instanceof FormData ? value : value === undefined ? undefined : JSON.stringify(value),
        signal: AbortSignal.timeout(8000),
      });
      return { status: response.status, body: await response.json() };
    }
    async function upload() {
      const form = new FormData();
      form.set("file", new Blob([Uint8Array.from(sample)], { type: "audio/wav" }), "source.wav");
      const response = await request("/api/upload", form);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.token as string;
    }
    const jobs = async () => (await request("/api/jobs")).body as Job[];

    assert.deepEqual((await jobs()).map(job => job.id).sort(), recoveryIds);
    assert.deepEqual((await request("/api/videos")).body, []);
    assert.deepEqual((await request("/api/batches")).body, []);
    await until(() => !existsSync(oldUpload));
    assert.ok([otherFile, recentUpload, liveDirectory].every(existsSync));
    assert.equal((await request("/api/queue", { paused: true })).status, 200);

    const runName = (await readdir(temp)).find(name => name.startsWith(`run-${child.pid}-`));
    assert.ok(runName);
    const run = path.join(temp, runName);
    const token = await upload();
    const [claimedFile] = await readdir(run);
    assert.ok(claimedFile);
    const attempts = await Promise.all(recoveryIds.map(id => request(`/api/recovery/${id}/file`, { token })));
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
    const recovered = attempts.find(result => result.status === 200)!.body as Job;
    assert.equal((await request(`/api/uploads/${token}`, undefined, "DELETE")).status, 409);

    const oldest = await upload();
    const oldFile = (await readdir(run)).find(name => name !== claimedFile)!;
    for (let group = 0; group < 10; group++)
      await Promise.all(Array.from({ length: 10 }, () => upload()));
    await until(() => !existsSync(path.join(run, oldFile)));
    assert.ok(existsSync(path.join(run, claimedFile)));
    assert.equal((await request("/api/jobs", { token: oldest, format: "mp3" })).status, 400);

    // Simulate a per-task scratch creation failure while leaving the rest of the queue usable.
    await writeFile(path.join(run, recovered.id), "scratch directory collision");
    const other = await upload();
    const admitted = await request("/api/jobs", { token: other, format: "wav" });
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
    assert.equal((await request("/api/queue", { paused: false })).status, 200);
    await until(async () => (await jobs()).some(job => job.id === admitted.body.id && job.status === "completed"));
    assert.equal((await jobs()).find(job => job.id === recovered.id)?.status, "failed");
    await until(() => !existsSync(path.join(run, claimedFile)));
    const retained = new DatabaseSync(dbFile, { readOnly: true });
    try {
      for (const table of ["jobs", "video_jobs", "batches", "pending_outputs"])
        assert.equal(retained.prepare(`SELECT value FROM ${table} WHERE id=?`).get("damaged")?.value, "{");
    } finally {
      retained.close();
    }

    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.ok(!existsSync(run));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
