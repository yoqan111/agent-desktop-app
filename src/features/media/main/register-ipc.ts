import { BrowserWindow, dialog, ipcMain } from 'electron';
import { callTool } from '../../../platform/tools';
import { grantInput } from './access';
import { exportTempFile } from './media';
import {
  assertOrderPaidForExport,
  consumePaidOrder,
  createPayOrder,
  getPayQuote,
  queryPayOrder,
  simulatePayOrder,
} from './payment';
import {
  MediaIpc,
  isAudioFormat,
  isImageFormat,
  type ExportRequest,
  type MediaFormat,
  type MediaKind,
  type MediaProgressEvent,
} from '../shared/media';
import {
  EXPORT_REQUIRES_PAYMENT,
  PaymentIpc,
  type CreatePayOrderRequest,
  type PayProduct,
} from '../shared/payment';

const PICK_FILTERS: Record<MediaKind, Electron.FileFilter[]> = {
  video: [
    { name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpeg', 'mpg', 'wmv', 'flv'] },
  ],
  image: [
    { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'] },
  ],
  audio: [
    { name: '音频', extensions: ['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'wma', 'aiff'] },
  ],
};

function sendProgress(sender: Electron.WebContents, event: MediaProgressEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(MediaIpc.progress, event);
  }
}

function progressContext(event: Electron.IpcMainInvokeEvent) {
  return {
    source: 'ui' as const,
    onProgress: (progress: MediaProgressEvent) => sendProgress(event.sender, progress),
  };
}

function exportTitle(format: MediaFormat): string {
  if (format === 'gif') return '导出 GIF';
  if (isImageFormat(format)) return '导出图片';
  if (isAudioFormat(format)) return '导出音频';
  return '导出视频';
}

/** Register media + payment IPC handlers. */
export function registerMediaIpc(): void {
  ipcMain.removeHandler(MediaIpc.pick);
  ipcMain.removeHandler(MediaIpc.probe);
  ipcMain.removeHandler(MediaIpc.convert);
  ipcMain.removeHandler(MediaIpc.crop);
  ipcMain.removeHandler(MediaIpc.trimAudio);
  ipcMain.removeHandler(MediaIpc.gif);
  ipcMain.removeHandler(MediaIpc.enhanceHd);
  ipcMain.removeHandler(MediaIpc.denoiseAudio);
  ipcMain.removeHandler(MediaIpc.export);
  ipcMain.removeHandler(PaymentIpc.quote);
  ipcMain.removeHandler(PaymentIpc.create);
  ipcMain.removeHandler(PaymentIpc.query);
  ipcMain.removeHandler(PaymentIpc.simulate);

  ipcMain.handle(MediaIpc.pick, async (event, kindRaw: unknown) => {
    const kind = (kindRaw === 'image' || kindRaw === 'audio' || kindRaw === 'video')
      ? kindRaw
      : 'video';
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openFile'],
      filters: PICK_FILTERS[kind],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return grantInput(result.filePaths[0]);
  });

  ipcMain.handle(MediaIpc.probe, (event, filePath: unknown, kindRaw: unknown) => {
    return callTool('media_probe', { path: filePath, kind: kindRaw }, progressContext(event));
  });

  ipcMain.handle(MediaIpc.convert, (event, payload: unknown) => {
    return callTool('media_convert', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.crop, (event, payload: unknown) => {
    return callTool('media_crop', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.trimAudio, (event, payload: unknown) => {
    return callTool('media_trim_audio', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.gif, (event, payload: unknown) => {
    return callTool('media_gif', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.enhanceHd, (event, payload: unknown) => {
    return callTool('media_enhance_hd', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.denoiseAudio, (event, payload: unknown) => {
    return callTool('media_denoise_audio', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.removeWatermark, (event, payload: unknown) => {
    return callTool('media_remove_watermark', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.compress, (event, payload: unknown) => {
    return callTool('media_compress', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.orient, (event, payload: unknown) => {
    return callTool('media_orient', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.speed, (event, payload: unknown) => {
    return callTool('media_speed', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.extract, (event, payload: unknown) => {
    return callTool('media_extract', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.snapshot, (event, payload: unknown) => {
    return callTool('media_snapshot', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.aspect, (event, payload: unknown) => {
    return callTool('media_aspect', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.stamp, (event, payload: unknown) => {
    return callTool('media_stamp', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.loudnorm, (event, payload: unknown) => {
    return callTool('media_loudnorm', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.resize, (event, payload: unknown) => {
    return callTool('media_resize', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.adjust, (event, payload: unknown) => {
    return callTool('media_adjust', payload, progressContext(event));
  });

  ipcMain.handle(MediaIpc.export, async (event, payload: unknown) => {
    const request = payload as ExportRequest;
    if (
      typeof request?.tempPath !== 'string'
      || typeof request?.suggestedName !== 'string'
      || (EXPORT_REQUIRES_PAYMENT && typeof request?.orderId !== 'string')
    ) {
      throw new Error('导出参数不合法。');
    }
    if (EXPORT_REQUIRES_PAYMENT) {
      await assertOrderPaidForExport(request.orderId);
    }
    const format = (request.format || 'mp4') as MediaFormat;
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined, {
      title: exportTitle(format),
      defaultPath: request.suggestedName,
      filters: [{ name: format.toUpperCase(), extensions: [format === 'jpg' ? 'jpg' : format] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    const saved = await exportTempFile(request.tempPath, result.filePath);
    if (EXPORT_REQUIRES_PAYMENT) {
      consumePaidOrder(request.orderId);
    }
    return saved;
  });

  ipcMain.handle(PaymentIpc.quote, (_event, product: unknown) => {
    if (product !== 'export') {
      throw new Error('暂不支持该商品。');
    }
    return getPayQuote(product as PayProduct);
  });

  ipcMain.handle(PaymentIpc.create, (_event, payload: unknown) => {
    return createPayOrder(payload as CreatePayOrderRequest);
  });

  ipcMain.handle(PaymentIpc.query, (_event, orderId: unknown) => {
    if (typeof orderId !== 'string') {
      throw new Error('订单号无效。');
    }
    return queryPayOrder(orderId);
  });

  ipcMain.handle(PaymentIpc.simulate, (_event, orderId: unknown) => {
    if (typeof orderId !== 'string') {
      throw new Error('订单号无效。');
    }
    return simulatePayOrder(orderId);
  });
}
