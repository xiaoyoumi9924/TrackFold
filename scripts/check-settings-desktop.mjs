// Uses generated media, a disposable database and a real one-minute desktop timer.
import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shiyin-settings-')));
const executablePath = process.env.SHIYIN_TEST_EXECUTABLE;
const ffmpeg = executablePath ? path.resolve(executablePath, '../../Resources/bin/ffmpeg') : path.resolve('vendor/ffmpeg/ffmpeg');
const music = path.join(root, '定时测试.wav'), queuedFile = path.join(root, '等待处理.wav');
for (const [file, frequency, duration] of [[music,440,85],[queuedFile,540,3]]) {
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i',`sine=frequency=${frequency}:duration=${duration}`,file]);
}
const screenshotDir = process.env.SHIYIN_TEST_SCREENSHOTS;
if (screenshotDir) mkdirSync(screenshotDir,{recursive:true});
let desktop, page;
async function capture(name) {
  if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,name+'.png')});
}
async function start(profile) {
  desktop = await _electron.launch({
    ...(executablePath ? {executablePath} : {}), args: executablePath ? [] : ['.'], timeout:45000,
    env:{...process.env,SHIYIN_DESKTOP_DATA_DIR:path.join(root,profile),SHIYIN_DESKTOP_OUTPUT_DIR:path.join(root,'output')},
  });
  page = await desktop.firstWindow();
  await page.locator('main').waitFor();
}
async function stop() {
  await desktop.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  await desktop.close();
  desktop=undefined;
}
const nav = name => page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true});
const category = name => page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name,exact:true});
const api = (url, body) => page.evaluate(async ({url,body}) => {
  const response = await fetch(url,body === undefined ? undefined : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
},{url,body});
async function until(action,message) {
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
    const value=await action();
    if(value) return value;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  throw Error(message);
}
async function upload(file) {
  await page.getByRole('tab',{name:'本地文件',exact:true}).click();
  await page.locator('.upload-entry input[type=file]').setInputFiles(file);
  await page.getByRole('button',{name:'提取并保存',exact:true}).click();
}
function chooseTimer() { return page.getByRole('button',{name:'定时关闭',exact:true}).click(); }
const general = () => page.evaluate(()=>window.shiyinDesktop.preferences());
try {
  await start('original');
  if (executablePath) {
    await desktop.evaluate(({app})=>{
      let enabled=false;
      app.getLoginItemSettings=()=>({openAtLogin:enabled,status:enabled?'enabled':'not-registered'});
      app.setLoginItemSettings=request=>{enabled=request.openAtLogin;};
    });
  }
  await nav('设置').click();
  await page.getByRole('heading',{name:'通用',exact:true}).waitFor();
  await page.getByRole('heading',{name:'音频封面',exact:true}).waitFor();
  assert.equal(await category('音频设置').count(),0);
  assert.equal(await page.getByRole('heading',{name:'导出预设',exact:true}).count(),0);
  const login=page.getByRole('checkbox',{name:'开机自启动'});
  assert.equal(await login.isChecked(),false);
  if (executablePath) {
    await login.check();
    await until(async()=>(await general()).openAtLogin,'login item was not set');
    await login.uncheck();
    await until(async()=>!(await general()).openAtLogin,'login item did not turn off');
  }
  assert.equal(await page.getByText('启动时打开',{exact:true}).count(),0);
  await capture('settings-general');
  await desktop.evaluate(({globalShortcut,clipboard})=>{
    const register=globalShortcut.register.bind(globalShortcut);
    globalShortcut.register=(key,handler)=>{
      if (key === 'CommandOrControl+Alt+M') return false;
      if (!register(key,handler)) return false;
      globalThis.qaShortcut=handler;
      return true;
    };
    clipboard.readText=()=> '分享 https://www.bilibili.com/video/BV19x41167JZ';
  });
  const shortcutKey=page.getByRole('button',{name:/^快捷启动 /});
  await shortcutKey.click();
  await shortcutKey.press('Escape');
  assert.equal((await general()).shortcut,'');
  await shortcutKey.click();
  await shortcutKey.press('Meta+Alt+K');
  await until(async()=>(await general()).shortcutActive,'global keyboard shortcut never registered');
  assert.equal((await general()).shortcut,'CommandOrControl+Alt+K');
  await shortcutKey.click();
  await shortcutKey.press('Meta+Alt+M');
  await page.getByRole('alert').filter({hasText:'此快捷键已被占用'}).waitFor();
  assert.equal((await general()).shortcut,'CommandOrControl+Alt+K');
  let resolutions=0;
  page.on('request',request=>{if (request.url().endsWith('/api/resolve')) resolutions++;});
  await desktop.evaluate(()=>globalThis.qaShortcut());
  assert.equal(await page.getByRole('textbox',{name:'歌曲或视频分享链接'}).inputValue(),'https://www.bilibili.com/video/BV19x41167JZ');
  assert.equal(resolutions,0);
  await desktop.evaluate(({Menu})=>{
    const configure=Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='设置…');
    assertShortcut(configure);
    configure.click();
    function assertShortcut(item) { if (!item?.accelerator.endsWith(',')) throw Error('settings shortcut is missing'); }
  });
  await page.getByRole('heading',{name:'通用',exact:true}).waitFor();
  await capture('settings-shortcut');
  console.log('PASS merged settings, login control, custom shortcuts, occupied-key handling and Mac Settings shortcut');

  await nav('音频提取').click();
  await upload(music);
  const song=await until(async()=> (await api('/api/jobs')).data.find(job=>job.status==='completed'),'test song did not save');
  await api('/api/library/organize',{ids:[song.id],action:'favorite',value:true});
  await api('/api/library/playlists',{action:'create',name:'定时测试歌单'});
  await api('/api/library/organize',{ids:[song.id],action:'add-group',value:'定时测试歌单'});
  const backup=(await api('/api/backup')).data;
  assert.deepEqual(backup.groups,['定时测试歌单']);
  assert.equal(backup.audio[0].favorite,true);

  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
  await nav('歌单').click();
  await page.getByRole('button',{name:'播放全部',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bottom-player audio')?.currentTime > 0.3);
  await chooseTimer();
  const timer = page.getByRole('region',{name:'定时关闭',exact:true});
  await timer.getByRole('button',{name:'开始计时'}).waitFor();
  await capture('sleep-timer-choices');
  await timer.getByRole('button',{name:'开始计时'}).click();
  await timer.getByRole('button',{name:'取消定时'}).click();
  assert.equal(await page.evaluate(()=>window.shiyinDesktop.shutdownTimer()),null);
  await timer.getByRole('combobox',{name:'关闭时间'}).selectOption('custom');
  const custom=timer.getByRole('spinbutton',{name:'分钟'});
  await custom.fill('721');
  assert.equal(await timer.getByRole('button',{name:'开始计时'}).isDisabled(),true);
  await custom.fill('1');
  await timer.getByRole('button',{name:'开始计时'}).click();
  await timer.getByText(/退出拾音/).waitFor();
  await capture('sleep-timer-active');

  let sawPause=false;
  await page.exposeFunction('qaObservePause',()=>{sawPause=true;});
  await page.evaluate(()=>document.querySelector('.bottom-player audio').addEventListener('pause',()=>void window.qaObservePause(),{once:true}));
  await timer.getByRole('button',{name:'收起定时关闭'}).click();
  await api('/api/queue',{paused:true});
  await nav('音频提取').click();
  await upload(queuedFile);
  const queued=await until(async()=> (await api('/api/jobs')).data.find(job=>job.status==='queued'),'queued test job was not registered');
  assert.equal(await page.locator('.bottom-player audio').evaluate(el=>el.paused),false);
  const origin=new URL(page.url()).origin;
  console.log('PASS backup export and timer controls, waiting for real auto-exit');
  await desktop.waitForEvent('close',{timeout:70000});
  desktop=undefined;
  assert.equal(sawPause,true,'timer did not pause playback');
  await assert.rejects(fetch(origin+'/api/health'));

  await start('original');
  assert.equal((await api('/api/recovery')).data.some(item=>item.id===queued.id),true);
  assert.ok(readFileSync(song.filePath).length);
  assert.equal(await page.evaluate(()=>window.shiyinDesktop.shutdownTimer()),null);
  assert.equal((await general()).shortcutActive,true);
  await nav('设置').click();
  await page.getByRole('button',{name:'清除快捷启动键'}).click();
  await until(async()=>(await general()).shortcut === '','custom shortcut was not cleared');
  assert.equal((await general()).shortcutActive,false);
  console.log('PASS timer stopped playback, exited Mac app, recovered queued work and preserved saved media');
  await stop();

  await start('restore');
  await nav('设置').click();
  await category('数据与维护').click();
  await capture('settings-maintenance');
  await page.getByLabel('选择拾音备份').setInputFiles({name:'拾音备份.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.getByText('恢复预览',{exact:true}).waitFor();
  await page.getByRole('button',{name:'确认恢复'}).click();
  await page.getByText(/记录已恢复/).waitFor();
  const restored=(await api('/api/jobs')).data.find(item=>item.id===song.id);
  assert.equal(restored.favorite,true);
  assert.deepEqual(restored.groups,['定时测试歌单']);
  assert.equal(restored.fileExists,true);
  await stop();
} finally {
  if (desktop) await stop();
}
