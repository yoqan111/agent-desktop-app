/**
 * Electron Forge start runs the stock Electron.app, so the macOS Dock
 * tooltip shows "Electron". Patch CFBundleName before launch.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const APP_NAME = 'MediaDo';
const plist = path.join(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/Info.plist',
);

if (process.platform !== 'darwin' || !existsSync(plist)) {
  process.exit(0);
}

function setKey(key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], {
      stdio: 'ignore',
    });
  } catch {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], {
        stdio: 'ignore',
      });
    } catch {
      // ignore — packaged builds use productName instead
    }
  }
}

setKey('CFBundleName', APP_NAME);
setKey('CFBundleDisplayName', APP_NAME);
console.log(`[MediaDo] Electron.app display name -> ${APP_NAME}`);
