import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { MediaIpc, toMediaPreviewUrl } from '../features/media/shared/media';
import type {
  AspectRequest,
  CompressRequest,
  ConvertRequest,
  CropRequest,
  DenoiseAudioRequest,
  EnhanceHdRequest,
  ExportRequest,
  ExtractRequest,
  GifRequest,
  LoudnormRequest,
  MediaApi,
  MediaKind,
  MediaProgressEvent,
  OrientRequest,
  RemoveWatermarkRequest,
  ResizeRequest,
  SnapshotRequest,
  SpeedRequest,
  StampRequest,
  TrimAudioRequest,
  VideoAdjustRequest,
} from '../features/media/shared/media';
import { PaymentIpc } from '../features/media/shared/payment';
import type {
  CreatePayOrderRequest,
  PayProduct,
  PaymentApi,
} from '../features/media/shared/payment';
import { AgentIpc } from '../features/playwright-studio/shared/agent';
import type {
  AgentAnalyzeWorkflowRequest,
  AgentApi,
  AgentCreateSessionRequest,
  AgentDeleteMessagesRequest,
  AgentSendRequest,
  AgentSetConfigRequest,
  AgentStreamEvent,
  AgentUpdateSessionRequest,
} from '../features/playwright-studio/shared/agent';
import { ConfirmIpc } from '../shared/confirm';
import type { ConfirmAskPayload } from '../shared/confirm';
import { PlaywrightIpc } from '../features/playwright-studio/shared/playwright';
import type {
  PlaywrightApi,
  PlaywrightAssertRequest,
  PlaywrightBatchPlayRequest,
  PlaywrightCaptureRequest,
  PlaywrightPlayRequest,
  PlaywrightRecordRequest,
  PlaywrightRunEvent,
  PlaywrightScheduleConfig,
  PlaywrightUpdateRequest,
} from '../features/playwright-studio/shared/playwright';
import { UpdaterIpc } from '../shared/updater';
import type { UpdateState, UpdaterApi } from '../shared/updater';

const media: MediaApi = {
  pickMedia: (kind: MediaKind) => ipcRenderer.invoke(MediaIpc.pick, kind),
  probe: (filePath, kind) => ipcRenderer.invoke(MediaIpc.probe, filePath, kind),
  convert: (request: ConvertRequest) => ipcRenderer.invoke(MediaIpc.convert, request),
  crop: (request: CropRequest) => ipcRenderer.invoke(MediaIpc.crop, request),
  trimAudio: (request: TrimAudioRequest) => ipcRenderer.invoke(MediaIpc.trimAudio, request),
  toGif: (request: GifRequest) => ipcRenderer.invoke(MediaIpc.gif, request),
  enhanceHd: (request: EnhanceHdRequest) => ipcRenderer.invoke(MediaIpc.enhanceHd, request),
  denoiseAudio: (request: DenoiseAudioRequest) => ipcRenderer.invoke(MediaIpc.denoiseAudio, request),
  removeWatermark: (request: RemoveWatermarkRequest) => ipcRenderer.invoke(MediaIpc.removeWatermark, request),
  compress: (request: CompressRequest) => ipcRenderer.invoke(MediaIpc.compress, request),
  orient: (request: OrientRequest) => ipcRenderer.invoke(MediaIpc.orient, request),
  changeSpeed: (request: SpeedRequest) => ipcRenderer.invoke(MediaIpc.speed, request),
  extractMedia: (request: ExtractRequest) => ipcRenderer.invoke(MediaIpc.extract, request),
  snapshot: (request: SnapshotRequest) => ipcRenderer.invoke(MediaIpc.snapshot, request),
  fitAspect: (request: AspectRequest) => ipcRenderer.invoke(MediaIpc.aspect, request),
  stamp: (request: StampRequest) => ipcRenderer.invoke(MediaIpc.stamp, request),
  loudnorm: (request: LoudnormRequest) => ipcRenderer.invoke(MediaIpc.loudnorm, request),
  resizeImage: (request: ResizeRequest) => ipcRenderer.invoke(MediaIpc.resize, request),
  adjustVideo: (request: VideoAdjustRequest) => ipcRenderer.invoke(MediaIpc.adjust, request),
  exportFile: (request: ExportRequest) => ipcRenderer.invoke(MediaIpc.export, request),
  previewUrl: (filePath) => toMediaPreviewUrl(filePath),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      const legacy = (file as File & { path?: string }).path;
      return typeof legacy === 'string' ? legacy : '';
    }
  },
  onProgress: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: MediaProgressEvent) => handler(payload);
    ipcRenderer.on(MediaIpc.progress, listener);
    return () => ipcRenderer.removeListener(MediaIpc.progress, listener);
  },
};

