import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const svg = await readFile('desktop/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  const png = await page.evaluate(async svg => {
    const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(svg); await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    // Keep the same artwork in the sidebar and Dock, with room around the Dock tile.
    canvas.getContext('2d').drawImage(img, 80, 80, 864, 864);
    return canvas.toDataURL('image/png').split(',')[1];
  }, svg);
  await mkdir('desktop-build/icon.iconset', { recursive: true });
  await writeFile('desktop-build/icon.png', Buffer.from(png, 'base64'));
  for (const size of [16,32,128,256,512]) for (const scale of [1,2]) {
    execFileSync('sips', ['-z', String(size*scale), String(size*scale), 'desktop-build/icon.png', '--out', `desktop-build/icon.iconset/icon_${size}x${size}${scale===2?'@2x':''}.png`], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', 'desktop-build/icon.iconset', '-o', 'desktop/icon.icns']);
} finally { await browser.close(); }
