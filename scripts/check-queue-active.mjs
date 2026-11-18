import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {once} from 'node:events';
import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
const dir=mkdtempSync(path.join(os.tmpdir(),'shiyin-active-queue-'));
const media=path.join(dir,'sample.wav'); const wrapper=path.join(dir,'slow-ffmpeg');
execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=4',media]);
writeFileSync(wrapper,'#!/bin/sh\nsleep 2\nexec /opt/homebrew/bin/ffmpeg "$@"\n',{mode:0o755});
const server=spawn('node_modules/.bin/tsx',['server/index.ts','--production'],{env:{...process.env,PORT:'4196',SHIYIN_DATA_DIR:path.join(dir,'data'),SHIYIN_OUTPUT_DIR:path.join(dir,'output'),SHIYIN_FFMPEG_PATH:wrapper},stdio:['ignore','pipe','pipe']});
const url='http://127.0.0.1:4196';
const get=async(p,body)=>{const r=await fetch(url+p,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error);return j};
try {
 for(let i=0;i<100;i++){try{await get('/api/queue');break}catch{await new Promise(r=>setTimeout(r,50))}}
 const data=new FormData(); data.append('file',new Blob([readFileSync(media)],{type:'audio/wav'}),'sample.wav');
 const response=await fetch(url+'/api/upload',{method:'POST',body:data}); const resource=await response.json(); assert(response.ok,JSON.stringify(resource));
 const job=await get('/api/jobs',{token:resource.token,choice:'original',format:'mp3'});
 await get('/api/queue',{paused:true});
 let current;
 for(let i=0;i<100;i++){current=(await get('/api/jobs')).find(j=>j.id===job.id);if(['completed','failed','cancelled'].includes(current.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal((await get('/api/queue')).paused,true); assert.equal(current.status,'completed',JSON.stringify(current)); assert(current.filename.endsWith('.mp3'));
 console.log('PASS pausing keeps an already started conversion running to completion');
} finally {server.kill('SIGTERM'); await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,5000))]);}