contextBridge.exposeInMainWorld('media', media);

const payment: PaymentApi = {
  getQuote: (product: PayProduct) => ipcRenderer.invoke(PaymentIpc.quote, product),
  createOrder: (request: CreatePayOrderRequest) => ipcRenderer.invoke(PaymentIpc.create, request),
  queryOrder: (orderId) => ipcRenderer.invoke(PaymentIpc.query, orderId),
  simulatePay: (orderId) => ipcRenderer.invoke(PaymentIpc.simulate, orderId),
};

contextBridge.exposeInMainWorld('payment', payment);

const updater: UpdaterApi = {
  getState: () => ipcRenderer.invoke(UpdaterIpc.state),
  check: () => ipcRenderer.invoke(UpdaterIpc.check),
  install: () => ipcRenderer.invoke(UpdaterIpc.install),
  onState: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateState) => handler(payload);
    ipcRenderer.on(UpdaterIpc.event, listener);
    return () => ipcRenderer.removeListener(UpdaterIpc.event, listener);
  },
};

contextBridge.exposeInMainWorld('updater', updater);

const playwright: PlaywrightApi = {
  getStatus: () => ipcRenderer.invoke(PlaywrightIpc.status),
  listWorkflows: () => ipcRenderer.invoke(PlaywrightIpc.list),
  getWorkflow: (id) => ipcRenderer.invoke(PlaywrightIpc.get, id),
  startRecord: (request: PlaywrightRecordRequest) => ipcRenderer.invoke(PlaywrightIpc.record, request),
  play: (request: PlaywrightPlayRequest) => ipcRenderer.invoke(PlaywrightIpc.play, request),
  playBatch: (request: PlaywrightBatchPlayRequest) => ipcRenderer.invoke(PlaywrightIpc.playBatch, request),
  stopJob: () => ipcRenderer.invoke(PlaywrightIpc.stop),
  updateWorkflow: (request: PlaywrightUpdateRequest) => ipcRenderer.invoke(PlaywrightIpc.update, request),
  deleteWorkflow: (id) => ipcRenderer.invoke(PlaywrightIpc.delete, id),
  openWorkflowFolder: (id) => ipcRenderer.invoke(PlaywrightIpc.openFolder, id),
  revealStudioRoot: () => ipcRenderer.invoke(PlaywrightIpc.revealRoot),
  installBrowsers: () => ipcRenderer.invoke(PlaywrightIpc.install),
  listArtifacts: (id) => ipcRenderer.invoke(PlaywrightIpc.listArtifacts, id),
  openTrace: (artifactPath) => ipcRenderer.invoke(PlaywrightIpc.openTrace, artifactPath),
  revealArtifact: (artifactPath) => ipcRenderer.invoke(PlaywrightIpc.revealArtifact, artifactPath),
  openArtifactsFolder: (id) => ipcRenderer.invoke(PlaywrightIpc.openArtifactsFolder, id),
  deleteArtifact: (artifactPath) => ipcRenderer.invoke(PlaywrightIpc.deleteArtifact, artifactPath),
  injectAsserts: (request: PlaywrightAssertRequest) => ipcRenderer.invoke(PlaywrightIpc.injectAsserts, request),
  capturePage: (request: PlaywrightCaptureRequest) => ipcRenderer.invoke(PlaywrightIpc.capturePage, request),
  saveBaseline: (request) => ipcRenderer.invoke(PlaywrightIpc.saveBaseline, request),
  getBaseline: (workflowId) => ipcRenderer.invoke(PlaywrightIpc.getBaseline, workflowId),
  compareBaseline: (workflowId) => ipcRenderer.invoke(PlaywrightIpc.compareBaseline, workflowId),
  saveReport: (request) => ipcRenderer.invoke(PlaywrightIpc.saveReport, request),
  listScriptSteps: (workflowId) => ipcRenderer.invoke(PlaywrightIpc.listScriptSteps, workflowId),
  runWithParams: (request) => ipcRenderer.invoke(PlaywrightIpc.runWithParams, request),
  getSchedule: () => ipcRenderer.invoke(PlaywrightIpc.getSchedule),
  setSchedule: (config: Partial<PlaywrightScheduleConfig>) => ipcRenderer.invoke(PlaywrightIpc.setSchedule, config),
  onRunEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PlaywrightRunEvent) => handler(payload);
    ipcRenderer.on(PlaywrightIpc.event, listener);
    return () => ipcRenderer.removeListener(PlaywrightIpc.event, listener);
  },
};

