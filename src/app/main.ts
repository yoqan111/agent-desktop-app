import { app, ipcMain } from 'electron';
import started from 'electron-squirrel-startup';
import {
  cleanupTempOutputs,
  installMediaProtocol,
  registerMediaIpc,
  registerMediaScheme,
} from '../features/media/main';
import {
  ensureScheduleTimer,
  initAgentBridge,
  registerPlaywrightStudioIpc,
  shutdownAgentBridge,
  stopJob,
} from '../features/playwright-studio/main';
import { startMcpServer, stopMcpServer } from '../platform/mcp-server';
import { UpdaterIpc } from '../shared/updater';
import { checkForUpdates, getUpdateState, installUpdate, startUpdater } from './updater';
import { applyDockIcon, createAppWindow, ensureAppWindow, installWindowMenu } from './windows';

if (started) {
  app.quit();
}

registerMediaScheme();
app.setName('MediaDo');

function registerShellIpc(): void {
  ipcMain.removeHandler(UpdaterIpc.state);
  ipcMain.removeHandler(UpdaterIpc.check);
  ipcMain.removeHandler(UpdaterIpc.install);
  ipcMain.handle(UpdaterIpc.state, () => getUpdateState());
  ipcMain.handle(UpdaterIpc.check, () => checkForUpdates());
  ipcMain.handle(UpdaterIpc.install, () => installUpdate());
}

function registerFeatureIpc(): void {
  registerShellIpc();
  registerMediaIpc();
  registerPlaywrightStudioIpc();
}

app.on('ready', () => {
  app.setName('MediaDo');
  applyDockIcon();
  registerFeatureIpc();
  try {
    installMediaProtocol();
  } catch (error) {
    console.error('installMediaProtocol', error);
  }
  installWindowMenu();
  startUpdater();
  void startMcpServer()
    .then(() => {
      initAgentBridge();
    })
    .catch((error) => {
      console.error('startMcpServer', error);
      initAgentBridge();
    });
  ensureScheduleTimer();
  createAppWindow();
});

app.on('before-quit', () => {
  void stopJob();
  void shutdownAgentBridge();
  stopMcpServer();
  cleanupTempOutputs();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  ensureAppWindow();
});
