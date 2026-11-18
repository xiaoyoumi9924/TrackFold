import { build } from 'esbuild';
import { mkdir, copyFile, chmod, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('desktop-build/bin', { recursive: true });
await mkdir('desktop-build/licenses', { recursive: true });
await mkdir('desktop-build/licenses/sources', { recursive: true });
await build({ entryPoints: ['server/index.ts'], outfile: 'desktop-build/server.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: false });
const binaries = [
  ['ffmpeg', 'vendor/ffmpeg/ffmpeg'],
  ['ffprobe', 'vendor/ffmpeg/ffprobe'],
];
let information = '# 拾音桌面测试版组件\n\n';
for (const [name, source] of binaries) {
  await chmod(source, 0o755);
  const commandOutput = (arg) => {
    const result = spawnSync(source, [arg], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${name} 无法运行`);
    return result.stdout + result.stderr;
  };
  const license = commandOutput('-L');
  if (/not legally redistributable|nonfree parts/i.test(license)) throw new Error(`${name} 构建不可再分发，已停止打包。`);
  await copyFile(source, `desktop-build/bin/${name}`);
  await chmod(`desktop-build/bin/${name}`, 0o755);
  await writeFile(`desktop-build/licenses/${name}-license.txt`, license);
  const flags = commandOutput('-buildconf');
  await writeFile(`desktop-build/licenses/${name}-build.txt`, flags);
  const links = spawnSync('otool', ['-L', source], { encoding: 'utf8' });
  if (links.status !== 0 || links.stdout.split('\n').slice(1).some(line => line.trim() && !/^\s+\/(usr\/lib|System\/Library)\//.test(line)))
    throw new Error(`${name} 依赖非系统动态库，已停止打包。`);
  await writeFile(`desktop-build/licenses/${name}-libraries.txt`, links.stdout);
}
await copyFile('vendor/ffmpeg/COPYING.LGPLv2.1', 'desktop-build/licenses/COPYING.LGPLv2.1');
await copyFile('vendor/ffmpeg/LAME-COPYING', 'desktop-build/licenses/LAME-COPYING');
await copyFile('vendor/sources/ffmpeg-6.1.1.tar.xz', 'desktop-build/licenses/sources/ffmpeg-6.1.1.tar.xz');
await copyFile('vendor/sources/lame-3.100.tar.gz', 'desktop-build/licenses/sources/lame-3.100.tar.gz');
await copyFile('scripts/build-media.sh', 'desktop-build/licenses/build-media.sh');
information += 'FFmpeg / FFprobe 6.1.1，本项目从官方源码构建，LGPL-2.1-or-later，未启用 GPL 或 nonfree。\nFFmpeg 源码：https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz\nLAME 3.100 / LGPL-2.0-or-later：https://sourceforge.net/projects/lame/files/lame/3.100/\n构建命令见 build-media.sh，构建选项见 ffmpeg-build.txt。\n\n';
information += 'Electron 45.3.3 / MIT；发行包内 Electron LICENSE 与 LICENSES.chromium.html 包含其许可。其他运行组件许可随各自 node_modules 提供。\n这是本机测试版，尚未签署 Developer ID 或公证。抖音浏览器解析需要已安装 Google Chrome。\n';
await writeFile('desktop-build/licenses/README.txt', information);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
console.log(`桌面服务 ${pkg.version} 已构建，媒体组件已检查。`);
