import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import started from 'electron-squirrel-startup';
import { grantInput } from './main/access';
import {
  analyzeWorkflow,
  cancelAgentRun,
  clearAgentSession,
  createAgentSession,
  deleteAgentMessages,
  deleteAgentSession,
  getAgentSession,
  getAgentStatus,
  initAgentBridge,
  listAgentModels,
  listAgentSessions,
  openLocalPath,
  revealLocalPath,
  sendAgentMessage,
  setAgentConfig,
  shutdownAgentBridge,
  switchAgentSession,
  updateAgentSession,
} from './main/agent-bridge';
import { startMcpServer, stopMcpServer } from './main/mcp-server';
import { cleanupTempOutputs, exportTempFile } from './main/media';
import { callTool } from './main/tools';
import { installMediaProtocol, registerMediaScheme } from './main/media-protocol';
import {
  assertOrderPaidForExport,
  consumePaidOrder,
  createPayOrder,
  getPayQuote,
  queryPayOrder,
  simulatePayOrder,
} from './main/payment';
import {
  capturePage,
  deleteWorkflow,
  ensureScheduleTimer,
  compareBaseline,
  getBaseline,
  getSchedule,
  getStudioStatus,
  getWorkflow,
  injectAsserts,
  installBrowsers,
  deleteArtifact,
  listArtifacts,
  listWorkflows,
  openArtifactsFolder,
  openTrace,
  openWorkflowFolder,
  playBatch,
  playWorkflow,
  revealArtifact,
  revealStudioRoot,
  saveBaseline,
  saveReport,
  setPlaywrightEventSink,
  setSchedule,
  startRecord,
  stopJob,
  updateWorkflow,
} from './main/playwright-studio';
import { applyDockIcon, createAppWindow, ensureAppWindow, installWindowMenu } from './main/windows';
import { MediaIpc, isAudioFormat, isImageFormat } from './shared/media';
import { EXPORT_REQUIRES_PAYMENT } from './shared/payment';
import type {
  ExportRequest,
  MediaFormat,
  MediaKind,
  MediaProgressEvent,
} from './shared/media';
import { PaymentIpc } from './shared/payment';
import type { CreatePayOrderRequest, PayProduct } from './shared/payment';
import { AgentIpc } from './shared/agent';
import type {
  AgentAnalyzeWorkflowRequest,
  AgentCreateSessionRequest,
  AgentDeleteMessagesRequest,
  AgentSendRequest,
  AgentSetConfigRequest,
  AgentUpdateSessionRequest,
} from './shared/agent';
import { PlaywrightIpc } from './shared/playwright';
import type {
  PlaywrightAssertRequest,
  PlaywrightBatchPlayRequest,
  PlaywrightCaptureRequest,
  PlaywrightPlayRequest,
  PlaywrightRecordRequest,
  PlaywrightSaveBaselineRequest,
  PlaywrightSaveReportRequest,
  PlaywrightScheduleConfig,
  PlaywrightUpdateRequest,
} from './shared/playwright';
import { UpdaterIpc } from './shared/updater';
import { checkForUpdates, getUpdateState, installUpdate, startUpdater } from './updater';

if (started) {
  app.quit();
}

registerMediaScheme();
app.setName('MediaDo');

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

