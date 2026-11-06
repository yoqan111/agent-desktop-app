import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { ConfirmIpc, type ConfirmAskPayload, type ConfirmOptions } from '../shared/confirm';

const pending = new Map<string, {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

let listening = false;

function ensureResultListener(): void {
  if (listening) return;
  listening = true;
  ipcMain.on(ConfirmIpc.result, (_event, requestId: unknown, ok: unknown) => {
    if (typeof requestId !== 'string') return;
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve(Boolean(ok));
  });
}

/**
 * Ask the focused/primary renderer window to show the shared ConfirmDialog.
 * Falls back to false when no window is available or the user times out.
 */
export function askUserConfirm(
  options: ConfirmOptions,
  timeoutMs = 5 * 60 * 1000,
): Promise<boolean> {
  ensureResultListener();
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    return Promise.resolve(false);
  }

  const requestId = randomUUID();
  const payload: ConfirmAskPayload = { requestId, ...options };

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(false);
    }, timeoutMs);
    pending.set(requestId, {
      resolve: (ok) => resolve(ok),
      timer,
    });
    win.webContents.send(ConfirmIpc.ask, payload);
  });
}
