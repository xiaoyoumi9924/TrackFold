import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { readLocalQishuiCookie } from "../server/local-account.ts";
test("a protected client directory is reported as permission denied, not missing or logged out", t => {
  const root=mkdtempSync(path.join(os.tmpdir(),"shiyin-local-login-"));
  const folder=path.join(root,"protected");mkdirSync(folder);
  t.after(()=>{chmodSync(folder,0o700);rmSync(root,{recursive:true,force:true})});
  chmodSync(folder,0);
  assert.throws(()=>readLocalQishuiCookie([path.join(folder,"Cookies"),path.join(root,"missing")]),(error:any)=>error.code==="QISHUI_PERMISSION_DENIED" && /扫码/.test(error.message));
});
test("encrypted or expired client data never claims a successful login", t => {
  const root=mkdtempSync(path.join(os.tmpdir(),"shiyin-local-login-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"Cookies");const db=new DatabaseSync(file);
  db.exec("CREATE TABLE cookies(name TEXT,value TEXT,host_key TEXT,expires_utc INTEGER);INSERT INTO cookies VALUES('sessionid','','.qishui.com',0)");db.close();
  assert.throws(()=>readLocalQishuiCookie([file]),(error:any)=>error.code==="QISHUI_LOCAL_ENCRYPTED");
  assert.throws(()=>readLocalQishuiCookie([path.join(root,"missing")]),(error:any)=>error.code==="QISHUI_LOCAL_MISSING");
});
