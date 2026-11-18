// Local development observer. Logs protocol states and resource origins only;
// never print account names, tokens, cookies, query values or verification codes.
import { _electron } from "playwright";
import path from "node:path";
import { writeFileSync } from "node:fs";
const application=await _electron.launch({executablePath:path.resolve("release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音"),timeout:45000});
const page=await application.firstWindow();
await page.locator("main").waitFor();await page.waitForLoadState("load");
await page.getByRole("button",{name:"设置",exact:true}).click();
  await page.getByRole("button", { name: "账号连接", exact: true }).click();
application.on("window",window=>{
  if(window===page)return;
  window.on("pageerror",error=>console.log("Verification JavaScript error:",error.message.replace(/https?:\/\/\S+/g,"[resource]").slice(0,180)));
  window.on("console",message=>{if(message.text().startsWith("Verification resource blocked"))console.log(message.text());});
  window.on("response",async response=>{
    const location=new URL(response.url());
    if(location.pathname.endsWith("/verification/setup")){
      try{const data=await response.json();console.log("Verification setup:",{http:response.status(),origin:data.script?new URL(data.script).origin:undefined,error:data.error});}catch{}
    }
    if(location.pathname.endsWith("/verification/request")){
      try{const result=await response.json();let data;try{data=JSON.parse(result.body);}catch{}
      console.log("Verification API result:",{http:result.status,code:data?.data?.error_code??data?.error_code??data?.status_code,stage:data?.data?.status,hasData:!!data?.data,error:result.error});}catch{}
    }
    if(location.hostname==="auth.zijieapi.com" && location.pathname.endsWith(".js"))console.log("Official component:",response.status());
  });
});
let opened="",previous="",checking=false;
const observe=async()=>{
  if(checking)return;checking=true;
  try {
    const data=await page.evaluate(()=>Promise.all([fetch("/api/settings").then(r=>r.json()),fetch("/api/login/qishui/qr").then(r=>r.json())]));
    const qr=data[1].qr;
    const state={douyin:data[0].accounts.douyin.status,qishui:data[0].accounts.qishui.status,phase:qr?.phase||"none",code:qr?.platformCode,needsComputer:!!qr?.verificationRequired};
    const text=JSON.stringify(state);
    if(text!==previous){console.log(text);writeFileSync("/tmp/shiyin-login-observed-status.json",text);previous=text;}
    if(qr?.verificationRequired && opened!==qr.id){opened=qr.id;await page.evaluate(id=>fetch(`/api/login/qishui/qr/${id}/verification/open`,{method:"POST"}),qr.id);}
  }catch{}finally{checking=false;}
};
await observe();
const timer=setInterval(observe,1500);
await application.waitForEvent("close",{timeout:0});clearInterval(timer);
