// Uses generated media and intercepts native notifications; no OS notification is emitted.
import { _electron } from 'playwright'; import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import {execFileSync} from 'node:child_process'; import path from 'node:path'; import os from 'node:os';
const root=mkdtempSync(path.join(os.tmpdir(),'shiyin-notifications-'));
const executablePath=path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音');
const ffmpeg=path.resolve(executablePath,'../../Resources/bin/ffmpeg');
const files=['第一首.wav','第二首.wav','第三首.wav'].map(f=>path.join(root,f));
for(const [i,file] of files.entries())execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',`sine=frequency=${400+i*100}:duration=3`,file]);
const env={...process.env,SHIYIN_DESKTOP_DATA_DIR:path.join(root,'profile'),SHIYIN_DESKTOP_OUTPUT_DIR:path.join(root,'output')};
let app,page;
async function launch(){
 app=await _electron.launch({executablePath,args:[],env,timeout:45000});page=await app.firstWindow();await page.locator('main').waitFor();
 await app.evaluate(({Notification})=>{globalThis.__shiyinNotices=[];Notification.isSupported=()=>true;Notification.prototype.show=function(){globalThis.__recentNotice=this;globalThis.__shiyinNotices.push({title:this.title,body:this.body});};});
}
async function api(route){return await page.evaluate(async r=>await(await fetch(r)).json(),route)}
async function waitSummary(expected){for(let i=0;i<120;i++){let state=await api('/api/queue');if(state.lastSummary?.completed===expected)return state.lastSummary;await new Promise(r=>setTimeout(r,100));}throw Error('summary not generated');}
async function quit(){const closed=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await closed;app=undefined;}
try{
 await launch();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 assert.equal((await api('/api/notifications')).enabled,false);
 await page.getByRole('tab',{name:'本地文件',exact:true}).click();await page.locator('.upload-entry input[type=file]').setInputFiles(files[0]);await page.getByRole('button',{name:'提取并保存',exact:true}).click();
 await waitSummary(1);assert.equal((await app.evaluate(()=>globalThis.__shiyinNotices)).length,0);
 await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole("button", { name: "通知", exact: true }).click();await page.getByRole("checkbox",{name:"开启系统通知"}).check();
 assert.equal((await api('/api/notifications')).enabled,true);
 await page.getByRole('button',{name:'音频提取',exact:true}).click();await page.getByRole('tab',{name:'本地文件',exact:true}).click();
 await page.locator('.upload-entry input[type=file]').setInputFiles(files.slice(1));const panel=page.locator('.local-batch-panel');await panel.getByRole('button',{name:'保存所选 2 个',exact:true}).click();
 await waitSummary(2);let notices=[];for(let i=0;i<30;i++){notices=await app.evaluate(()=>globalThis.__shiyinNotices);if(notices.length)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(notices.length,1);assert.equal(notices[0].title,'拾音任务已结束');assert.equal(notices[0].body,'完成 2 项');
 await app.evaluate(()=>globalThis.__recentNotice.emit('click'));
 await page.getByRole('button',{name:'任务',exact:true}).click();
 await page.getByText('本次运行最近一批：完成 2 项',{exact:false}).waitFor();
 await page.setViewportSize({width:390,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/tmp/shiyin-notification-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);await quit();await launch();assert.equal((await api('/api/notifications')).enabled,true);assert.equal((await api('/api/queue')).lastSummary,null);assert.equal((await app.evaluate(()=>globalThis.__shiyinNotices)).length,0);
 console.log('PASS packaged app: default off, opt-in persistence, one aggregate desktop notification, in-app summary, no replay after restart');
}finally{if(app)await quit();}
