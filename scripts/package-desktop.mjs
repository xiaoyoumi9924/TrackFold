import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const targets = { darwin: ['--mac', '--arm64'], linux: ['--linux', '--x64'], win32: ['--win', '--x64'] };
const target = process.argv[2] || process.platform;
if (!Object.hasOwn(targets, target)) throw new Error('Choose darwin, linux, or win32.');

execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'desktop:build', '--', target], { stdio: 'inherit' });

// Stage outside the working tree so Finder metadata doesn't interfere with macOS signing.
const staging = await mkdtemp(path.join(await realpath(tmpdir()), 'shiyin-package-'));
try {
  const samePlatform = target === process.platform && process.arch === (target === 'darwin' ? 'arm64' : 'x64');
  const useLocalElectron = samePlatform && existsSync('node_modules/electron/path.txt') && existsSync('node_modules/electron/dist');
  execFileSync(process.execPath, [path.resolve('node_modules/electron-builder/cli.js'),
    '--config', 'electron-builder.cjs', ...targets[target],
    `--config.directories.output=${staging}`,
  ], { stdio: 'inherit', env: { ...process.env, SHIYIN_USE_LOCAL_ELECTRON: useLocalElectron ? '1' : '0' } });

  await mkdir('release', { recursive: true });
  for (const name of await readdir(staging)) {
    if (/\.(?:dmg|exe|deb)(?:\.blockmap)?$/.test(name)) {
      await copyFile(path.join(staging, name), path.join('release', name));
    }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
