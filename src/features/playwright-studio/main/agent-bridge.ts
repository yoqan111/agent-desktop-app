import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, safeStorage, shell } from 'electron';
import {
  AGENT_CURATED_MODELS,
  AGENT_FALLBACK_MODELS,
  DEFAULT_OPENAI_BASE_URL,
  OPENAI_COMPAT_PRESET_MODELS,
  agentModelKey,
  mergeAgentModels,
  parseAgentModelKey,
  type AgentAnalyzeMode,
  type AgentAnalyzeWorkflowRequest,
  type AgentBridgeStatus,
  type AgentChatMessage,
  type AgentChatSession,
  type AgentChatSessionSummary,
  type AgentCreateSessionRequest,
  type AgentCustomModel,
  type AgentDeleteMessagesRequest,
  type AgentModelInfo,
  type AgentModelParam,
  type AgentProviderKind,
  type AgentSendRequest,
  type AgentSessionPhase,
  type AgentSetConfigRequest,
  type AgentStreamEvent,
  type AgentUpdateSessionRequest,
} from '../shared/agent';
import { AgentIpc } from '../shared/agent';
import { guessModelGroup } from '../shared/agent-models';
import {
  appendChatMessage,
  clearChatSessionMessages,
  createChatSession,
  deleteChatMessages,
  deleteChatSession,
  ensureActiveChatSession,
  flushChatMessagePersist,
  getActiveChatSessionId,
  listChatSessions,
  readSession,
  scheduleUpsertChatMessage,
  setActiveChatSessionId,
  updateChatSession,
  upsertChatMessage,
} from './agent-sessions';
import { getMcpServerUrl } from '../../../platform/mcp-server';
import { runOpenAICompatibleAgent } from './openai-agent';
import {
  capturePage,
  compareBaseline,
  getWorkflow,
  listArtifacts,
  listScriptSteps,
} from './playwright-studio';
import type { PlaywrightRunMode, PlaywrightScriptStep } from '../shared/playwright';

type ModelSelection = { id: string; params?: AgentModelParam[] };

type SdkAgent = {
  agentId?: string;
  send: (message: string, options?: { model?: ModelSelection }) => Promise<{
    id?: string;
    stream: () => AsyncIterable<unknown>;
    wait: () => Promise<{ status?: string; result?: string }>;
    cancel?: () => Promise<void>;
    supports?: (op: string) => boolean;
  }>;
  [Symbol.asyncDispose]?: () => Promise<void>;
  close?: () => Promise<void> | void;
};

interface PersistedModelSelection {
  modelId: string;
  modelKey?: string;
  modelParams?: AgentModelParam[];
}

interface PersistedAgentConfig {
  modelId: string;
  modelParams?: AgentModelParam[];
  /** Exact select value (id + params) for precise restore. */
  modelKey?: string;
  provider?: AgentProviderKind;
  baseUrl?: string;
  customModels?: AgentCustomModel[];
  /** Remember last selected model for each provider. */
  lastModels?: Partial<Record<AgentProviderKind, PersistedModelSelection>>;
  /** Legacy single-key field (migrated into provider slots). */
  apiKeyEnc?: string;
  cursorApiKeyEnc?: string;
  openaiApiKeyEnc?: string;
}

const DEFAULT_MODEL_ID = 'composer-2.5';
const DEFAULT_OPENAI_MODEL_ID = 'gpt-4o';

let phase: AgentSessionPhase = 'idle';
let provider: AgentProviderKind = 'cursor';
let baseUrl = DEFAULT_OPENAI_BASE_URL;
let customModels: AgentCustomModel[] = [];
let modelId = DEFAULT_MODEL_ID;
let modelParams: AgentModelParam[] | undefined;
let modelsCache: AgentModelInfo[] = mergeAgentModels(AGENT_CURATED_MODELS, []);
let cursorApiKey = '';
let openaiApiKey = '';
let sessionId: string | null = null;
let workflowId: string | null = null;
let lastError: string | null = null;
let activeAgent: SdkAgent | null = null;
let activeRunCancel: (() => Promise<void>) | null = null;
let runToken = 0;
let activeModelKey = agentModelKey({ id: DEFAULT_MODEL_ID });
let openaiAbort: AbortController | null = null;
let lastModels: Partial<Record<AgentProviderKind, PersistedModelSelection>> = {};

function configPath(): string {
  const dir = path.join(app.getPath('userData'), 'agent');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

function agentWorkspaceDir(): string {
  const dir = path.join(app.getPath('userData'), 'agent', 'workspace');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function emit(event: AgentStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(AgentIpc.event, event);
    }
  }
}

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function encryptSecret(value: string): string {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  }
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
}

