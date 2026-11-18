import test from 'node:test'; import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os'; import {execFileSync} from 'node:child_process';
import {analyzeLoudness,loudnessFilter,renderLoudnessPreview} from '../server/loudness.ts'; import {convert,probe} from '../server/media.ts';
test('measured normalization brings different volumes closer to the target, with valid preview and outputs',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiyin-loudness-'));const signal=new AbortController().signal;
 try {
  const results:number[]=[];
  for(const [i,volume] of [0.03,0.3].entries()){
   const src=path.join(dir,`src${i}.wav`),out=path.join(dir,`out${i}.mp3`),preview=path.join(dir,`preview${i}.mp3`);
   execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`sine=frequency=700:duration=5,volume=${volume}`,src]);
   const stats=await analyzeLoudness(src,signal);assert(Number.isFinite(stats.inputI));
   await renderLoudnessPreview(src,preview,stats,signal);assert((await probe(preview,signal)).duration>4.9);
   const p=await convert(src,out,'mp3','测试',5,signal,()=>{},false,{loudnessFilter:loudnessFilter(stats)});assert.equal(p.codec,'mp3');
   const after=await analyzeLoudness(out,signal);results.push(after.inputI);
  }
  assert(Math.abs(results[0]-results[1])<1,`outputs differ: ${results}`);
  assert(results.every(value=>Math.abs(value+16)<1.5),`unexpected loudness: ${results}`);
  const silent=path.join(dir,'silent.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=44100:cl=stereo','-t','3',silent]);
  await assert.rejects(analyzeLoudness(silent,signal),/静音|分析/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
