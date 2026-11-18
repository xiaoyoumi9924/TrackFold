import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportLibrary } from "../server/library-export.ts";
import type { Job } from "../shared/types.ts";

test("exports selected existing files in order, without overwriting, and rejects missing files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shiyin-export-"));
  try {
    const first = path.join(dir, "第一首.wav"), second = path.join(dir, "第二首.wav");
    await writeFile(first, "first"); await writeFile(second, "second");
    const create = (id: string, filePath: string, title: string): Job => ({id, filePath, title, artist: "歌手", platform:"local", status:"completed", progress:100, message:"", format:"wav", createdAt:new Date().toISOString(), completeness:"full", duration:5.9});
    const jobs = new Map([["a", create("a",first,"一首")], ["b", create("b",second,"二首\n#危险")]]);
    const playlist = await exportLibrary(["b", "a"], "m3u8", jobs, dir, dir);
    const value = await readFile(playlist.filePath, "utf8");
    assert.match(value, /^#EXTM3U\n/);
    assert(value.indexOf(second) < value.indexOf(first));
    assert(value.includes("#EXTINF:5,歌手 - 二首 #危险\n"));
    const another = await exportLibrary(["a"], "m3u8", jobs, dir, dir);
    assert.notEqual(playlist.filePath, another.filePath);
    assert.equal(await readFile(playlist.filePath, "utf8"), value);
    const list = await exportLibrary(["a"], "txt", jobs, dir, dir);
    assert.match(await readFile(list.filePath, "utf8"), /歌手 - 一首.*第一首.wav/);
    const before = await readdir(dir);
    await rm(first);
    await assert.rejects(exportLibrary(["a", "b"], "m3u8", jobs, dir, dir), /文件不可用/);
    assert.deepEqual((await readdir(dir)).sort(), before.filter(x => x !== "第一首.wav").sort());
    await assert.rejects(exportLibrary(["b", "b"], "m3u8", jobs, dir, dir), /不得重复/);
    await assert.rejects(exportLibrary(["b"], "invalid", jobs, dir, dir), /格式无效/);
    jobs.set("x", create("x", path.join(dir, "bad\nname.wav"), "异常"));
    await assert.rejects(exportLibrary(["x"], "m3u8", jobs, dir, dir), /换行/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test("share folder has movable relative playlist, collision-safe copies and refuses changed sources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shiyin-bundle-"));
  try {
    const { mkdir, rename } = await import("node:fs/promises");
    const { checksum } = await import("../server/storage.ts");
    const left = path.join(dir, "left"), right = path.join(dir, "right");
    await mkdir(left); await mkdir(right);
    const first = path.join(left, "相同.mp3"), second = path.join(right, "相同.mp3");
    await writeFile(first, "first audio"); await writeFile(second, "second audio");
    const make = (id: string, filePath: string): Job => ({id,filePath,title:id,artist:"歌手",platform:"local",status:"completed",progress:100,message:"",format:"mp3",createdAt:new Date().toISOString(),completeness:"full",duration:3});
    const a=make("a",first), b=make("b",second); a.checksum=await checksum(first); b.checksum=await checksum(second);
    const jobs=new Map([["a",a],["b",b]]);
    const out=await exportLibrary(["b","a"],"bundle",jobs,dir,dir);
    const lines=(await readFile(path.join(out.filePath,"播放列表.m3u8"),"utf8")).split("\n").filter(line=>line.startsWith("./"));
    assert.equal(lines.length,2);assert.notEqual(lines[0],lines[1]);
    assert.equal(await readFile(path.join(out.filePath,lines[0]),"utf8"),"second audio");
    assert.equal(await readFile(path.join(out.filePath,lines[1]),"utf8"),"first audio");
    const moved=path.join(dir,"moved");await rename(out.filePath,moved);
    assert.equal(await readFile(path.join(moved,lines[0]),"utf8"),"second audio");
    const another=await exportLibrary(["a"],"bundle",jobs,dir,dir); assert.notEqual(another.filePath,moved);
    await writeFile(first,"changed audio");
    const before=(await readdir(dir)).sort();
    await assert.rejects(exportLibrary(["a"],"bundle",jobs,dir,dir),/音频内容已改变/);
    assert.deepEqual((await readdir(dir)).sort(),before);
    assert.equal(await readFile(second,"utf8"),"second audio");
  } finally { await rm(dir,{recursive:true,force:true}); }
});
