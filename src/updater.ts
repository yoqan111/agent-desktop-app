import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import { idleUpdateState, UpdaterIpc } from './shared/updater';
import type { UpdateState } from './shared/updater';

let state: UpdateState = { ...idleUpdateState };
let started = false;

function publish(next: UpdateState): void {
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(UpdaterIpc.event, state);
  }
}

function feedBase(): string {
  return (process.env.UPDATE_BASE_URL ?? '').replace(/\/+$/, '');
}

function githubRepo(): string {
  return process.env.GITHUB_REPOSITORY ?? '';
}

export function getUpdateState(): UpdateState {
  return state;
}

export function startUpdater(): void {
  if (started) {
    return;
  }
  started = true;

  const base = feedBase();
  const repo = githubRepo();
  const supported = process.platform === 'darwin' || process.platform === 'win32';
  if (!app.isPackaged || !supported || (!base && !repo)) {
    publish({
      phase: 'disabled',
      version: app.getVersion(),
      message: '当前环境不检查更新。',
    });
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    publish({ phase: 'checking', version: app.getVersion(), message: '正在检查更新。' });
  });
  autoUpdater.on('update-available', () => {
    publish({ phase: 'available', version: app.getVersion(), message: '发现新版本，正在下载。' });
  });
  autoUpdater.on('update-not-available', () => {
    publish({ phase: 'not-available', version: app.getVersion(), message: '已是最新版本。' });
  });
  autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => {
    const version = typeof releaseName === 'string' && releaseName ? releaseName : '';
    publish({
      phase: 'downloaded',
      version,
      message: version ? `版本 ${version} 已下载，重启后完成安装。` : '更新已下载，重启后完成安装。',
    });
  });
  autoUpdater.on('error', (error) => {
    publish({
      phase: 'error',
      version: app.getVersion(),
      message: error instanceof Error ? error.message : '检查更新失败。',
    });
  });

  updateElectronApp({
    updateInterval: '1 hour',
    notifyUser: false,
    logger: console,
    updateSource: base
      ? {
        type: UpdateSourceType.StaticStorage,
        baseUrl: `${base}/${process.platform}/${process.arch}`,
      }
      : {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo,
      },
  });
}

export function checkForUpdates(): UpdateState {
  if (state.phase === 'disabled') {
    return state;
  }
  autoUpdater.checkForUpdates();
  return state;
}

export function installUpdate(): void {
  if (state.phase !== 'downloaded') {
    return;
  }
  autoUpdater.quitAndInstall();
}
