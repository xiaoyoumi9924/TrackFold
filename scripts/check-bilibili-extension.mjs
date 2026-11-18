import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
 const page = await browser.newPage({viewport:{width:1200,height:800}});
 await page.route('https://www.bilibili.com/**', r => r.fulfill({contentType:'text/html',body:'<style>#bilibili-player{position:absolute;top:100px;left:100px;width:900px;height:600px}</style><div id="bilibili-player"><video></video></div>'}));
 await page.goto('https://www.bilibili.com/video/BV1xx411c7mD?p=2');
 await page.evaluate(() => { window.captured=[]; HTMLAnchorElement.prototype.click=function(){window.captured.push(this.href)}; });
 await page.addStyleTag({content:await readFile('browser-extension/content.css','utf8')});
 await page.addScriptTag({content:await readFile('browser-extension/content.js','utf8')});
 const button=page.getByRole('button',{name:'选择保存音频或视频'});
 await button.click(); await page.getByRole('button',{name:'保存音频',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.captured[0]),'shiyin-audio://bilibili/download?id=BV1xx411c7mD&p=2');
 await page.evaluate(()=>history.pushState({},'', '?p=3'));
 await button.click(); await page.getByRole('button',{name:'保存视频',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.captured[1]),'shiyin-audio://bilibili/video?id=BV1xx411c7mD&p=3');
 console.log('PASS Bilibili current part audio and video handoffs');
} finally {await browser.close()}
