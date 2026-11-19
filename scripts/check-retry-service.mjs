// Runs an isolated server against deterministic, local mocked platform responses.
import {spawn,execFileSync} from 'node:child_process'; import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,realpathSync} from 'node:fs'; import {once} from 'node:events';
import path from 'node:path'; import os from 'node:os'; import assert from 'node:assert/strict';
const root=mkdtempSync(path.join(os.tmpdir(),'shiyin-retry-service-')), data=path.join(root,'data'), output=path.join(root,'output'); mkdirSync(data,{recursive:true});
const media=path.join(root,'source.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=4',media]);
const mock=path.join(root,'mock.cjs');writeFileSync(mock,`
const fs=process.getBuiltinModule('fs');
let expiringRequests=0;
global.fetch=async (input)=>{
 const u=new URL(typeof input==='string'?input:input.url);let response;
 if(u.hostname==='music.douyin.com') { if(u.searchParams.get('track_id')==='7420006432714688530') return new Response('',{status:503}); if(u.searchParams.get('track_id')==='7420006432714688532') await new Promise(r=>setTimeout(r,800)); response=new Response('ok'); }
 else if(u.hostname==='beta-luna.douyin.com') {
  const id=u.searchParams.get('track_id');
  if (id.endsWith('8536')) return new Response('',{status:503});
  const expired = id.endsWith('8537') && ++expiringRequests === 1;
  const duration = id.endsWith('8534') ? 120000 : id.endsWith('8535') || (id.endsWith('8537') && !expired) ? 0 : 4000;
  const stream = (quality,bitrate) => ({
    main_url:id.endsWith('8538') ? 'https://edge.douyinvod.com/unavailable' : 'https://stream.douyinvod.com/audio',
    backup_url:id.endsWith('8538') ? 'https://stream.douyinvod.com/audio' : undefined,
    video_meta:{quality,vtype:'m4a',bitrate},
  });
  const model={video_duration:4,video_id:'full',video_list:[stream('medium',64000),stream('highest',128000)]};
  response=Response.json({seo_track:{track:{id,name:'测试 '+id,duration,vid:'full',artists:[]}},
    track_player:{video_model:JSON.stringify(model),expire_at:expired ? Date.now()-10000 : undefined}});
 }
 else if(u.hostname==='edge.douyinvod.com') response=new Response(null,{status:302,headers:{Location:'https://unknown-cdn.example/redirect'}});
 else if(u.hostname==='stream.douyinvod.com') response=new Response(fs.readFileSync(process.env.SHIYIN_TEST_MEDIA));
 else throw Error('unexpected external request');
 Object.defineProperty(response,'url',{value:u.href});return response;
};`);
const db=new DatabaseSync(path.join(data,'tasks.sqlite'));db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
const make=(id,sourceId,status='failed')=>({id,title:id,artist:'',platform:'qishui',status,progress:0,message:'网络连接暂时失败',format:'mp3',createdAt:'2026-11-17T00:00:00Z',completeness:'full',sourceId,selection:{quality:'highest',format:'m4a',bitrate:128000},failureKind:'network'});
for(const job of [make('success','7420006432714688529'),make('still-failed','7420006432714688530'),make('cancelled','7420006432714688531','cancelled'),make('cancel-mid','7420006432714688532')])db.prepare('INSERT INTO jobs VALUES (?,?)').run(job.id,JSON.stringify(job));db.close();
const server=spawn('node_modules/.bin/tsx',['server/index.ts','--production'],{env:{...process.env,PORT:'4197',SHIYIN_DATA_DIR:data,SHIYIN_OUTPUT_DIR:output,SHIYIN_TEST_MEDIA:media,NODE_OPTIONS:`--require=${mock}`},stdio:['ignore','pipe','pipe']});
const base='http://127.0.0.1:4197';
async function api(url,body){const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;}
try{
 let ready=false;for(let i=0;i<100;i++){try{await api('/api/queue');ready=true;break}catch{await new Promise(r=>setTimeout(r,50))}}assert(ready,'service did not start');
 const response=await api('/api/jobs/retry-failed',{ids:['success','still-failed','cancelled']});assert.deepEqual(response.results.map(x=>x.status),['started','failed','skipped']);
 let jobs;for(let i=0;i<100;i++){jobs=await api('/api/jobs');if(jobs.find(j=>j.id==='success')?.status==='completed')break;await new Promise(r=>setTimeout(r,100));}
 const success=jobs.find(j=>j.id==='success'),failed=jobs.find(j=>j.id==='still-failed'),cancelled=jobs.find(j=>j.id==='cancelled');
 assert.equal(success.status,'completed');assert(existsSync(success.filePath));assert.equal(success.failureKind,undefined);assert.equal(failed.status,'failed');assert.equal(failed.failureKind,'network');assert.equal(cancelled.status,'cancelled');
 execFileSync('ffmpeg',['-v','error','-i',success.filePath,'-f','null','-']);
 const pending=api('/api/jobs/retry-failed',{ids:['cancel-mid']});
 let started=false; for(let i=0;i<50;i++){const j=(await api('/api/jobs')).find(x=>x.id==='cancel-mid'); if(j.status==='queued'){started=true;break;} await new Promise(r=>setTimeout(r,20));} assert(started);
 await api('/api/jobs/cancel-mid/cancel',{});const cancelledDuring=await pending;assert.equal(cancelledDuring.results[0].status,'skipped');
 assert.equal((await api('/api/jobs')).find(j=>j.id==='cancel-mid').status,'cancelled');
 console.log('PASS retry API: simulated recovery produces valid audio, 503 stays failed, cancelled tasks remain cancelled');

 const discovery = '/api/discovery/batches';
 const destination = realpathSync(mkdtempSync(path.join(root,'auto-save-')));
 await api('/api/storage',{outputDir:destination});
 await api('/api/library/settings',{naming:'title',embedCover:false});
 const tracks = ['8536','8533','8534','8535','8537'].map(suffix => ({
   id:'742000643271468'+suffix, title:suffix, artist:'', duration:4,
 }));
 async function waitFor(read, label) {
  for (let attempt=0;attempt<100;attempt++) {
   const result=await read();
   if (result) return result;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error(label);
 }
 async function finishedBatch(batchId) {
  return waitFor(async () => {
   const item=await api(discovery+'/'+batchId);
   return item.status==='ready' && item;
  },'discovery batch did not finish');
 }
 await api('/api/queue',{paused:true});
 const created=await api(discovery,{title:'自动保存测试',format:'m4a',allowPreview:true,tracks});
 await api('/api/storage',{outputDir:output});
 await api('/api/library/settings',{naming:'artist-title',embedCover:true});
 const batch=await finishedBatch(created.id);
 assert.deepEqual(batch.items.map(item=>item.status),['failed','submitted','submitted','ready','submitted']);
 assert.deepEqual(batch.items.slice(2,4).map(item=>item.resource.completeness),['preview','unknown']);
 const submitted=batch.items.filter(item=>item.jobId).map(item=>item.jobId);
 const queued=(await api('/api/jobs')).filter(job=>submitted.includes(job.id));
 assert.equal(queued.length,3);
 for(const job of queued) {
  assert.equal(job.status,'queued');
  assert.equal(job.format,'m4a');
  assert.equal(job.outputDir,destination);
  assert.equal(job.selection.bitrate,128000);
  assert.equal(job.naming,'title');
  assert.equal(job.embedCover,false);
 }
 const repeated=await api(discovery,{title:'重复排队测试',format:'m4a',tracks:[tracks[1]]});
 assert.equal((await finishedBatch(repeated.id)).items[0].jobId,batch.items[1].jobId);
 await api('/api/queue',{paused:false});
 const saved=await waitFor(async()=>{
  const jobs=await api('/api/jobs');
  const full=jobs.find(job=>job.id===batch.items[1].jobId);
  const excerpt=jobs.find(job=>job.id===batch.items[2].jobId);
  const refreshed=jobs.find(job=>job.id===batch.items[4].jobId);
  return full?.status==='completed' && excerpt?.status==='completed' && refreshed?.status==='failed' && {full,excerpt,refreshed,jobs};
 },'expected full download and refusal after completeness downgrade');
 assert.ok(saved.full.filePath.startsWith(destination+path.sep));
 assert.ok(saved.full.filePath.endsWith('.m4a'));
 assert.equal(saved.refreshed.filePath,undefined);
 assert.equal(saved.refreshed.needsReview,true);
 assert.equal(saved.jobs.filter(job=>tracks.some(track=>track.id===job.sourceId)).length,3);
 assert.equal(saved.excerpt.completeness,'preview');
 assert.ok(saved.excerpt.filePath.startsWith(destination+path.sep));
 execFileSync('ffmpeg',['-v','error','-i',saved.excerpt.filePath,'-f','null','-']);
 execFileSync('ffmpeg',['-v','error','-i',saved.full.filePath,'-f','null','-']);
 const existing=await api(discovery,{title:'复用已保存文件',format:'m4a',tracks:[tracks[1]]});
 assert.equal((await finishedBatch(existing.id)).items[0].jobId,saved.full.id);
 console.log('PASS discovery batch: full audio and previews saved using defaults, unknown tracks require review, reused queued and existing jobs');
 const preview=await fetch(base+'/api/discovery/preview',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'7420006432714688538'}),
 });
 assert.equal(preview.status,200);
 assert.match(preview.headers.get('content-type'),/audio\/mpeg/);
 const previewFile=path.join(root,'verified-preview.mp3');
 writeFileSync(previewFile,Buffer.from(await preview.arrayBuffer()));
 execFileSync('ffmpeg',['-v','error','-i',previewFile,'-f','null','-']);
 console.log('PASS preview decodes using the platform backup when the primary redirects outside allowed hosts');
}finally{server.kill('SIGTERM');await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,5000))]);}