function registerIpcHandlers(): void {
  ipcMain.removeHandler(UpdaterIpc.state);
  ipcMain.removeHandler(UpdaterIpc.check);
  ipcMain.removeHandler(UpdaterIpc.install);
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

  ipcMain.handle(UpdaterIpc.state, () => getUpdateState());
  ipcMain.handle(UpdaterIpc.check, () => checkForUpdates());
  ipcMain.handle(UpdaterIpc.install, () => installUpdate());

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

  for (const channel of Object.values(PlaywrightIpc)) {
    if (channel !== PlaywrightIpc.event) {
      ipcMain.removeHandler(channel);
    }
  }

  setPlaywrightEventSink((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlaywrightIpc.event, payload);
      }
    }
  });

  ipcMain.handle(PlaywrightIpc.status, () => getStudioStatus());
  ipcMain.handle(PlaywrightIpc.list, () => listWorkflows());
  ipcMain.handle(PlaywrightIpc.get, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return getWorkflow(id);
  });
  ipcMain.handle(PlaywrightIpc.record, (_event, payload: unknown) => {
    return startRecord(payload as PlaywrightRecordRequest);
  });
  ipcMain.handle(PlaywrightIpc.play, (_event, payload: unknown) => {
    return playWorkflow(payload as PlaywrightPlayRequest);
  });
  ipcMain.handle(PlaywrightIpc.stop, () => stopJob());
  ipcMain.handle(PlaywrightIpc.update, (_event, payload: unknown) => {
    return updateWorkflow(payload as PlaywrightUpdateRequest);
  });
  ipcMain.handle(PlaywrightIpc.delete, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    deleteWorkflow(id);
  });
  ipcMain.handle(PlaywrightIpc.openFolder, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return openWorkflowFolder(id);
  });
  ipcMain.handle(PlaywrightIpc.revealRoot, () => revealStudioRoot());
  ipcMain.handle(PlaywrightIpc.install, () => installBrowsers());
  ipcMain.handle(PlaywrightIpc.listArtifacts, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return listArtifacts(id);
  });
  ipcMain.handle(PlaywrightIpc.openTrace, (_event, artifactPath: unknown) => {
    if (typeof artifactPath !== 'string') throw new Error('Trace 路径无效。');
    return openTrace(artifactPath);
  });
  ipcMain.handle(PlaywrightIpc.revealArtifact, (_event, artifactPath: unknown) => {
    if (typeof artifactPath !== 'string') throw new Error('产物路径无效。');
    return revealArtifact(artifactPath);
  });
  ipcMain.handle(PlaywrightIpc.openArtifactsFolder, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return openArtifactsFolder(id);
  });
  ipcMain.handle(PlaywrightIpc.deleteArtifact, (_event, artifactPath: unknown) => {
    if (typeof artifactPath !== 'string') throw new Error('产物路径无效。');
    return deleteArtifact(artifactPath);
  });
  ipcMain.handle(PlaywrightIpc.playBatch, (_event, payload: unknown) => {
    return playBatch(payload as PlaywrightBatchPlayRequest);
  });
  ipcMain.handle(PlaywrightIpc.injectAsserts, (_event, payload: unknown) => {
    return injectAsserts(payload as PlaywrightAssertRequest);
  });
  ipcMain.handle(PlaywrightIpc.capturePage, (_event, payload: unknown) => {
    return capturePage(payload as PlaywrightCaptureRequest);
  });
  ipcMain.handle(PlaywrightIpc.saveBaseline, (_event, payload: unknown) => {
    return saveBaseline(payload as PlaywrightSaveBaselineRequest);
  });
  ipcMain.handle(PlaywrightIpc.getBaseline, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return getBaseline(id);
  });
  ipcMain.handle(PlaywrightIpc.compareBaseline, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return compareBaseline(id);
  });
  ipcMain.handle(PlaywrightIpc.saveReport, (_event, payload: unknown) => {
    return saveReport(payload as PlaywrightSaveReportRequest);
  });
  ipcMain.handle(PlaywrightIpc.getSchedule, () => getSchedule());
  ipcMain.handle(PlaywrightIpc.setSchedule, (_event, payload: unknown) => {
    return setSchedule((payload || {}) as Partial<PlaywrightScheduleConfig>);
  });

  for (const channel of Object.values(AgentIpc)) {
    if (channel !== AgentIpc.event) {
      ipcMain.removeHandler(channel);
    }
  }
  ipcMain.handle(AgentIpc.status, () => getAgentStatus());
  ipcMain.handle(AgentIpc.listModels, () => listAgentModels());
  ipcMain.handle(AgentIpc.setConfig, (_event, payload: unknown) => {
    return setAgentConfig((payload || {}) as AgentSetConfigRequest);
  });
  ipcMain.handle(AgentIpc.analyzeWorkflow, (_event, payload: unknown) => {
    return analyzeWorkflow(payload as AgentAnalyzeWorkflowRequest);
  });
  ipcMain.handle(AgentIpc.send, (_event, payload: unknown) => {
    return sendAgentMessage(payload as AgentSendRequest);
  });
  ipcMain.handle(AgentIpc.cancel, () => cancelAgentRun());
  ipcMain.handle(AgentIpc.clearSession, () => clearAgentSession());
  ipcMain.handle(AgentIpc.listSessions, () => listAgentSessions());
  ipcMain.handle(AgentIpc.getSession, (_event, id: unknown) => {
    return getAgentSession(String(id || ''));
  });
  ipcMain.handle(AgentIpc.createSession, (_event, payload: unknown) => {
    return createAgentSession((payload || {}) as AgentCreateSessionRequest);
  });
  ipcMain.handle(AgentIpc.updateSession, (_event, payload: unknown) => {
    return updateAgentSession((payload || {}) as AgentUpdateSessionRequest);
  });
  ipcMain.handle(AgentIpc.deleteSession, (_event, id: unknown) => {
    return deleteAgentSession(String(id || ''));
  });
  ipcMain.handle(AgentIpc.deleteMessages, (_event, payload: unknown) => {
    return deleteAgentMessages((payload || {}) as AgentDeleteMessagesRequest);
  });
  ipcMain.handle(AgentIpc.switchSession, (_event, id: unknown) => {
    return switchAgentSession(String(id || ''));
  });
  ipcMain.handle(AgentIpc.openLocalPath, (_event, targetPath: unknown) => {
    return openLocalPath(String(targetPath || ''));
  });
  ipcMain.handle(AgentIpc.revealLocalPath, (_event, targetPath: unknown) => {
    return revealLocalPath(String(targetPath || ''));
  });
}

app.on('ready', () => {
  app.setName('MediaDo');
  applyDockIcon();
  registerIpcHandlers();
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