function decryptSecret(blob?: string): string {
  if (!blob) return '';
  try {
    if (blob.startsWith('enc:')) {
      const raw = Buffer.from(blob.slice(4), 'base64');
      return safeStorage.decryptString(raw);
    }
    if (blob.startsWith('plain:')) {
      return Buffer.from(blob.slice(6), 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

function currentModelSelection(): ModelSelection {
  return modelParams?.length
    ? { id: modelId, params: modelParams }
    : { id: modelId };
}

function applyModelSelection(selection: ModelSelection): void {
  modelId = selection.id;
  modelParams = selection.params?.length ? selection.params : undefined;
  activeModelKey = agentModelKey(selection);
  lastModels = {
    ...lastModels,
    [provider]: {
      modelId,
      modelKey: activeModelKey,
      modelParams,
    },
  };
}

function selectionFromPersisted(raw?: PersistedModelSelection | null): ModelSelection | null {
  if (!raw || typeof raw.modelId !== 'string' || !raw.modelId.trim()) return null;
  if (typeof raw.modelKey === 'string' && raw.modelKey.trim()) {
    return parseAgentModelKey(raw.modelKey.trim());
  }
  return {
    id: raw.modelId.trim(),
    params: Array.isArray(raw.modelParams) ? raw.modelParams : undefined,
  };
}

function rememberCurrentModel(): void {
  lastModels = {
    ...lastModels,
    [provider]: {
      modelId,
      modelKey: activeModelKey,
      modelParams,
    },
  };
}

function resolveModelSelection(input?: {
  modelId?: string;
  modelKey?: string;
  modelParams?: AgentModelParam[];
}): ModelSelection {
  if (input?.modelKey?.trim()) {
    return parseAgentModelKey(input.modelKey.trim());
  }
  if (input?.modelId?.trim()) {
    return {
      id: input.modelId.trim(),
      params: input.modelParams?.length ? input.modelParams : undefined,
    };
  }
  return currentModelSelection();
}

function normalizeCustomModels(list: unknown): AgentCustomModel[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: AgentCustomModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as AgentCustomModel).id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = String((item as AgentCustomModel).displayName || '').trim();
    out.push(displayName ? { id, displayName } : { id });
  }
  return out;
}

function customModelsAsInfo(): AgentModelInfo[] {
  return customModels.map((item) => ({
    id: item.id,
    displayName: item.displayName || item.id,
    description: '自定义模型',
    group: '自定义',
    key: agentModelKey({ id: item.id }),
  }));
}

function buildOpenAIModels(): AgentModelInfo[] {
  return mergeAgentModels(OPENAI_COMPAT_PRESET_MODELS, customModelsAsInfo());
}

function ensureModelForProvider(options?: { preferRemembered?: boolean }): void {
  const models = provider === 'openai-compatible'
    ? buildOpenAIModels()
    : (modelsCache.length ? modelsCache : mergeAgentModels(AGENT_CURATED_MODELS, []));
  if (provider === 'openai-compatible') {
    modelsCache = models;
  }

  if (options?.preferRemembered) {
    const remembered = selectionFromPersisted(lastModels[provider]);
    if (remembered) {
      const exact = models.find((item) => agentModelKey(item) === agentModelKey(remembered));
      if (exact) {
        applyModelSelection({ id: exact.id, params: exact.params || remembered.params });
        return;
      }
      const byId = models.find((item) => item.id === remembered.id);
      if (byId) {
        applyModelSelection({
          id: byId.id,
          params: remembered.params?.length ? remembered.params : byId.params,
        });
        return;
      }
      // Keep remembered id even if catalog hasn't loaded yet (e.g. offline / before refresh).
      applyModelSelection(remembered);
      return;
    }
  }

  if (models.some((item) => agentModelKey(item) === activeModelKey)) {
    return;
  }

  const byId = models.find((item) => item.id === modelId);
  if (byId) {
    applyModelSelection({
      id: byId.id,
      params: modelParams?.length ? modelParams : byId.params,
    });
    return;
  }

  const preferredId = provider === 'openai-compatible' ? DEFAULT_OPENAI_MODEL_ID : DEFAULT_MODEL_ID;
  const fallback = models.find((item) => item.id === preferredId) || models[0];
  if (fallback) {
    applyModelSelection({ id: fallback.id, params: fallback.params });
  }
}

function loadConfig(): void {
  const file = configPath();
  if (!existsSync(file)) {
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PersistedAgentConfig;
    if (raw.provider === 'cursor' || raw.provider === 'openai-compatible') {
      provider = raw.provider;
    }
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) {
      baseUrl = raw.baseUrl.trim().replace(/\/+$/, '');
    }
    customModels = normalizeCustomModels(raw.customModels);
    if (raw.lastModels && typeof raw.lastModels === 'object') {
      const next: Partial<Record<AgentProviderKind, PersistedModelSelection>> = {};
      for (const kind of ['cursor', 'openai-compatible'] as AgentProviderKind[]) {
        const item = raw.lastModels[kind];
        const parsed = selectionFromPersisted(item);
        if (parsed) {
          next[kind] = {
            modelId: parsed.id,
            modelKey: agentModelKey(parsed),
            modelParams: parsed.params,
          };
        }
      }
      lastModels = next;
    }

    const preferred = selectionFromPersisted(lastModels[provider])
      || selectionFromPersisted(
        typeof raw.modelId === 'string' && raw.modelId.trim()
          ? {
            modelId: raw.modelId.trim(),
            modelKey: typeof raw.modelKey === 'string' ? raw.modelKey : undefined,
            modelParams: Array.isArray(raw.modelParams) ? raw.modelParams : undefined,
          }
          : null,
      );
    if (preferred) {
      // Avoid writing through applyModelSelection before provider models are ready.
      modelId = preferred.id;
      modelParams = preferred.params?.length ? preferred.params : undefined;
      activeModelKey = agentModelKey(preferred);
      rememberCurrentModel();
    }

    cursorApiKey = decryptSecret(raw.cursorApiKeyEnc);
    openaiApiKey = decryptSecret(raw.openaiApiKeyEnc);
    // Migrate legacy single apiKeyEnc into the active/default Cursor slot.
    const legacy = decryptSecret(raw.apiKeyEnc);
    if (legacy) {
      if (provider === 'openai-compatible' && !openaiApiKey) {
        openaiApiKey = legacy;
      } else if (!cursorApiKey) {
        cursorApiKey = legacy;
      }
    }
    ensureModelForProvider({ preferRemembered: true });
  } catch {
    // ignore corrupt config
  }
}

function saveConfig(): void {
  rememberCurrentModel();
  const payload: PersistedAgentConfig = {
    provider,
    baseUrl,
    customModels,
    modelId,
    modelKey: activeModelKey,
    modelParams,
    lastModels,
    cursorApiKeyEnc: cursorApiKey ? encryptSecret(cursorApiKey) : undefined,
    openaiApiKeyEnc: openaiApiKey ? encryptSecret(openaiApiKey) : undefined,
  };
  writeFileSync(configPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function resolveApiKey(): string {
  if (provider === 'openai-compatible') {
    return (
      openaiApiKey
      || process.env.OPENAI_API_KEY
      || process.env.OPENAI_COMPATIBLE_API_KEY
      || ''
    ).trim();
  }
  return (cursorApiKey || process.env.CURSOR_API_KEY || '').trim();
}

function resolveBaseUrl(): string {
  const fromEnv = (
    process.env.OPENAI_BASE_URL
    || process.env.OPENAI_COMPATIBLE_BASE_URL
    || ''
  ).trim().replace(/\/+$/, '');
  return (baseUrl || fromEnv || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
}

function setActiveApiKey(value: string): void {
  if (provider === 'openai-compatible') {
    openaiApiKey = value;
  } else {
    cursorApiKey = value;
  }
}

function clearActiveApiKey(): void {
  if (provider === 'openai-compatible') {
    openaiApiKey = '';
  } else {
    cursorApiKey = '';
  }
}

function expandSdkModels(listed: Array<{
  id: string;
  displayName?: string;
  description?: string;
  variants?: Array<{ displayName?: string; description?: string; params?: AgentModelParam[]; isDefault?: boolean }>;
}>): AgentModelInfo[] {
  const out: AgentModelInfo[] = [];
  for (const item of listed || []) {
    const group = guessModelGroup(item.id);
    if (item.variants?.length) {
      for (const variant of item.variants) {
        const params = variant.params?.length ? variant.params : undefined;
        out.push({
          id: item.id,
          displayName: variant.displayName || item.displayName || item.id,
          description: variant.description || item.description,
          group,
          params,
          key: agentModelKey({ id: item.id, params }),
        });
      }
    } else {
      out.push({
        id: item.id,
        displayName: item.displayName || item.id,
        description: item.description,
        group,
        key: agentModelKey({ id: item.id }),
      });
    }
  }
  return out;
}

async function fetchRestModels(apiKeyValue: string): Promise<AgentModelInfo[]> {
  try {
    const response = await fetch('https://api.cursor.com/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKeyValue}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) return [];
    const json = await response.json() as {
      items?: Array<{ id?: string; display_name?: string; displayName?: string; description?: string }>;
      models?: Array<{ id?: string; display_name?: string; displayName?: string; description?: string }>;
    };
    const rows = json.items || json.models || [];
    return rows
      .filter((row): row is { id: string; display_name?: string; displayName?: string; description?: string } => (
        typeof row?.id === 'string' && row.id.trim().length > 0
      ))
      .map((row) => ({
        id: row.id,
        displayName: row.displayName || row.display_name || row.id,
        description: row.description,
        group: guessModelGroup(row.id),
        key: agentModelKey({ id: row.id }),
      }));
  } catch {
    return [];
  }
}

function activeChatId(): string {
  return ensureActiveChatSession({ workflowId }).id;
}

function persistMessage(message: AgentChatMessage, mode: 'append' | 'upsert' | 'stream' = 'append'): void {
  const chatId = getActiveChatSessionId() || activeChatId();
  if (mode === 'stream') {
    scheduleUpsertChatMessage(chatId, message);
    return;
  }
  if (mode === 'upsert') {
    upsertChatMessage(chatId, message);
    return;
  }
  appendChatMessage(chatId, message);
}

export function getAgentStatus(): AgentBridgeStatus {
  const key = resolveApiKey();
  if (provider === 'openai-compatible') {
    modelsCache = buildOpenAIModels();
  } else if (!modelsCache.length) {
    modelsCache = mergeAgentModels(AGENT_CURATED_MODELS, []);
  }
  return {
    ready: Boolean(key),
    hasApiKey: Boolean(key),
    apiKeyHint: maskApiKey(key),
    provider,
    baseUrl: resolveBaseUrl(),
    customModels: [...customModels],
    modelId,
    modelKey: activeModelKey,
    modelParams,
    models: modelsCache,
    mcpUrl: getMcpServerUrl(),
    sessionId,
    chatSessionId: getActiveChatSessionId(),
    phase,
    workflowId,
    lastError,
  };
}

async function loadSdk(): Promise<typeof import('@cursor/sdk')> {
  // Externalized at build time; runtime require keeps Electron main happy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@cursor/sdk') as typeof import('@cursor/sdk');
}

export async function listAgentModels(): Promise<AgentModelInfo[]> {
  if (provider === 'openai-compatible') {
    modelsCache = buildOpenAIModels();
    ensureModelForProvider({ preferRemembered: true });
    saveConfig();
    lastError = null;
    return modelsCache;
  }

  const key = resolveApiKey();
  if (!key) {
    modelsCache = mergeAgentModels(AGENT_CURATED_MODELS, []);
    ensureModelForProvider({ preferRemembered: true });
    return modelsCache;
  }
  try {
    const { Cursor } = await loadSdk();
    const [listed, rest] = await Promise.all([
      Cursor.models.list({ apiKey: key }).catch(() => []),
      fetchRestModels(key),
    ]);
    const fromSdk = expandSdkModels(listed || []);
    modelsCache = mergeAgentModels(AGENT_CURATED_MODELS, [...fromSdk, ...rest]);
    ensureModelForProvider({ preferRemembered: true });
    saveConfig();
    lastError = null;
    return modelsCache;
  } catch (error) {
    lastError = error instanceof Error ? error.message : '拉取模型列表失败';
    modelsCache = mergeAgentModels(AGENT_FALLBACK_MODELS, []);
    ensureModelForProvider({ preferRemembered: true });
    return modelsCache;
  }
}

export async function setAgentConfig(request: AgentSetConfigRequest): Promise<AgentBridgeStatus> {
  const prevProvider = provider;
  let keyChanged = request.clearApiKey || typeof request.apiKey === 'string';
  let providerChanged = false;

  if (request.provider === 'cursor' || request.provider === 'openai-compatible') {
    if (request.provider !== provider) {
      rememberCurrentModel();
      provider = request.provider;
      providerChanged = true;
      keyChanged = true;
    }
  }
  if (typeof request.baseUrl === 'string') {
    const next = request.baseUrl.trim().replace(/\/+$/, '');
    baseUrl = next || DEFAULT_OPENAI_BASE_URL;
  }
  if (Array.isArray(request.customModels)) {
    customModels = normalizeCustomModels(request.customModels);
  }
  if (request.addCustomModel?.id?.trim()) {
    const id = request.addCustomModel.id.trim();
    const displayName = request.addCustomModel.displayName?.trim();
    customModels = normalizeCustomModels([
      ...customModels.filter((item) => item.id !== id),
      displayName ? { id, displayName } : { id },
    ]);
  }
  if (typeof request.removeCustomModelId === 'string' && request.removeCustomModelId.trim()) {
    const removeId = request.removeCustomModelId.trim();
    customModels = customModels.filter((item) => item.id !== removeId);
  }

  if (request.clearApiKey) {
    clearActiveApiKey();
  } else if (typeof request.apiKey === 'string') {
    setActiveApiKey(request.apiKey.trim());
  }
  if (request.modelKey || request.modelId) {
    applyModelSelection(resolveModelSelection(request));
  } else if (providerChanged) {
    ensureModelForProvider({ preferRemembered: true });
  }
  saveConfig();
  // Model / provider switch should recreate agent on next send.
  await disposeAgent();
  lastError = null;

  if (provider === 'openai-compatible') {
    modelsCache = buildOpenAIModels();
    ensureModelForProvider({ preferRemembered: true });
    saveConfig();
  } else if (keyChanged || providerChanged) {
    modelsCache = mergeAgentModels(AGENT_CURATED_MODELS, modelsCache);
    if (resolveApiKey()) {
      try {
        await listAgentModels();
      } catch (error) {
        lastError = error instanceof Error ? error.message : '拉取模型列表失败';
      }
    } else {
      modelsCache = mergeAgentModels(AGENT_CURATED_MODELS, []);
      ensureModelForProvider({ preferRemembered: true });
    }
  } else if (prevProvider !== provider) {
    ensureModelForProvider({ preferRemembered: true });
  }
  return getAgentStatus();
}

async function disposeAgent(): Promise<void> {
  const agent = activeAgent;
  activeAgent = null;
  activeRunCancel = null;
  if (openaiAbort) {
    try {
      openaiAbort.abort();
    } catch {
      // ignore
    }
    openaiAbort = null;
  }
  if (!agent) return;
  try {
    if (typeof agent[Symbol.asyncDispose] === 'function') {
      await agent[Symbol.asyncDispose]!();
    } else if (typeof agent.close === 'function') {
      await agent.close();
    }
  } catch {
    // ignore dispose errors
  }
}

export async function clearAgentSession(): Promise<AgentBridgeStatus> {
  runToken += 1;
  await disposeAgent();
  sessionId = null;
  phase = 'idle';
  lastError = null;
  const chatId = getActiveChatSessionId();
  if (chatId) {
    clearChatSessionMessages(chatId);
  }
  emit({
    type: 'status',
    phase,
    message: '会话消息已清空',
    sessionId: null,
    workflowId,
    chatSessionId: chatId,
  });
  emit({ type: 'sessions_changed', activeId: chatId });
  return getAgentStatus();
}

export function listAgentSessions(): AgentChatSessionSummary[] {
  return listChatSessions();
}

export function getAgentSession(id: string): AgentChatSession | null {
  return readSession(id);
}

export async function createAgentSession(
  request: AgentCreateSessionRequest = {},
): Promise<AgentChatSession> {
  runToken += 1;
  await disposeAgent();
  sessionId = null;
  phase = 'idle';
  lastError = null;
  if (request.workflowId) {
    workflowId = request.workflowId;
  }
  const session = createChatSession({
    title: request.title,
    workflowId: request.workflowId ?? workflowId,
    workflowName: request.workflowName,
  });
  emit({ type: 'sessions_changed', activeId: session.id });
  emit({
    type: 'status',
    phase,
    message: '已新建会话',
    sessionId: null,
    workflowId,
    chatSessionId: session.id,
  });
  return session;
}

export function updateAgentSession(request: AgentUpdateSessionRequest): AgentChatSession {
  const session = updateChatSession(request);
  emit({ type: 'sessions_changed', activeId: getActiveChatSessionId() });
  return session;
}

export async function deleteAgentSession(id: string): Promise<{ activeId: string | null }> {
  const active = getActiveChatSessionId();
  if (active === id) {
    runToken += 1;
    await disposeAgent();
    sessionId = null;
    phase = 'idle';
    lastError = null;
  }
  const result = deleteChatSession(id);
  setActiveChatSessionId(result.activeId);
  emit({ type: 'sessions_changed', activeId: result.activeId });
  emit({
    type: 'status',
    phase,
    message: '会话已删除',
    sessionId: null,
    workflowId,
    chatSessionId: result.activeId,
  });
  return result;
}

export function deleteAgentMessages(request: AgentDeleteMessagesRequest): AgentChatSession {
  const sessionIdValue = (request.sessionId || '').trim() || getActiveChatSessionId();
  if (!sessionIdValue) {
    throw new Error('没有可操作的会话。');
  }
  const ids = Array.isArray(request.messageIds) ? request.messageIds : [];
  flushChatMessagePersist();
  const session = deleteChatMessages(sessionIdValue, ids);
  emit({ type: 'sessions_changed', activeId: getActiveChatSessionId() });
  return session;
}

export async function switchAgentSession(id: string): Promise<AgentChatSession> {
  const session = readSession(id);
  if (!session) {
    throw new Error('会话不存在。');
  }
  runToken += 1;
  await disposeAgent();
  sessionId = null;
  phase = 'idle';
  lastError = null;
  workflowId = session.workflowId || workflowId;
  setActiveChatSessionId(session.id);
  emit({ type: 'sessions_changed', activeId: session.id });
  emit({
    type: 'status',
    phase,
    message: '已切换会话',
    sessionId: null,
    workflowId,
    chatSessionId: session.id,
  });
  return session;
}

export async function cancelAgentRun(): Promise<void> {
  runToken += 1;
  const cancel = activeRunCancel;
  activeRunCancel = null;
  if (cancel) {
    try {
      await cancel();
    } catch {
      // ignore
    }
  }
  phase = 'cancelled';
  emit({ type: 'done', phase, message: '已取消' });
}

function buildMcpServers(): Record<string, { type: 'http'; url: string }> | undefined {
  const url = getMcpServerUrl();
  if (!url) return undefined;
  return {
    mediado: {
      type: 'http',
      url,
    },
  };
}

async function ensureAgent(selection: ModelSelection): Promise<SdkAgent> {
  const key = resolveApiKey();
  if (!key) {
    throw new Error('请先配置 Cursor API Key（设置页或环境变量 CURSOR_API_KEY）。');
  }
  if (provider !== 'cursor') {
    throw new Error('当前为 OpenAI 兼容通道，请切换 Provider 或使用兼容运行时。');
  }
  const nextKey = agentModelKey(selection);
  if (activeAgent && activeModelKey === nextKey) {
    return activeAgent;
  }
  await disposeAgent();
  applyModelSelection(selection);
  saveConfig();

  const { Agent } = await loadSdk();
  const mcpServers = buildMcpServers();
  const modelOption: ModelSelection = selection.params?.length
    ? { id: selection.id, params: selection.params }
    : { id: selection.id };
  const created = await Agent.create({
    apiKey: key,
    model: modelOption,
    local: {
      cwd: agentWorkspaceDir(),
      // Electron 下 sandbox helper 路径不可靠，关闭以保证可跑。
      sandboxOptions: { enabled: false },
    },
    ...(mcpServers ? { mcpServers } : {}),
  }) as SdkAgent;

  activeAgent = created;
  sessionId = created.agentId || randomUUID();
  return created;
}

function textFromAssistantEvent(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const typed = event as {
    type?: string;
    message?: { content?: Array<{ type?: string; text?: string; thinking?: string }> };
    text?: string;
  };
  // Skip thinking / reasoning stream events — UI shows them folded, not as body text.
  if (
    typed.type === 'thinking'
    || typed.type === 'reasoning'
    || typed.type === 'thought'
    || typed.type === 'thinking_delta'
  ) {
    return '';
  }
  if (typed.type === 'assistant' && typed.message?.content) {
    return typed.message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text || '')
      .join('');
  }
  if (typeof typed.text === 'string' && typed.type !== 'tool_call' && typed.type !== 'tool-call') {
    return typed.text;
  }
  return '';
}

function summarizeUnknown(value: unknown, max = 180): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  }
  try {
    const raw = JSON.stringify(value);
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  } catch {
    return undefined;
  }
}

/** Keep enough payload for local-artifact path extraction (spaces / nested JSON). */
const TOOL_RESULT_DETAIL_MAX = 12_000;

function toolLabelFromEvent(event: unknown): { name: string; detail?: string } | null {
  if (!event || typeof event !== 'object') return null;
  const typed = event as {
    type?: string;
    name?: string;
    tool?: string;
    toolCallId?: string;
    tool_call?: { name?: string; arguments?: unknown; input?: unknown };
    toolCall?: { name?: string; arguments?: unknown; input?: unknown; tool?: string };
    function?: { name?: string; arguments?: unknown };
    message?: { name?: string; content?: unknown; toolName?: string };
    args?: unknown;
    input?: unknown;
    arguments?: unknown;
    result?: unknown;
    output?: unknown;
    content?: unknown;
    data?: unknown;
  };
  const type = (typed.type || '').toLowerCase();
  const isResult = (
    type === 'tool_result'
    || type === 'tool-result'
    || type === 'tool_call_result'
    || type === 'tool-call-result'
    || type === 'function_call_result'
    || type === 'mcp_tool_result'
  );
  const isCall = (
    type === 'tool_call'
    || type === 'tool-call'
    || type === 'tool'
    || type === 'tool_call_started'
    || type === 'tool-call-started'
    || type === 'tool_use'
    || type === 'function_call'
    || type === 'function-call'
    || Boolean(typed.toolCall || typed.tool_call)
  );
  if (!isResult && !isCall) return null;

  const name = (
    typed.name
    || typed.tool
    || typed.toolCall?.name
    || typed.toolCall?.tool
    || typed.tool_call?.name
    || typed.function?.name
    || typed.message?.name
    || typed.message?.toolName
    || 'tool'
  );

  if (isResult) {
    const detail = summarizeUnknown(
      typed.result
      ?? typed.output
      ?? typed.content
      ?? typed.data
      ?? typed.message?.content
      ?? typed.args
      ?? typed.input,
      TOOL_RESULT_DETAIL_MAX,
    );
    return { name: `${name}:result`, detail };
  }

  const detail = summarizeUnknown(
    typed.args
    ?? typed.input
    ?? typed.arguments
    ?? typed.toolCall?.arguments
    ?? typed.toolCall?.input
    ?? typed.tool_call?.arguments
    ?? typed.tool_call?.input
    ?? typed.function?.arguments
    ?? typed.message?.content,
    400,
  );
  return { name, detail };
}

function thinkingFromEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const typed = event as {
    type?: string;
    text?: string;
    delta?: string;
    thinking?: string;
    message?: { content?: Array<{ type?: string; thinking?: string; text?: string }> };
  };
  const type = (typed.type || '').toLowerCase();
  if (type === 'thinking' || type === 'reasoning' || type === 'thought' || type === 'thinking_delta') {
    return typed.delta || typed.text || typed.thinking || null;
  }
  if (typed.type === 'assistant' && typed.message?.content) {
    const bits = typed.message.content
      .filter((block) => block.type === 'thinking' || block.type === 'reasoning')
      .map((block) => block.thinking || block.text || '')
      .filter(Boolean);
    return bits.length ? bits.join('') : null;
  }
  return null;
}

async function runPrompt(options: {
  prompt: string;
  model?: ModelSelection;
  userVisible?: string;
  chatSessionId?: string;
}): Promise<void> {
  const token = ++runToken;
  const selectedModel = options.model || currentModelSelection();
  const userText = options.userVisible || options.prompt;
  const userMessageId = randomUUID();
  const chatId = options.chatSessionId
    || ensureActiveChatSession({ workflowId }).id;
  setActiveChatSessionId(chatId);

  phase = 'running';
  lastError = null;
  const userMessage: AgentChatMessage = {
    id: userMessageId,
    role: 'user',
    content: userText,
    createdAt: new Date().toISOString(),
  };
  persistMessage(userMessage, 'append');
  emit({ type: 'user', messageId: userMessageId, content: userText, chatSessionId: chatId });
  emit({
    type: 'status',
    phase,
    message: 'Agent 运行中…',
    sessionId,
    workflowId,
    chatSessionId: chatId,
  });
  emit({ type: 'sessions_changed', activeId: chatId });

  try {
    if (provider === 'openai-compatible') {
      await runOpenAIPrompt({
        token,
        chatId,
        prompt: options.prompt,
        modelId: selectedModel.id,
      });
      return;
    }

    const agent = await ensureAgent(selectedModel);
    const run = await agent.send(options.prompt, {
      model: selectedModel.params?.length
        ? { id: selectedModel.id, params: selectedModel.params }
        : { id: selectedModel.id },
    });
    if (token !== runToken) return;

    if (run.supports?.('cancel') && typeof run.cancel === 'function') {
      activeRunCancel = () => run.cancel!();
    } else {
      activeRunCancel = null;
    }

    const assistantMessageId = randomUUID();
    let assembled = '';
    let thinkingAssembled = '';
    const assistantCreatedAt = new Date().toISOString();
    let thinkingMessageId: string | null = null;

    for await (const event of run.stream()) {
      if (token !== runToken) return;
      const thinkingChunk = thinkingFromEvent(event);
      if (thinkingChunk) {
        if (!thinkingMessageId) {
          thinkingMessageId = randomUUID();
        }
        thinkingAssembled += thinkingChunk;
        const thinkingMessage: AgentChatMessage = {
          id: thinkingMessageId,
          role: 'tool',
          content: thinkingAssembled,
          meta: 'thinking',
          createdAt: assistantCreatedAt,
        };
        persistMessage(thinkingMessage, 'stream');
        emit({
          type: 'tool',
          messageId: thinkingMessage.id,
          name: 'thinking',
          detail: thinkingAssembled,
          chatSessionId: chatId,
        });
      }
      const tool = toolLabelFromEvent(event);
      if (tool) {
        const toolMessage: AgentChatMessage = {
          id: randomUUID(),
          role: 'tool',
          content: tool.detail || '调用工具',
          meta: tool.name,
          createdAt: new Date().toISOString(),
        };
        persistMessage(toolMessage, 'append');
        emit({
          type: 'tool',
          messageId: toolMessage.id,
          name: tool.name,
          detail: tool.detail,
          chatSessionId: chatId,
        });
      }
      const chunk = textFromAssistantEvent(event);
      if (!chunk) continue;
      // Some streams re-emit full text; prefer delta when growing.
      let delta = chunk;
      if (chunk.startsWith(assembled)) {
        delta = chunk.slice(assembled.length);
        assembled = chunk;
      } else {
        assembled += chunk;
      }
      if (!delta) continue;
      persistMessage({
        id: assistantMessageId,
        role: 'assistant',
        content: assembled,
        createdAt: assistantCreatedAt,
      }, 'stream');
      emit({
        type: 'assistant_delta',
        messageId: assistantMessageId,
        delta,
        chatSessionId: chatId,
      });
    }

    const result = await run.wait();
    if (token !== runToken) return;

    if (!assembled && typeof result.result === 'string') {
      assembled = result.result;
      emit({
        type: 'assistant_delta',
        messageId: assistantMessageId,
        delta: assembled,
        chatSessionId: chatId,
      });
    }

    flushChatMessagePersist();
    persistMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: assembled,
      createdAt: assistantCreatedAt,
    }, 'upsert');
    emit({
      type: 'assistant_done',
      messageId: assistantMessageId,
      content: assembled,
      chatSessionId: chatId,
    });
    emit({ type: 'sessions_changed', activeId: chatId });

    if (result.status === 'error') {
      phase = 'failed';
      lastError = 'Agent 运行失败';
      emit({ type: 'error', message: lastError });
      emit({ type: 'done', phase, message: lastError, chatSessionId: chatId });
      return;
    }

    phase = 'passed';
    emit({ type: 'done', phase, message: '分析完成', chatSessionId: chatId });
  } catch (error) {
    if (token !== runToken) return;
    phase = 'failed';
    lastError = error instanceof Error ? error.message : 'Agent 启动失败';
    emit({ type: 'error', message: lastError });
    emit({ type: 'done', phase, message: lastError, chatSessionId: chatId });
  } finally {
    if (token === runToken) {
      activeRunCancel = null;
      openaiAbort = null;
    }
  }
}

