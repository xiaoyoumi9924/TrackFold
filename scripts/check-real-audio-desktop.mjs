// Uses existing real audio only as read-only input; all outputs and records are isolated.
import { _electron } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path'; import os from 'node:os'; import assert from 'node:assert/strict';
const db = new DatabaseSync(path.join(os.homedir(),'Library/Application Support/拾音/data/tasks.sqlite'),{readOnly:true});
const candidates = db.prepare('select value from jobs').all().map(row=>JSON.parse(row.value)).filter(j=>j.status==='completed' && j.filePath && existsSync(j.filePath)); db.close();
const selected=[candidates.find(j=>j.platform==='qishui' && j.completeness==='preview'), ...candidates.filter(j=>j.platform==='douyin' && j.duration>=8 && j.duration<40).slice(0,2)];
assert(selected.length===3 && selected.every(Boolean),'not enough suitable real test samples');
const hashes=selected.map(j=>createHash('sha256').update(readFileSync(j.filePath)).digest('hex'));
const root=mkdtempSync(path.join(os.tmpdir(),'shiyin-real-qa-'));
const executable=path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音');
const ffmpeg=path.resolve(executable,'../../Resources/bin/ffmpeg'), ffprobe=path.resolve(executable,'../../Resources/bin/ffprobe');
const probe=f=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_format','-show_streams','-of','json',f],{encoding:'utf8'}));
let app;
try {
 app=await _electron.launch({executablePath:executable,args:[],env:{...process.env,SHIYIN_DESKTOP_DATA_DIR:path.join(root,'profile'),SHIYIN_DESKTOP_OUTPUT_DIR:path.join(root,'output')},timeout:45000});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('main').waitFor();
 const api=async(url,body)=>page.evaluate(async({url,body})=>{const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;},{url,body});
 await page.getByRole('tab',{name:'本地文件',exact:true}).click(); await page.locator('.upload-entry input[type=file]').setInputFiles(selected.map(j=>j.filePath));
 const panel=page.locator('.local-batch-panel');await panel.getByRole('button',{name:'保存所选 3 个',exact:true}).waitFor(); assert.equal(await panel.getByLabel('输出格式',{exact:true}).inputValue(),'mp3');
 const filename=path.basename(selected[0].filePath);await panel.locator('li').filter({hasText:filename}).locator('summary').click();
 await panel.getByLabel(`标题 ${filename}`).fill('真实音频验证'); await panel.getByLabel(`歌手 ${filename}`).fill('验证歌手');
 await panel.getByRole('button',{name:'保存所选 3 个',exact:true}).click();
 let jobs; for(let n=0;n<600;n++){jobs=await api('/api/jobs');if(jobs.length===3&&jobs.every(j=>['completed','failed','cancelled'].includes(j.status)))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(jobs.length,3);assert(jobs.every(j=>j.status==='completed'),JSON.stringify(jobs.map(j=>({status:j.status,message:j.message}))));
 for(const j of jobs){let info=probe(j.filePath);assert.equal(info.streams.find(s=>s.codec_type==='audio').codec_name,'mp3');execFileSync(ffmpeg,['-v','error','-i',j.filePath,'-f','null','-']);}
 const original=jobs.find(j=>j.title==='真实音频验证');assert(original);const source=probe(original.filePath);assert.equal(source.format.tags.title,'真实音频验证');assert.equal(source.format.tags.artist,'验证歌手');assert(Math.abs(original.duration-selected[0].duration)<1);
 await page.getByRole('button',{name:'歌单',exact:true}).click(); const row=page.locator('.job-row').filter({has:page.getByRole('heading',{name:'真实音频验证',exact:true})});
 await row.getByRole('button',{name:'播放音频'}).click(); await page.waitForFunction(()=>{const a=document.querySelector('.bottom-player audio');return a && !a.paused && a.currentTime>0},null,{timeout:10000});
 await row.getByRole('button',{name:'更多歌曲操作'}).click();await page.getByRole('button',{name:'截取音频片段'}).click();const editor=page.getByRole('dialog');await editor.locator('.wave-area img').evaluate(img=>img.decode());
 await editor.getByLabel('开始（秒）').fill('1');await editor.getByLabel('结束（秒）').fill('6');assert.equal(await editor.getByLabel('导出格式').inputValue(),'mp3');
 await editor.getByRole('button',{name:'试听所选片段'}).click();await page.waitForFunction(()=>{const a=document.querySelector('dialog audio');return a && !a.paused && a.currentTime>=1},null,{timeout:10000});
 await editor.getByRole('button',{name:'导出新片段'}).click();await editor.waitFor({state:'detached'});
 let clip;for(let n=0;n<200;n++){clip=(await api('/api/jobs')).find(j=>j.parentJobId===original.id);if(clip&&['completed','failed'].includes(clip.status))break;await new Promise(r=>setTimeout(r,100));}assert.equal(clip.status,'completed',clip.message);assert(Math.abs(clip.duration-5)<0.15);execFileSync(ffmpeg,['-v','error','-i',clip.filePath,'-f','null','-']);
 await page.waitForFunction(() => document.querySelectorAll('.job-row').length === 4);
 await page.getByRole('button',{name:'筛选',exact:true}).click();
 await page.getByRole('button',{name:'多选'}).click();await page.getByRole('checkbox',{name:'全选',exact:true}).check();await page.getByRole('button',{name:'导出播放列表'}).click();await page.getByText('已导出 4 首',{exact:false}).waitFor();
 const lines=readFileSync(path.join(root,'output','拾音播放列表.m3u8'),'utf8').split('\n').filter(s=>s.startsWith('/'));assert.equal(lines.length,4);assert(lines.every(existsSync));
 assert.deepEqual(selected.map(j=>createHash('sha256').update(readFileSync(j.filePath)).digest('hex')),hashes);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',sampleTypes:['qishui-preview','douyin-audio','douyin-audio'],sourceDurations:selected.map(j=>j.duration),outputs:jobs.map(j=>j.duration),clipDuration:clip.duration,playlistEntries:lines.length,isolatedArtifacts:root}));
} finally {if(app){const close=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await close;}}
