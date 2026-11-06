import { BrowserWindow, ipcMain } from 'electron';
import {
  analyzeWorkflow,
  cancelAgentRun,
  clearAgentSession,
  createAgentSession,
  deleteAgentMessages,
  deleteAgentSession,
  getAgentSession,
  getAgentStatus,
  listAgentModels,
  listAgentSessions,
  openLocalPath,
  revealLocalPath,
  sendAgentMessage,
  setAgentConfig,
  switchAgentSession,
  updateAgentSession,
} from './agent-bridge';
import {
  capturePage,
  compareBaseline,
  deleteArtifact,
  deleteWorkflow,
  getBaseline,
  getSchedule,
  getStudioStatus,
  getWorkflow,
  injectAsserts,
  installBrowsers,
  listArtifacts,
  listScriptSteps,
  listWorkflows,
  openArtifactsFolder,
  openTrace,
  openWorkflowFolder,
  playBatch,
  playWorkflow,
  revealArtifact,
  revealStudioRoot,
  runWithParams,
  saveBaseline,
  saveReport,
  setPlaywrightEventSink,
  setSchedule,
  startRecord,
  stopJob,
  updateWorkflow,
} from './playwright-studio';
import { AgentIpc } from '../shared/agent';
import type {
  AgentAnalyzeWorkflowRequest,
  AgentCreateSessionRequest,
  AgentDeleteMessagesRequest,
  AgentSendRequest,
  AgentSetConfigRequest,
  AgentUpdateSessionRequest,
} from '../shared/agent';
import { PlaywrightIpc } from '../shared/playwright';
import type {
  PlaywrightAssertRequest,
  PlaywrightBatchPlayRequest,
  PlaywrightCaptureRequest,
  PlaywrightPlayRequest,
  PlaywrightRecordRequest,
  PlaywrightRunWithParamsRequest,
  PlaywrightSaveBaselineRequest,
  PlaywrightSaveReportRequest,
  PlaywrightScheduleConfig,
  PlaywrightUpdateRequest,
} from '../shared/playwright';

/** Register Playwright Studio + Agent IPC handlers. */
export function registerPlaywrightStudioIpc(): void {
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
  ipcMain.handle(PlaywrightIpc.listScriptSteps, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作流 ID 无效。');
    return listScriptSteps(id);
  });
  ipcMain.handle(PlaywrightIpc.runWithParams, (_event, payload: unknown) => {
    return runWithParams(payload as PlaywrightRunWithParamsRequest, { wait: true });
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