async function runOpenAIPrompt(input: {
  token: number;
  chatId: string;
  prompt: string;
  modelId: string;
}): Promise<void> {
  const key = resolveApiKey();
  if (!key) {
    throw new Error('请先配置 OpenAI 兼容 API Key（设置页或环境变量 OPENAI_API_KEY）。');
  }
  applyModelSelection({ id: input.modelId });
  saveConfig();
  if (!sessionId) {
    sessionId = randomUUID();
  }

  const controller = new AbortController();
  openaiAbort = controller;
  activeRunCancel = async () => {
    controller.abort();
  };

  const assistantMessageId = randomUUID();
  const assistantCreatedAt = new Date().toISOString();
  let assembled = '';

  const finalText = await runOpenAICompatibleAgent({
    baseUrl: resolveBaseUrl(),
    apiKey: key,
    model: input.modelId,
    prompt: input.prompt,
    signal: controller.signal,
    onDelta: (delta) => {
      if (input.token !== runToken) return;
      assembled += delta;
      persistMessage({
        id: assistantMessageId,
        role: 'assistant',
        content: assembled,
        createdAt: assistantCreatedAt,
      }, 'stream');
      emit({
        type: 'assistant_delta',
        messageId: assistantMessageId,
        delta,
        chatSessionId: input.chatId,
      });
    },
    onTool: (name, detail) => {
      if (input.token !== runToken) return;
      const toolMessage: AgentChatMessage = {
        id: randomUUID(),
        role: 'tool',
        content: detail || '调用工具',
        meta: name,
        createdAt: new Date().toISOString(),
      };
      persistMessage(toolMessage, 'append');
      emit({
        type: 'tool',
        messageId: toolMessage.id,
        name,
        detail,
        chatSessionId: input.chatId,
      });
    },
  });

  if (input.token !== runToken) return;

  if (!assembled && finalText) {
    assembled = finalText;
    emit({
      type: 'assistant_delta',
      messageId: assistantMessageId,
      delta: assembled,
      chatSessionId: input.chatId,
    });
  }

  flushChatMessagePersist();
  persistMessage({
    id: assistantMessageId,
    role: 'assistant',
    content: assembled,
    createdAt: assistantCreatedAt,
  }, 'upsert');
  emit({
    type: 'assistant_done',
    messageId: assistantMessageId,
    content: assembled,
    chatSessionId: input.chatId,
  });
  emit({ type: 'sessions_changed', activeId: input.chatId });
  phase = 'passed';
  emit({ type: 'done', phase, message: '分析完成', chatSessionId: input.chatId });
}

