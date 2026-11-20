import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const assets = {
  darwin: { source: `Shiyin-${pkg.version}-mac-arm64.dmg`, alias: 'Shiyin-macOS-Apple-Silicon.dmg' },
  linux: { source: `Shiyin-${pkg.version}-linux-amd64.deb`, alias: 'Shiyin-Linux-x64.deb' },
  win32: { source: `Shiyin-${pkg.version}-windows-x64.exe`, alias: 'Shiyin-Windows-x64.exe' },
};
const asset = assets[target];
if (!asset) throw new Error('Choose darwin, linux, or win32.');

const releaseDir = path.join(root, 'release');
await mkdir(releaseDir, { recursive: true });
await copyFile(path.join(releaseDir, asset.source), path.join(releaseDir, asset.alias));
console.log(`Prepared ${asset.alias} for version ${pkg.version}.`);
