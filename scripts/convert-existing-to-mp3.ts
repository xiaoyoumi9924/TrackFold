// One-time, explicit conversion of completed desktop records. Originals remain untouched.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import type { Job } from '../shared/types.ts';
import { checksum, jobFile, OutputStorage, publishAudio } from '../server/storage.ts';
import { libraryDefaults, librarySettings, metadataOf, outputTitle } from '../server/library.ts';
import { convert, prepareArtwork, probe } from '../server/media.ts';

const home=os.homedir(), root=path.resolve('.'), data=path.join(home,'Library/Application Support/拾音/data');
const database=new DatabaseSync(path.join(data,'tasks.sqlite')); database.exec('PRAGMA busy_timeout=5000');
const fallback=path.join(root,'output'); const storage=new OutputStorage(data, fallback);
let organization={...libraryDefaults}; try {organization=librarySettings(JSON.parse(readFileSync(path.join(data,'library.json'),'utf8')))}catch{}
const read=()=>database.prepare('SELECT value FROM jobs').all().map(row=>JSON.parse(String(row.value)) as Job);
const originals=read().filter(j=>j.status==='completed' && !j.parentJobId && jobFile(j,fallback) && existsSync(jobFile(j,fallback)!) && path.extname(jobFile(j,fallback)!).toLowerCase()==='.m4a');
const result:{converted:number;skipped:number;failed:{title:string;reason:string}[]}={converted:0,skipped:0,failed:[]};
for (const parent of originals) {
 const source=jobFile(parent,fallback)!; const scratch=await mkdtemp(path.join(os.tmpdir(),'shiyin-mp3-convert-')); let published='';
 try {
  if(read().some(j=>j.parentJobId===parent.id && j.status==='completed' && j.format==='mp3' && jobFile(j,fallback) && existsSync(jobFile(j,fallback)!))) {result.skipped++;continue;}
  const signal=new AbortController().signal; const before=await checksum(source);
  if(parent.checksum && before!==parent.checksum) throw new Error('原文件内容与记录不一致');
  const metadata=metadataOf(parent.metadata,{title:parent.title,artist:parent.artist,album:parent.metadata?.album});
  const sourceInfo=await probe(source,signal); let artwork:string|undefined;
  try {artwork=await prepareArtwork(undefined,source,scratch,signal)} catch {}
  const staged=path.join(scratch,'output.mp3'); const info=await convert(source,staged,'mp3',metadata.title,sourceInfo.duration,signal,()=>{},false,{metadata,artwork});
  if(info.codec!=='mp3'||info.size<100||Math.abs(info.duration-sourceInfo.duration)>2) throw new Error('转换结果的格式或时长不符合预期');
  if(await checksum(source)!==before) throw new Error('处理时原文件发生变化');
  const id=randomUUID(), fingerprint=await checksum(staged);
  const saved=await publishAudio(staged,storage.outputDir,outputTitle(metadata,organization.naming),id,'mp3',signal,undefined,true); published=saved.filePath;
  const job:Job={id,title:metadata.title,artist:metadata.artist,metadata,naming:organization.naming,embedCover:!!artwork,platform:parent.platform,sourceId:parent.sourceId,completeness:parent.completeness,parentJobId:parent.id,kind:'organized',format:'mp3',status:'completed',progress:100,message:'MP3 音频已保存',createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),outputDir:storage.outputDir,...saved,checksum:fingerprint,size:info.size,duration:info.duration};
  database.exec('BEGIN IMMEDIATE');
  try {
   const row=database.prepare('SELECT value FROM jobs WHERE id = ?').get(parent.id);
   if(!row || (JSON.parse(String(row.value)) as Job).status!=='completed') throw new Error('处理期间原记录发生变化');
   const duplicates=read().some(j=>j.parentJobId===parent.id && j.status==='completed' && j.format==='mp3' && jobFile(j,fallback) && existsSync(jobFile(j,fallback)!));
   if(duplicates) {database.exec('ROLLBACK'); await unlink(published); published=''; result.skipped++;continue;}
   database.prepare('INSERT INTO jobs(id,value) VALUES (?,?)').run(id,JSON.stringify(job)); database.exec('COMMIT'); published='';result.converted++;
  } catch(error){try{database.exec('ROLLBACK')}catch{};throw error;}
 } catch(error) { if(published) await unlink(published).catch(()=>{}); result.failed.push({title:parent.title,reason:error instanceof Error?error.message:'转换失败'}); }
 finally {await rm(scratch,{recursive:true,force:true});}
}
database.close(); console.log(JSON.stringify(result));