function analyzeModeLabel(mode: AgentAnalyzeMode): string {
  if (mode === 'test-enhance') return '智能测试增强';
  if (mode === 'business-doc') return '业务理解与文档';
  if (mode === 'anomaly') return '基线异常 / 回归分析';
  if (mode === 'auto-run') return '录制自动执行';
  if (mode === 'param-run') return '参数化执行';
  return '综合分析';
}

function formatStepsForPrompt(steps: PlaywrightScriptStep[]): string {
  if (!steps.length) return '（未解析到可替换的 goto/fill/type/select 步骤）';
  return steps.map((step) => (
    `- [${step.id}] #${step.index} ${step.kind} · ${step.hint || step.target} · 当前值=${JSON.stringify(step.value)}`
  )).join('\n');
}

/**
 * Automation run browser visibility:
 * - explicit headed flag from UI wins
 * - else Prompt hints（有头/无头）
 * - default headless（不打开可见回放窗口）
 */
function resolveAutoRunPlayMode(note?: string, headed?: boolean): PlaywrightRunMode {
  if (headed === true) return 'headed';
  if (headed === false) return 'headless';
  const text = (note || '').toLowerCase();
  if (/debug/.test(text)) return 'debug';
  if (/有头|headed|可见浏览器|打开浏览器窗口/.test(text)) return 'headed';
  if (/无头|headless/.test(text)) return 'headless';
  return 'headless';
}