contextBridge.exposeInMainWorld('playwright', playwright);

const agent: AgentApi = {
  getStatus: () => ipcRenderer.invoke(AgentIpc.status),
  listModels: () => ipcRenderer.invoke(AgentIpc.listModels),
  setConfig: (request: AgentSetConfigRequest) => ipcRenderer.invoke(AgentIpc.setConfig, request),
  analyzeWorkflow: (request: AgentAnalyzeWorkflowRequest) => ipcRenderer.invoke(AgentIpc.analyzeWorkflow, request),
  send: (request: AgentSendRequest) => ipcRenderer.invoke(AgentIpc.send, request),
  cancel: () => ipcRenderer.invoke(AgentIpc.cancel),
  clearSession: () => ipcRenderer.invoke(AgentIpc.clearSession),
  listSessions: () => ipcRenderer.invoke(AgentIpc.listSessions),
  getSession: (id: string) => ipcRenderer.invoke(AgentIpc.getSession, id),
  createSession: (request?: AgentCreateSessionRequest) => ipcRenderer.invoke(AgentIpc.createSession, request || {}),
  updateSession: (request: AgentUpdateSessionRequest) => ipcRenderer.invoke(AgentIpc.updateSession, request),
  deleteSession: (id: string) => ipcRenderer.invoke(AgentIpc.deleteSession, id),
  switchSession: (id: string) => ipcRenderer.invoke(AgentIpc.switchSession, id),
  deleteMessages: (request: AgentDeleteMessagesRequest) => ipcRenderer.invoke(AgentIpc.deleteMessages, request),
  openLocalPath: (targetPath: string) => ipcRenderer.invoke(AgentIpc.openLocalPath, targetPath),
  revealLocalPath: (targetPath: string) => ipcRenderer.invoke(AgentIpc.revealLocalPath, targetPath),
  onEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentStreamEvent) => handler(payload);
    ipcRenderer.on(AgentIpc.event, listener);
    return () => ipcRenderer.removeListener(AgentIpc.event, listener);
  },
};

contextBridge.exposeInMainWorld('agent', agent);

const confirmUi = {
  onAskFromMain: (handler: (payload: ConfirmAskPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ConfirmAskPayload) => handler(payload);
    ipcRenderer.on(ConfirmIpc.ask, listener);
    return () => ipcRenderer.removeListener(ConfirmIpc.ask, listener);
  },
  respondToMain: (requestId: string, ok: boolean) => {
    ipcRenderer.send(ConfirmIpc.result, requestId, ok);
  },
};

contextBridge.exposeInMainWorld('confirmUi', confirmUi);
