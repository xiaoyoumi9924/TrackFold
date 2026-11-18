// A fully isolated official-widget stand-in tests our bridge, not a real account.
import { createServer } from "node:http";
import { readFileSync,mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import {chromium} from "playwright";
import {verificationHtml,verificationCsp} from "../server/qishui-verification.ts";
let complete=0,requests=0,failScript=false;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/qishui-verify/')){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',verificationCsp);return res.end(verificationHtml);}
 if(req.url==='/verification.js'){res.setHeader('Content-Type','text/javascript');return res.end(readFileSync('dist/verification.js'));}
 res.setHeader('Content-Type','application/json');
 if(req.url.endsWith('/setup'))return res.end(JSON.stringify({decision:{verify_from:'verify'},generalParams:{},script:'https://lf3-cdn-tos.bytegoofy.com/verification-fixture.js'}));
 if(req.url.endsWith('/request')){requests++;return res.end(JSON.stringify({status:200,contentType:'application/json',body:'{"allowed":true}'}));}
 if(req.url.endsWith('/complete')){complete++;return res.end(JSON.stringify({qr:{phase:'scanned'}}));}
 res.statusCode=404;res.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const p=await browser.newPage({viewport:{width:620,height:700}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://lf3-cdn-tos.bytegoofy.com/verification-fixture.js*',route=>failScript?route.abort():route.fulfill({contentType:'text/javascript',body:`window.ucWebSecondVerify = options => {
  const button=document.createElement('button');button.textContent='完成模拟验证';document.body.append(button);
  button.onclick=async()=>{await fetch(new URL('https://api.qishui.com/passport/safe/fixture/'));const xhr=new XMLHttpRequest();xhr.open('POST','https://api.qishui.com/passport/safe/fixture/');xhr.onload=()=>options.verifyFinishCallback({status:JSON.parse(xhr.responseText).allowed});xhr.send('fixture=yes');};
 };`}));
 await p.goto(origin+'/qishui-verify/fixture');await p.getByRole('button',{name:'完成模拟验证',exact:true}).click();
 await p.getByRole('status').filter({hasText:'验证已提交，请返回拾音等待汽水确认'}).waitFor();
 assert.equal(complete,1);assert.equal(requests,2);assert.deepEqual(errors,[]);
 failScript=true;await p.reload();await p.getByRole('alert').filter({hasText:'未能加载'}).waitFor();
 mkdirSync('.impeccable/review',{recursive:true});
 await p.screenshot({path:'.impeccable/review/verification-error-620-v062.png',fullPage:true});
 await p.setViewportSize({width:480,height:580});await p.screenshot({path:'.impeccable/review/verification-error-480-v062.png',fullPage:true});
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 failScript=false;await p.getByRole('button',{name:'重新加载验证组件'}).click();await p.getByRole('button',{name:'完成模拟验证'}).waitFor();
 console.log('PASS isolated verification window: SDK request bridge → completion callback → waiting for platform; failed-component recovery and both widths. Real account verification remains a separate user test.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