/** Parse `key: value` / `key：value` / `key=value` pairs from user Prompt. */
function parseParamsFromNote(note?: string): Record<string, string> {
  const text = (note || '').trim();
  if (!text) return {};
  const params: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.replace(/^[-*•]\s*/, '');
    const match = cleaned.match(/^([^：:=]{1,40})\s*[：:=]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().replace(/^["'`【\[]+|["'`】\]]+$/g, '');
    const value = match[2].trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!key || !value) continue;
    if (/^(url|链接|地址|页面|邮箱|email|mail|密码|password|pwd|用户名|账号|user|username|account|手机|电话|phone|mobile|tel|标题|title|主题)$/i.test(key)
      || key.length <= 24) {
      params[key] = value;
    }
  }
  return params;
}

function buildAnalyzePrompt(input: {
  name: string;
  url: string;
  browser: string;
  scriptExcerpt: string;
  pdfPath?: string;
  artifactSummary: string;
  note?: string;
  mode?: AgentAnalyzeMode;
  baselineSummary?: string;
  workflowId: string;
  scriptSteps?: PlaywrightScriptStep[];
  headed?: boolean;
}): string {
  const mode: AgentAnalyzeMode = input.mode || 'general';
  const scriptLimit = mode === 'test-enhance' ? 8000 : 4000;
  const lines = [
    '你是 MediaDo Playwright Studio 的页面分析助手。',
    `当前分析模式：${analyzeModeLabel(mode)}（${mode}）`,
    '用户通过 Playwright 录制/打开页面，并可能导出了 PDF / Trace / HAR / 基线产物，请基于上下文分析。',
    '',
    `工作流 ID：${input.workflowId}`,
    `工作流名称：${input.name}`,
    `起始 URL：${input.url}`,
    `浏览器：${input.browser}`,
    input.pdfPath
      ? `PDF 绝对路径：${input.pdfPath}`
      : '本次未提供 PDF：请主要依据脚本、起始 URL 与已有产物（截图/Trace/视频/HAR）分析。',
    `产物摘要：${input.artifactSummary || '无'}`,
    '',
    '脚本节选：',
    '```ts',
    input.scriptExcerpt.slice(0, scriptLimit),
    '```',
  ];

  if (input.baselineSummary?.trim()) {
    lines.push('', '## 基线对比摘要', input.baselineSummary.trim());
  }

  if (mode === 'test-enhance') {
    lines.push(
      '',
      '## 任务：智能测试增强',
      '请完成：',
      '1. 识别脆弱选择器（动态 id/超长 xpath/nth 依赖），推荐更稳策略（role/text/testid/placeholder）。',
      '2. 给出可落地的断言补全（URL / title / 关键文案 / 网络结果）。',
      '3. 若值得改脚本：调用 playwright_update 写回优化后的完整 script；或先用 playwright_inject_asserts。',
      '4. 拆分可独立的测试场景（登录/主流程/边界），用 markdown 说明。',
      '5. 最后调用 playwright_save_report（kind=test-enhance）保存结构化报告。',
    );
  } else if (mode === 'business-doc') {
    lines.push(
      '',
      '## 任务：业务理解与文档化',
      '请输出并落盘：',
      '1. 业务流程说明（步骤、角色、前置条件）。',
      '2. 用户故事 / 验收标准。',
      '3. 关键页面与数据流转说明。',
      '4. 风险点与待补充录制建议。',
      '5. 调用 playwright_save_report（kind=business-doc）保存完整 Markdown 文档。',
    );
  } else if (mode === 'anomaly') {
    lines.push(
      '',
      '## 任务：基线异常 / 回归分析',
      '请基于基线摘要与最近回放产物：',
      '1. 判断是否存在回归（失败步骤、脚本漂移、产物差异）。',
      '2. 结合 Trace / HAR / 日志路径定位根因。',
      '3. 给出修复建议（选择器、等待、断言、环境差异）。',
      '4. 必要时调用 playwright_compare_baseline、playwright_list_artifacts、playwright_get。',
      '5. 调用 playwright_save_report（kind=anomaly）保存异常分析报告。',
    );
  } else if (mode === 'auto-run' || mode === 'param-run') {
    const preferredMode = resolveAutoRunPlayMode(input.note, input.headed);
    const headedChosen = preferredMode === 'headed' || preferredMode === 'debug' || preferredMode === 'ui';
    const parsedHint = parseParamsFromNote(input.note);
    lines.push(
      '',
      mode === 'auto-run'
        ? '## 任务：录制步骤自动执行（经 Agent 调起）'
        : '## 任务：参数化执行录制步骤（经 Agent 调起）',
      '用户会在 Prompt 里给出本次参数；你必须先解析 Prompt，再调用工具执行自动化，不要只口头描述。',
      '默认用无头窗口（headless）执行录制回放步骤；只有用户勾选「有头窗口」或明确要求时才用 headed。',
      `本次浏览器模式要求：mode=${preferredMode}${headedChosen ? '（有头，打开可见窗口）' : '（无头，不打开可见窗口）'}。`,
      '',
      '## 可参数化步骤清单',
      formatStepsForPrompt(input.scriptSteps || []),
    );
    if (Object.keys(parsedHint).length) {
      lines.push(
        '',
        '## Prompt 初解析（供参考，可修正）',
        JSON.stringify(parsedHint, null, 2),
      );
    }
    lines.push(
      '',
      '请严格按以下步骤：',
      '1. 阅读用户 Prompt，提取本次要填入的信息（URL、账号、密码、表单字段等）。',
      '2. 把信息映射到上面的 step.id / index / hint（也可用 邮箱/密码/标题/url 等别名）；无参数时可传空对象 {}。',
      `3. 必须调用 playwright_run_with_params（workflowId=${input.workflowId} + params + mode=${preferredMode}）。`,
      '4. 若映射不确定：先 playwright_list_steps 复核，再执行；不要要求用户去点「回放」。',
      '5. 执行后汇报：替换了哪些字段、执行结果、失败原因；失败可修正 params 再跑最多 1 次。',
      'persistScript 默认 false（只影响本次执行，不改坏录制模板）。',
      '不要默认导出 PDF。',
    );
  } else {
    lines.push(
      '',
      '请输出：',
      '1. 页面/流程概要（无 PDF 时根据脚本与 URL 推断）',
      '2. 关键交互与可自动化断言建议（URL / Title / 关键元素）',
      '3. 风险点或失败高发步骤',
      '4. 后续可继续录制的操作建议',
      '',
      '若结论较完整，可调用 playwright_save_report（kind=general）保存报告。',
    );
  }

  lines.push(
    '',
    '可用 MCP 工具（mediado）：playwright_get、playwright_list_steps、playwright_run_with_params、playwright_update、playwright_inject_asserts、playwright_list_artifacts、playwright_compare_baseline、playwright_save_report、playwright_capture、playwright_play 等。',
    '优先基于已给脚本与路径分析；确有必要时再调用工具。不要默认再去导出 PDF，除非用户明确要求。',
    '改脚本前先说明意图；写回后摘要变更点。',
  );

  if (input.note?.trim()) {
    lines.push('', '## 用户请求（会话 Prompt）', input.note.trim());
  }
  return lines.join('\n');
}

export async function analyzeWorkflow(
  request: AgentAnalyzeWorkflowRequest,
): Promise<{ sessionId: string; chatSessionId: string }> {
  if (!request.workflowId?.trim()) {
    throw new Error('工作流 ID 无效。');
  }
  const detail = getWorkflow(request.workflowId);
  workflowId = detail.id;
  const chatSession = request.chatSessionId
    ? (readSession(request.chatSessionId) || ensureActiveChatSession({
      workflowId: detail.id,
      workflowName: detail.name,
    }))
    : ensureActiveChatSession({
      workflowId: detail.id,
      workflowName: detail.name,
    });
  if (chatSession.workflowId !== detail.id || chatSession.workflowName !== detail.name) {
    updateChatSession({
      id: chatSession.id,
      workflowId: detail.id,
      workflowName: detail.name,
    });
  }
  setActiveChatSessionId(chatSession.id);
  if (request.modelKey || request.modelId) {
    applyModelSelection(resolveModelSelection(request));
    saveConfig();
  }

  const analyzeMode: AgentAnalyzeMode = request.mode || 'general';
  // Most focused modes prefer existing artifacts; PDF only when explicitly requested via capturePdf.
  const shouldCapture = request.capturePdf === true
    || (request.capturePdf !== false && analyzeMode === 'general');
  let pdfPath: string | undefined;
  phase = 'running';
  const preferredPlayMode = resolveAutoRunPlayMode(request.note, request.headed);
  emit({
    type: 'status',
    phase,
    message: (analyzeMode === 'auto-run' || analyzeMode === 'param-run')
      ? `正在把 Prompt 交给 Agent，由其调起自动化（${preferredPlayMode === 'headless' ? '无头' : '有头'}）…`
      : (shouldCapture ? '正在导出 PDF…' : `准备${analyzeModeLabel(analyzeMode)}…`),
    workflowId,
    sessionId,
    chatSessionId: chatSession.id,
  });

  let scriptSteps: PlaywrightScriptStep[] | undefined;

  if (analyzeMode === 'param-run' || analyzeMode === 'auto-run') {
    try {
      scriptSteps = listScriptSteps(detail.id);
    } catch {
      scriptSteps = [];
    }
  }

  if (shouldCapture) {
    try {
      const captured = await capturePage({ id: detail.id, kind: 'pdf', fullPage: true });
      pdfPath = captured.artifacts.find((item) => item.kind === 'pdf')?.path
        || captured.artifacts[0]?.path;
    } catch (error) {
      // PDF 失败时仍尝试用已有产物分析。
      const message = error instanceof Error ? error.message : '导出 PDF 失败';
      emit({ type: 'status', phase: 'running', message: `${message}，将尝试使用已有产物继续分析`, workflowId });
    }
  }

  if (!pdfPath) {
    const existing = listArtifacts(detail.id).find((item) => item.kind === 'pdf');
    pdfPath = existing?.path;
  }

  const artifacts = listArtifacts(detail.id).slice(0, 12);
  const artifactSummary = artifacts
    .map((item) => `${item.kind}:${item.name}`)
    .join(' · ');

  let baselineSummary = '';
  try {
    baselineSummary = compareBaseline(detail.id).summary;
  } catch {
    baselineSummary = '';
  }

  const prompt = buildAnalyzePrompt({
    name: detail.name,
    url: detail.url,
    browser: detail.browser,
    scriptExcerpt: detail.script || '',
    pdfPath,
    artifactSummary,
    note: request.note,
    mode: analyzeMode,
    baselineSummary,
    workflowId: detail.id,
    scriptSteps,
    headed: request.headed,
  });

  const userPrompt = request.note?.trim() || '';
  const headedHint = preferredPlayMode === 'headless' ? '无头执行' : '有头窗口';
  const modeLine = (analyzeMode === 'auto-run' || analyzeMode === 'param-run')
    ? [
      `分析模式：${analyzeModeLabel(analyzeMode)}`,
      `可替换步骤 ${scriptSteps?.length || 0} 个`,
      headedHint,
      'Prompt → Agent → playwright_run_with_params',
    ].join(' · ')
    : [
      `分析模式：${analyzeModeLabel(analyzeMode)}`,
      shouldCapture
        ? (pdfPath ? `PDF：${path.basename(pdfPath)}` : '本次未能导出 PDF，将结合脚本与已有产物分析')
        : '未导出 PDF（脚本 / 产物 / 基线分析）',
    ].join(' · ');
  const visible = userPrompt
    ? [
      userPrompt,
      '',
      `——`,
      `工作流：${detail.name}`,
      modeLine,
    ].join('\n')
    : [
      (analyzeMode === 'auto-run' || analyzeMode === 'param-run')
        ? `请根据 Prompt 参数调起工作流「${detail.name}」的录制步骤自动执行（${headedHint}）`
        : `请对工作流「${detail.name}」做${analyzeModeLabel(analyzeMode)}`,
      modeLine,
    ].join('\n');

  if (userPrompt) {
    const title = userPrompt.replace(/\s+/g, ' ').slice(0, 36);
    if (title) {
      try {
        updateChatSession({ id: chatSession.id, title });
      } catch {
        // ignore title update failures
      }
    }
  }

  // Fire-and-forget streaming; UI listens on agent:event.
  void runPrompt({
    prompt,
    model: currentModelSelection(),
    userVisible: visible,
    chatSessionId: chatSession.id,
  });

  // ensureAgent may still be creating; expose provisional session id.
  if (!sessionId) {
    sessionId = `pending-${createHash('sha1').update(detail.id).digest('hex').slice(0, 10)}`;
  }
  return { sessionId, chatSessionId: chatSession.id };
}

export async function sendAgentMessage(
  request: AgentSendRequest,
): Promise<{ sessionId: string; chatSessionId: string }> {
  const message = (request.message || '').trim();
  if (!message) {
    throw new Error('消息不能为空。');
  }
  if (request.workflowId) {
    workflowId = request.workflowId;
  }
  const chatSession = request.chatSessionId
    ? (readSession(request.chatSessionId) || ensureActiveChatSession({ workflowId }))
    : ensureActiveChatSession({ workflowId });
  setActiveChatSessionId(chatSession.id);
  if (request.modelKey || request.modelId) {
    applyModelSelection(resolveModelSelection(request));
    saveConfig();
  }
  void runPrompt({
    prompt: message,
    model: currentModelSelection(),
    userVisible: message,
    chatSessionId: chatSession.id,
  });
  if (!sessionId) {
    sessionId = randomUUID();
  }
  return { sessionId, chatSessionId: chatSession.id };
}

export async function openLocalPath(targetPath: string): Promise<void> {
  const file = path.resolve((targetPath || '').trim());
  if (!file || !existsSync(file)) {
    throw new Error('本地路径不存在。');
  }
  const result = await shell.openPath(file);
  if (result) {
    throw new Error(result);
  }
}

export async function revealLocalPath(targetPath: string): Promise<void> {
  const file = path.resolve((targetPath || '').trim());
  if (!file || !existsSync(file)) {
    throw new Error('本地路径不存在。');
  }
  if (lstatSync(file).isDirectory()) {
    const result = await shell.openPath(file);
    if (result) throw new Error(result);
    return;
  }
  shell.showItemInFolder(file);
}

export function initAgentBridge(): void {
  loadConfig();
  modelsCache = mergeAgentModels(AGENT_CURATED_MODELS, []);
  ensureActiveChatSession({ workflowId });
  void listAgentModels().catch(() => undefined);
}

export async function shutdownAgentBridge(): Promise<void> {
  runToken += 1;
  await disposeAgent();
}
