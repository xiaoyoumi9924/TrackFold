// A fully isolated official-widget stand-in tests our bridge, not a real account.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {chromium} from "playwright";
import { createVerificationServer } from "../server/verification-server.ts";

const script = 'https://lf3-cdn-tos.bytegoofy.com/verification-fixture.js';
const challenge = () => ({ id: randomUUID(), expiresAt: Date.now() + 60_000, verificationRequired: true });
let qr = challenge();
let complete = 0, requests = 0, failScript = false, phase = "scanned";
const server = createVerificationServer({
  current: () => qr,
  verificationSetup: async () => ({ decision: { verify_from: 'verify' }, generalParams: {}, script }),
  verificationRequest: async () => {
    requests++;
    return { status: 200, contentType: 'application/json', body: '{"allowed":true}' };
  },
  completeVerification: async () => {
    complete++;
    qr.verificationRequired = false;
    return { phase };
  },
}, path.resolve('dist/verification.js'), error => String(error));
const verificationUrl = await server.open(qr.id);
const origin = new URL(verificationUrl).origin;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const p=await browser.newPage({viewport:{width:620,height:700}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://lf3-cdn-tos.bytegoofy.com/verification-fixture.js*',route=>failScript?route.abort():route.fulfill({contentType:'text/javascript',body:`window.ucWebSecondVerify = options => {
  const button=document.createElement('button');button.textContent='完成模拟验证';document.body.append(button);
  button.onclick=async()=>{await fetch(new URL('https://api.qishui.com/passport/safe/fixture/'));const xhr=new XMLHttpRequest();xhr.open('POST','https://api.qishui.com/passport/safe/fixture/');xhr.onload=()=>options.verifyFinishCallback({status:JSON.parse(xhr.responseText).allowed});xhr.send('fixture=yes');};
 };`}));
 assert.equal((await fetch(origin + '/api/settings')).status, 404);
 assert.equal((await fetch(verificationUrl.slice(0, -1))).status, 410);
 await p.goto(verificationUrl);await p.getByRole('button',{name:'完成模拟验证',exact:true}).click();
 await p.getByRole('status').filter({hasText:'验证已提交，请返回拾音等待汽水确认'}).waitFor();
 assert.equal(complete,1);assert.equal(requests,2);assert.deepEqual(errors,[]);
 assert.equal((await fetch(verificationUrl)).status, 410);
 qr = challenge();
 failScript=true;await p.goto(await server.open(qr.id));await p.getByRole('alert').filter({hasText:'未能加载'}).waitFor();
 mkdirSync('.impeccable/review',{recursive:true});
 await p.screenshot({path:'.impeccable/review/verification-error-620-v062.png',fullPage:true});
 await p.setViewportSize({width:480,height:580});await p.screenshot({path:'.impeccable/review/verification-error-480-v062.png',fullPage:true});
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 failScript=false;phase='confirmed';await p.getByRole('button',{name:'重新加载验证组件'}).click();
 await p.getByRole('button',{name:'完成模拟验证'}).click();
 await p.getByRole('status').filter({hasText:'验证已完成，请返回拾音查看账号状态'}).waitFor();
 assert.equal(complete,2);assert.equal(requests,4);
 console.log('PASS isolated verification window: SDK request bridge → completion callback → waiting for platform; failed-component recovery and both widths. Real account verification remains a separate user test.');
}finally{await browser.close();await server.close();}
