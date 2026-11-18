import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Sign outside the project directory so Finder-managed folders cannot add metadata to the bundle.
const staging = await mkdtemp(path.join(await realpath(tmpdir()), 'shiyin-package-'));
try {
  execFileSync(path.resolve('node_modules/.bin/electron-builder'), [
    '--config', 'electron-builder.cjs', '--mac', '--arm64',
    `--config.directories.output=${staging}`,
  ], { stdio: 'inherit' });

  await mkdir('release', { recursive: true });
  for (const name of await readdir(staging)) {
    if (name.endsWith('.dmg') || name.endsWith('.dmg.blockmap')) {
      await copyFile(path.join(staging, name), path.join('release', name));
    }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
