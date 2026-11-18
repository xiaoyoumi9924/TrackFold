const { app, BrowserWindow, utilityProcess, ipcMain, dialog, shell, Menu, session, screen, Notification, globalShortcut, clipboard, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { importLegacy } = require('./migrate.cjs');
const { createHandoffQueue } = require('./handoff.cjs');
const { desktopPreferences } = require('./preferences.cjs');
const { createShutdownTimer } = require('./shutdown-timer.cjs');

const userData = process.env.SHIYIN_DESKTOP_DATA_DIR || (app.isPackaged
  ? path.join(app.getPath('appData'), '拾音') : path.join(app.getAppPath(), '.local/desktop-dev'));
app.setPath('userData', userData);
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
const data = path.join(userData, 'data');
const runtimeFile = path.join(userData, 'runtime.json');
const preferences = desktopPreferences(userData);
let child, window, origin = '', stopping = false, quitting = false, quitPending = false, importing = false;
let verificationWindow;
const taskNotifications = new Set();
const handoffs = createHandoffQueue({
  canStart: () => !!origin && !!window && !importing && !quitting,
  run: async key => {
    const [kind, id, part] = key.split(':');
    const bili = kind.startsWith('bili-');
    const video = kind === 'video' || kind === 'bili-video';
    const endpoint = video ? '/api/video' : bili ? '/api/extension/bilibili' : '/api/extension/douyin';
    const payload = video ? { input: bili ? `https://www.bilibili.com/video/${id}?p=${part}` : `https://www.douyin.com/video/${id}` } : bili ? { id, part: Number(part) } : { id };
    const response = await fetch(`${origin}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shiyin-token': token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '解析失败');
  },
  onError: (error, key) => {
    const [kind, id] = key.split(':');
    if (!quitting && window && !window.isDestroyed())
      void dialog.showMessageBox(window, { type: 'error', message: kind.endsWith('video') ? '未能添加视频保存任务' : '未能添加音频任务', detail: `视频 ${id}：${String(error.message || '请稍后重试。')}` });
  },
});
const replies = new Map();
const token = randomBytes(32).toString('hex');
const logFile = path.join(userData, 'desktop.log');
function log(text) { fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 }); }

function startService(preferredPort = 0) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SHIYIN_APP_ROOT: app.getAppPath(), SHIYIN_DATA_DIR: data,
      SHIYIN_OUTPUT_DIR: process.env.SHIYIN_DESKTOP_OUTPUT_DIR || path.join(app.getPath('music'), '拾音'),
      SHIYIN_ACCESS_TOKEN: token, PORT: String(preferredPort),
      SHIYIN_FFMPEG_PATH: app.isPackaged ? path.join(process.resourcesPath, 'bin/ffmpeg') : path.join(app.getAppPath(), 'vendor/ffmpeg/ffmpeg'),
      SHIYIN_FFPROBE_PATH: app.isPackaged ? path.join(process.resourcesPath, 'bin/ffprobe') : path.join(app.getAppPath(), 'vendor/ffmpeg/ffprobe'),
    };
    delete env.SODA_APP_DIR; delete env.SODA_FORCE_NATIVE;
    const service = utilityProcess.fork(path.join(app.getAppPath(), 'desktop-build/server.mjs'), ['--production'], {
      env, cwd: app.getPath('home'), serviceName: '拾音音频处理', stdio: 'pipe',
    });
    child = service;
    let ready = false;
    const timeout = setTimeout(() => { service.kill(); reject(new Error('处理服务启动超时，请重新打开拾音。')); }, 30000);
    service.stderr.on('data', bytes => log(bytes.toString().slice(-4000)));
    service.stdout.on('data', bytes => log(bytes.toString().slice(-4000)));
    service.on('message', async message => {
      if (message?.type === 'task-summary' && Number.isSafeInteger(message.completed) && Number.isSafeInteger(message.failed) && message.completed >= 0 && message.failed >= 0 && message.completed + message.failed > 0 && Notification.isSupported()) {
        try {
          const summary = [message.completed ? `完成 ${message.completed} 项` : '', message.failed ? `失败 ${message.failed} 项` : ''].filter(Boolean).join('，');
          const notice = new Notification({title:'拾音任务已结束', body:summary});
          taskNotifications.add(notice);
          notice.on('close', () => taskNotifications.delete(notice));
          notice.on('failed', () => taskNotifications.delete(notice));
          notice.on('click', () => { reveal(); taskNotifications.delete(notice); });
          notice.show();
        } catch { log('系统通知未能显示。'); }
      }
      if(message?.type==='qishui-verification') {
        try {
          const url=new URL(message.url);
          if(url.origin!==origin || !/^\/qishui-verify\/[a-f0-9-]{36}$/.test(url.pathname) || url.search || url.hash)return;
          if(verificationWindow && !verificationWindow.isDestroyed()){
            if(verificationWindow.webContents.getURL()!==url.href)await verificationWindow.loadURL(url.href);
            verificationWindow.focus();return;
          }
          verificationWindow=new BrowserWindow({title:'汽水账号验证',parent:window,width:620,height:760,minWidth:480,minHeight:580,
            backgroundColor:'#f5f6f2',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false}});
          verificationWindow.on('closed',()=>{verificationWindow=undefined;});
          verificationWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
          verificationWindow.webContents.on('will-navigate',(event,target)=>{if(new URL(target).origin!==origin)event.preventDefault();});
          await verificationWindow.loadURL(url.href);
        }catch{log('汽水验证窗口未能打开。');}
      }
      if (message?.type === 'ready') {
        ready = true; clearTimeout(timeout);
        origin = `http://127.0.0.1:${message.port}`;
        fs.writeFileSync(runtimeFile, JSON.stringify({ port: message.port }), { mode: 0o600 });
        resolve();
      }
      if (message?.type === 'status') { replies.get(message.id)?.(message); replies.delete(message.id); }
      if (message?.type === 'picker' && ['file', 'folder'].includes(message.kind)) {
        try {
          const result = await dialog.showOpenDialog(window, {
            title: message.kind === 'folder' ? '选择音频保存位置' : '选择原来的音频文件',
            defaultPath: typeof message.initial === 'string' ? message.initial : app.getPath('music'),
            properties: [message.kind === 'folder' ? 'openDirectory' : 'openFile'],
          });
          service.postMessage({ type: 'picker-result', id: message.id, path: result.canceled ? null : result.filePaths[0] });
        } catch { service.postMessage({ type: 'picker-result', id: message.id, path: null }); }
      }
    });
    service.on('exit', code => {
      clearTimeout(timeout);
      if (child === service) child = undefined;
      if (!ready) reject(Object.assign(new Error('处理服务未能启动。详情保存在桌面记录目录的 desktop.log。'), { code }));
      else if (!stopping && !quitting) {
        dialog.showErrorBox('拾音处理服务已停止', '请退出并重新打开拾音。已完成的音频和记录仍保存在本机。');
        quitting = true; app.quit();
      }
    });
  });
}
async function status() {
  if (!child) return { busy: false, records: 0 };
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { replies.delete(id); reject(new Error('处理服务暂时没有响应，请稍后重试。')); }, 3000);
    replies.set(id, value => { clearTimeout(timeout); resolve(value); });
    child.postMessage({ type: 'status', id });
  });
}
async function stopService() {
  if (!child) return;
  stopping = true;
  const service = child;
  await new Promise(resolve => {
    const timer = setTimeout(() => service.kill(), 10000);
    service.once('exit', () => { clearTimeout(timer); resolve(); });
    service.postMessage({ type: 'shutdown' });
  });
  stopping = false;
}
let playbackStopped;
function stopPlayback() {
  for (const current of BrowserWindow.getAllWindows()) current.webContents.setAudioMuted(true);
  if (!window || window.isDestroyed()) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timeout);
      playbackStopped = undefined;
      resolve();
    };
    const timeout = setTimeout(finish, 1000);
    playbackStopped = finish;
    window.webContents.send('shiyin:action', { type: 'stop-playback' });
  });
}
const shutdownTimer = createShutdownTimer(
  deadline => {
    if (window && !window.isDestroyed()) window.webContents.send('shiyin:action', { type: 'timer', deadline });
  },
  () => void requestQuit(true),
);
async function requestQuit(scheduled = false) {
  if (scheduled && !quitting) {
    quitting = true;
    await Promise.all([stopPlayback(), stopService()]);
    app.quit();
    return;
  }
  if (quitting || quitPending || importing) return;
  quitPending = true;
  try {
    const current = await status();
    if (quitting) return;
    if (current.busy) {
      const options = { type: 'question', title: '任务仍在处理',
        message: '退出会停止正在处理的任务', detail: '已完成的音频和视频会保留。下次打开可在「任务 → 继续上次」查看中断的任务。',
        buttons: ['继续处理', '停止并退出'], defaultId: 0, cancelId: 0 };
      const result = window?.isVisible() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (result.response !== 1) { quitPending = false; return; }
    }
  } catch { /* An unresponsive service is still terminated on an explicit quit. */ }
  if (quitting) return;
  quitting = true;
  shutdownTimer.update(null);
  await stopService(); app.quit();
}
async function importRecords(selected) {
  if (importing) return { error: '正在导入，请稍候。' };
  importing = true;
  let stopped = false;
  try {
    const current = await status();
    if (current.records || current.busy) throw new Error('桌面版已有记录或任务，不能覆盖。旧版记录和音频仍保留在原处。');
    if (!selected) {
      const pick = await dialog.showOpenDialog(window, { title: '选择旧版拾音项目文件夹', properties: ['openDirectory'] });
      if (pick.canceled) return { cancelled: true };
      selected = pick.filePaths[0];
    }
    await stopService(); stopped = true;
    const count = await importLegacy(selected, data);
    await startService(readPort()); stopped = false;
    if (window && new URL(window.webContents.getURL()).origin !== origin) await window.loadURL(origin);
    return { count };
  } catch (error) {
    if (stopped) {
      try { await startService(readPort()); if (window && new URL(window.webContents.getURL()).origin !== origin) await window.loadURL(origin); }
      catch (restartError) { log(restartError.message); }
    }
    return { error: error.message || '导入未完成，原记录仍保留。' };
  } finally { importing = false; handoffs.drain(); }
}
function readPort() {
  try { const n = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).port; return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0; }
  catch { return 0; }
}
function trusted(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
}
function reveal(action) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  if (action) window.webContents.send('shiyin:action', action);
}
const mac = process.platform === 'darwin';
const shortcutPattern = /^(?:CommandOrControl\+)?(?:Control\+)?(?:Alt\+)?(?:Shift\+)?(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|20)|Space|Up|Down|Left|Right|Backspace|Delete|Home|End|PageUp|PageDown)$/;
let shortcut = '';
function validShortcut(value) {
  return value === '' || (typeof value === 'string' && value.length <= 64 &&
    shortcutPattern.test(value) && /^(?:CommandOrControl|Control|Alt)\+/.test(value));
}
function activatePaste() {
  const candidates = clipboard.readText().slice(0, 16000).match(/https?:\/\/[^\s<>"\[\]]+/g) || [];
  const text = candidates.map(value => value.replace(/[，。；！）)、]+$/, '')).find(value => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.port &&
        /(^|\.)(qishui\.com|douyin\.com|iesdouyin\.com|bilibili\.com|b23\.tv)$/.test(url.hostname);
    } catch { return false; }
  }) || '';
  reveal(text ? { type: 'paste', text } : undefined);
}
function registerShortcut(next, save = false) {
  if (next === shortcut && next === preferences.get().shortcut) return;
  if (!validShortcut(next)) throw new Error('此快捷键无法使用，请设置其他组合。');
  if (next && !globalShortcut.register(next, activatePaste))
    throw new Error('此快捷键已被占用，请设置其他组合。');
  if (save) {
    try { preferences.write({ shortcut: next }); }
    catch (error) { if (next) globalShortcut.unregister(next); throw error; }
  }
  if (shortcut) globalShortcut.unregister(shortcut);
  shortcut = next;
}
function generalSettings() {
  const login = mac && app.isPackaged ? app.getLoginItemSettings() : undefined;
  return { shortcut: preferences.get().shortcut, loginSupported: !!login, shortcutActive: !!shortcut,
    openAtLogin: login?.openAtLogin || false, loginStatus: login?.status };
}
function updateGeneral(patch) {
  if (typeof patch?.openAtLogin === 'boolean' && mac && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, type: 'mainAppService' });
    const actual = app.getLoginItemSettings();
    if (actual.openAtLogin !== patch.openAtLogin && !(patch.openAtLogin && actual.status === 'requires-approval'))
      throw new Error('系统没有应用登录项更改，请在系统设置的「登录项」中检查。');
  }
  if (mac && patch?.shortcut !== undefined) registerShortcut(patch.shortcut, true);
  return generalSettings();
}
function openExternal(url) {
  try { const link = new URL(url); if (link.protocol === 'https:' && /(^|\.)(douyin\.com|github\.com|qishui\.com)$/.test(link.hostname)) void shell.openExternal(link.href); } catch {}
}
function acceptLink(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'shiyin-audio:' || !['douyin', 'bilibili'].includes(u.hostname) || !['/download', '/video'].includes(u.pathname) || u.hash || [...u.searchParams.keys()].some(k => !['id', ...(u.hostname === 'bilibili' ? ['p'] : [])].includes(k)) || u.searchParams.getAll('id').length !== 1) return;
    const id = u.searchParams.get('id');
    if (u.hostname === 'bilibili') {
      const part = u.searchParams.get('p');
      if (!/^BV[0-9A-Za-z]{10}$/.test(id) || u.searchParams.getAll('p').length !== 1 || !/^[1-9]\d{0,3}$|^10000$/.test(part)) return;
      handoffs.add(`bili-${u.pathname === '/video' ? 'video' : 'audio'}:${id}:${part}`);
    } else {
      if (!/^\d{15,22}$/.test(id)) return;
      handoffs.add(`${u.pathname === '/video' ? 'video' : 'audio'}:${id}`);
    }
  } catch {}
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('open-url', (event, url) => { event.preventDefault(); acceptLink(url); });
  app.on('second-instance', (_event, argv) => { const links = argv.filter(arg => arg.startsWith('shiyin-audio:')); for (const arg of links) acceptLink(arg); if (!links.length) reveal(); });
  app.on('activate', () => { if (window?.webContents.getURL()) reveal(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  app.whenReady().then(async () => {
    app.setName('拾音');
    powerMonitor.on('resume', shutdownTimer.check);
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (origin && details.url.startsWith(origin + '/')) details.requestHeaders['X-Shiyin-Token'] = token;
      if(origin && details.url.startsWith(origin+'/') && verificationWindow && !verificationWindow.isDestroyed() && details.webContentsId===verificationWindow.webContents.id)
        details.requestHeaders['X-Shiyin-Verification']='1';
      callback({ requestHeaders: details.requestHeaders });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.on('shiyin:playback-stopped', event => { if (trusted(event)) playbackStopped?.(); });
    ipcMain.handle('shiyin:shutdown-timer', (event, minutes) => {
      if (!trusted(event)) throw new Error('请求来源无效。');
      return minutes === undefined ? shutdownTimer.current() : shutdownTimer.update(minutes);
    });
    ipcMain.handle('shiyin:preferences', (event, patch) => {
      if (!trusted(event)) throw new Error('请求来源无效。');
      return patch === undefined ? generalSettings() : updateGeneral(patch);
    });
    ipcMain.handle('shiyin:privacy', async event => {
      if (!trusted(event)) throw new Error('请求来源无效。');
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security');
      return { ok: true };
    });
    try {
      try { await startService(readPort()); } catch { await startService(0); }
      const legacy = process.argv.find(arg => arg.startsWith('--import-from='));
      if (legacy) { const result = await importRecords(legacy.slice(14)); if (result.error) log(result.error); }
      const area = screen.getPrimaryDisplay().workAreaSize;
      window = new BrowserWindow({ title: '拾音', width: Math.min(1220, area.width), height: Math.min(840, area.height), minWidth: 860, minHeight: 600,
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 24, y: 20 } } : {}),
        backgroundColor: '#201818', show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
      });
      window.on('close', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
      window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); } });
      window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: '拾音', submenu: [{ role: 'about', label: '关于拾音' }, { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => reveal({type:'settings'}) }, { type: 'separator' }, { label: '退出拾音', accelerator: 'CmdOrCtrl+Q', click: () => void requestQuit() }] },
        { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
      ]));
      const general = preferences.get();
      if (mac) {
        try { registerShortcut(general.shortcut); }
        catch (error) { log(error.message); }
      }
      await window.loadURL(origin);
      if (!quitting) reveal();
      for (const arg of process.argv) if (arg.startsWith('shiyin-audio:')) acceptLink(arg);
      handoffs.drain();
    } catch (error) {
      if (quitting) return;
      log(error.message); dialog.showErrorBox('拾音未能启动', error.message); quitting = true; await stopService(); app.quit();
    }
  });
}
