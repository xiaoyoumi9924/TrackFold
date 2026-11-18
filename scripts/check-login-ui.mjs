import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
const root=mkdtempSync(path.join(os.tmpdir(),'shiyin-login-ui-'));
const application=await _electron.launch({executablePath:path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音'),env:{...process.env,SHIYIN_DESKTOP_DATA_DIR:path.join(root,'profile'),SHIYIN_DESKTOP_OUTPUT_DIR:path.join(root,'audio')},timeout:45000});
const appProcess=application.process();
try {
 const p=await application.firstWindow();await p.locator('main').waitFor();await p.waitForLoadState('load');const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const accounts={qishui:{platform:'qishui',status:'not_connected',source:'none',hasCredentials:false,message:'尚未连接。公开资源可先直接解析。'},douyin:{platform:'douyin',status:'connected',source:'browser',hasCredentials:true,nickname:'测试账号',message:'账号已验证，可重新解析视频。'}};
 const settings={accounts};
 await p.route('**/api/settings',r=>r.fulfill({json:settings}));
 const qr={id:'fixture-qr',image:await QRCode.toDataURL('https://example.invalid/login-fixture'),phase:'new',expiresAt:Date.now()+180000,message:'测试场景：模拟扫码流程，不使用真实账号。'};
 await p.route('**/api/login/qishui/qr',r=>{
   if(r.request().method()==='POST') {
     accounts.qishui.status='logging_in';
     accounts.qishui.message='正在等待汽水完成登录。';
     return r.fulfill({json:{...settings,qr}});
   }
   return r.fulfill({json:{...settings,qr:null}});
 });
 await p.reload();await p.getByRole('button',{name:'设置',exact:true}).click();
  await p.getByRole("button", { name: "账号连接", exact: true }).click();
 assert.equal(await p.locator('.settings-account-card details, .settings-account-card textarea').count(),0);
 assert.equal(await p.locator('#account-douyin').getByRole('status').innerText(),'已登录');
 mkdirSync('.impeccable/review',{recursive:true});
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(860,600));
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.route('**/api/login/qishui/qr/fixture-qr',r=>r.fulfill({json:{...settings,qr:{...qr,phase:'verification',verificationRequired:true,message:'测试场景：手机已确认，电脑端尚待验证。不表示真实账号已经连接。'}}}));
 await p.locator('#account-qishui').getByRole('button',{name:'扫码登录汽水',exact:true}).click();
 await p.locator('.qr-login-panel').waitFor();
 assert.notEqual(await p.locator('.account-block').first().getByRole('status').innerText(),'已登录');
 const continueButton=p.getByRole('button',{name:'继续完成账号验证',exact:true});await continueButton.waitFor();
 await p.getByText('等待电脑验证',{exact:true}).waitFor();
 assert.equal(await p.locator('.account-block').first().getByRole('status').innerText(),'等待电脑验证');
 assert.equal(await p.locator('.toast').filter({hasText:'请使用手机抖音 App 扫码，并在手机上确认'}).count(),0);
 let openedVerification=0;
 await p.route('**/api/login/qishui/qr/fixture-qr/verification/open',r=>{openedVerification++;return r.fulfill({json:{ok:true}});});
 await Promise.all([p.waitForResponse('**/api/login/qishui/qr/fixture-qr/verification/open'),continueButton.click()]);
 assert.equal(openedVerification,1);
 await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:'.impeccable/review/login-compact-small.png',fullPage:true});
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1220,840));
 await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:'.impeccable/review/login-compact.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS compact account settings, preserved Douyin status, direct QR login and no false authentication; both desktop widths fit.');
 const closed=application.waitForEvent('close');await application.evaluate(({app})=>app.quit());await closed;
} finally {if(appProcess.exitCode===null)appProcess.kill('SIGKILL');}
