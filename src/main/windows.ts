import { app, BrowserWindow, Menu, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

function appIconPath(): string {
  return path.join(__dirname, '../../build/icon.png');
}

export function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) {
    return;
  }
  const iconPath = appIconPath();
  if (!existsSync(iconPath)) {
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    app.dock.setIcon(image);
  }
}

export function installWindowMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '新窗口',
          accelerator: 'CommandOrControl+N',
          click: () => createAppWindow(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]));
}

export function createAppWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'MediaDo',
    icon: existsSync(appIconPath()) ? appIconPath() : undefined,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#050505',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  return win;
}

export function ensureAppWindow(): void {
  if (BrowserWindow.getAllWindows().length === 0) {
    createAppWindow();
  }
}

export function appName(): string {
  return app.getName() || 'MediaDo';
}
