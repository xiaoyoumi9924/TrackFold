const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = {
  appId: 'io.github.xiaoyoumi9924.shiyin', productName: '拾音',
  protocols: [{ name: '拾音浏览器扩展', schemes: ['shiyin-audio'] }],
  directories: { output: 'release' },
  ...(process.env.SHIYIN_USE_LOCAL_ELECTRON === '1' ? { electronDist: 'node_modules/electron/dist' } : {}),
  files: ['desktop/**', 'desktop-build/server.mjs', 'dist/**', 'package.json', '!node_modules/tsx/**', '!node_modules/@esbuild/**', '!node_modules/esbuild/**'],
  extraResources: [{ from: 'desktop-build/bin', to: 'bin' }, { from: 'desktop-build/licenses', to: 'licenses' }],
  asarUnpack: ['node_modules/playwright*/**'],
  npmRebuild: false,
  toolsets: { nsis: '1.2.1' },
  afterPack: ({ appOutDir, electronPlatformName, packager }) => {
    if (electronPlatformName !== 'darwin') return;
    const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
    // Copied Finder metadata can prevent codesign from sealing the bundle.
    execFileSync('/usr/bin/xattr', ['-cr', app]);
  },
  mac: { target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.music', icon: 'desktop/icon.icns',
    identity: '-', hardenedRuntime: false, notarize: false, timestamp: 'none', minimumSystemVersion: '13.0.0',
    artifactName: 'Shiyin-${version}-mac-${arch}.${ext}' },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop/icon.icns',
    artifactName: 'Shiyin-${version}-windows-${arch}.${ext}' },
  linux: { target: [{ target: 'deb', arch: ['x64'] }], executableName: 'shiyin', syncDesktopName: true,
    category: 'AudioVideo', maintainer: 'xiaoyoumi9924 <311762328+xiaoyoumi9924@users.noreply.github.com>',
    artifactName: 'Shiyin-${version}-linux-${arch}.${ext}' },
  dmg: { title: '拾音 ${version}' },
};
