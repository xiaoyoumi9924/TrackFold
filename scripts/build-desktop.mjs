import { build } from 'esbuild';
import { access, mkdir, copyFile, chmod, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const target = process.argv[2] || process.platform;
const mediaDirectories = { darwin: 'vendor/ffmpeg', linux: 'vendor/ffmpeg/linux-x64', win32: 'vendor/ffmpeg/win32-x64' };
if (!Object.hasOwn(mediaDirectories, target)) throw new Error('Unsupported desktop platform.');
const sourceDir = mediaDirectories[target];
const suffix = target === 'win32' ? '.exe' : '';
const native = target === process.platform && process.arch === (target === 'darwin' ? 'arm64' : 'x64');
const tools = ['ffmpeg', 'ffprobe'];
const ffmpegVersion = '6.1.6';
const ffmpegArchive = `ffmpeg-${ffmpegVersion}.tar.xz`;
try {
  const builtVersion = (await readFile(path.join(sourceDir, 'ffmpeg-version.txt'), 'utf8')).trim();
  if (builtVersion !== ffmpegVersion) throw new Error(`需要 FFmpeg ${ffmpegVersion}，当前是 ${builtVersion}。`);
  await Promise.all(tools.map(name => access(path.join(sourceDir, name + suffix))));
} catch (cause) {
  throw new Error(`缺少 ${target} 的 FFmpeg ${ffmpegVersion} 媒体组件。请先运行 sh scripts/build-media.sh ${target}。`, { cause });
}
await mkdir('desktop-build/bin', { recursive: true });
await mkdir('desktop-build/licenses', { recursive: true });
await mkdir('desktop-build/licenses/sources', { recursive: true });
await build({ entryPoints: ['server/index.ts'], outfile: 'desktop-build/server.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: false });
function inspect(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`无法验证 ${command} ${args.join(' ')}`, { cause: result.error });
  return result.stdout + result.stderr;
}
const libraryCommands = { darwin: ['otool', '-L'], linux: ['ldd'], win32: ['x86_64-w64-mingw32-objdump', '-p'] };
for (const name of tools) {
  const source = path.join(sourceDir, name + suffix);
  const dest = path.join('desktop-build/bin', name + suffix);
  const alternate = path.join('desktop-build/bin', name + (suffix ? '' : '.exe'));
  await rm(alternate, { force: true });
  if (target !== 'win32') await chmod(source, 0o755);
  for (const kind of ['license', 'build', 'libraries'])
    await rm(`desktop-build/licenses/${name}-${kind}.txt`, { force: true });
  if (native) {
    if (inspect(source, ['-version']).split(/\s+/)[2] !== ffmpegVersion)
      throw new Error(`${name} 版本与打包源码不一致，请重新构建媒体组件。`);
    const license = inspect(source, ['-L']);
    if (!/LGPL|Lesser General Public License/i.test(license) || /not legally redistributable|nonfree parts/i.test(license))
      throw new Error(`${name} 构建不是可分发的 LGPL 版本。`);
    await writeFile(`desktop-build/licenses/${name}-license.txt`, license);
    await writeFile(`desktop-build/licenses/${name}-build.txt`, inspect(source, ['-buildconf']));
  }
  if ((native && target !== 'win32') || (process.platform === 'linux' && target === 'win32')) {
    const [command, ...args] = libraryCommands[target];
    const output = inspect(command, [...args, source]);
    const links = target === 'win32' ? output.split('\n').filter(line => /file format|DLL Name:/i.test(line)).join('\n') : output;
    const externalMac = target === 'darwin' && links.split('\n').slice(1)
      .some(line => line.trim() && !/^\s+\/(usr\/lib|System\/Library)\//.test(line));
    const externalLinux = target === 'linux' && /not found|lib(?:mp3lame|avcodec|avformat|avutil|swresample|swscale)\.so/i.test(links);
    const externalWindows = target === 'win32' && (!/file format pei-x86-64/.test(links) ||
      [...links.matchAll(/DLL Name: (\S+)/gi)].some(([, dll]) => !/^(?:api-ms-win-.*|advapi32|avicap32|bcrypt|gdi32|kernel32|msvcrt|ole32|oleaut32|secur32|shell32|shlwapi|user32|vfw32|ws2_32)\.dll$/i.test(dll)));
    if (externalMac || externalLinux || externalWindows) throw new Error(`${name} 使用了无法随应用分发的动态库。\n${links}`);
    await writeFile(`desktop-build/licenses/${name}-libraries.txt`, links);
  }
  await copyFile(source, dest);
  await chmod(dest, 0o755);
}
await copyFile(path.join(sourceDir, 'COPYING.LGPLv2.1'), 'desktop-build/licenses/COPYING.LGPLv2.1');
await copyFile(path.join(sourceDir, 'LAME-COPYING'), 'desktop-build/licenses/LAME-COPYING');
const bundledSources = 'desktop-build/licenses/sources';
for (const file of await readdir(bundledSources))
  if (/^ffmpeg-[\d.]+\.tar\.xz$/.test(file) && file !== ffmpegArchive)
    await rm(path.join(bundledSources, file), { force: true });
await copyFile(path.join('vendor/sources', ffmpegArchive), path.join(bundledSources, ffmpegArchive));
await copyFile('vendor/sources/lame-3.100.tar.gz', 'desktop-build/licenses/sources/lame-3.100.tar.gz');
await copyFile('scripts/build-media.sh', 'desktop-build/licenses/build-media.sh');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('desktop-build/licenses/README.txt', [
  '# 拾音桌面版组件', '',
  `FFmpeg / FFprobe ${ffmpegVersion} 采用 LGPL-2.1-or-later，未启用 GPL 或 nonfree。`,
  `FFmpeg 源码：https://ffmpeg.org/releases/${ffmpegArchive}`,
  'LAME 3.100 / LGPL-2.0-or-later：https://sourceforge.net/projects/lame/files/lame/3.100/',
  `构建命令：sh build-media.sh ${target}`, '',
  `Electron ${pkg.devDependencies.electron} / MIT，完整说明见发行包中的 Electron 和 Chromium 许可文件。`, '',
].join('\n'));
console.log(`桌面服务 ${pkg.version} 已构建，媒体组件目标为 ${target}。`);
