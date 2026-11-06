export interface AgentModelParam {
  id: string;
  value: string;
}

export interface AgentModelInfo {
  id: string;
  displayName: string;
  description?: string;
  /** Provider group for optgroup UI. */
  group?: string;
  /** Optional Cursor model params (thinking / fast / effort / …). */
  params?: AgentModelParam[];
  /** Stable select value (id + params). */
  key?: string;
}

/** Inference backend: Cursor SDK hosted models, or any OpenAI-compatible API. */
export type AgentProviderKind = 'cursor' | 'openai-compatible';

export interface AgentCustomModel {
  id: string;
  displayName?: string;
}

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const AGENT_PROVIDER_OPTIONS: Array<{
  id: AgentProviderKind;
  label: string;
  hint: string;
}> = [
  { id: 'cursor', label: 'Cursor', hint: 'Cursor 账户 API Key，使用 Cursor 托管模型' },
  { id: 'openai-compatible', label: 'OpenAI 兼容', hint: '自备 Key + Base URL（OpenAI / DeepSeek / 通义 / OpenRouter / 本地网关）' },
];

export type AgentMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type AgentSessionPhase = 'idle' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface AgentChatMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  /** Optional tool / status meta shown in UI. */
  meta?: string;
}

export interface AgentChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workflowId?: string | null;
  workflowName?: string | null;
  messageCount: number;
  preview?: string;
}

export interface AgentChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workflowId?: string | null;
  workflowName?: string | null;
  messages: AgentChatMessage[];
}

export interface AgentCreateSessionRequest {
  title?: string;
  workflowId?: string | null;
  workflowName?: string | null;
}

export interface AgentUpdateSessionRequest {
  id: string;
  title?: string;
  workflowId?: string | null;
  workflowName?: string | null;
}

export interface AgentDeleteMessagesRequest {
  sessionId: string;
  messageIds: string[];
}

export interface AgentBridgeStatus {
  ready: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
  provider: AgentProviderKind;
  /** OpenAI-compatible endpoint root, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  customModels: AgentCustomModel[];
  modelId: string;
  modelKey: string;
  modelParams?: AgentModelParam[];
  models: AgentModelInfo[];
  mcpUrl: string | null;
  sessionId: string | null;
  chatSessionId: string | null;
  phase: AgentSessionPhase;
  workflowId: string | null;
  lastError: string | null;
}

/** Focus for workflow analysis prompts. */
export type AgentAnalyzeMode =
  | 'general'
  | 'test-enhance'
  | 'business-doc'
  | 'anomaly';

export interface AgentAnalyzeWorkflowRequest {
  workflowId: string;
  /** Capture a fresh PDF before analysis. Default true. */
  capturePdf?: boolean;
  /**
   * Analysis focus:
   * - general: flow summary + risks
   * - test-enhance: selectors / asserts / writable script improvements
   * - business-doc: process docs / user stories
   * - anomaly: baseline vs latest run regression summary
   */
  mode?: AgentAnalyzeMode;
  /** Extra user instruction appended to the analysis prompt. */
  note?: string;
  modelId?: string;
  modelKey?: string;
  modelParams?: AgentModelParam[];
  chatSessionId?: string;
}

export interface AgentSendRequest {
  message: string;
  modelId?: string;
  modelKey?: string;
  modelParams?: AgentModelParam[];
  workflowId?: string;
  chatSessionId?: string;
}

export interface AgentSetConfigRequest {
  apiKey?: string;
  modelId?: string;
  modelKey?: string;
  modelParams?: AgentModelParam[];
  clearApiKey?: boolean;
  provider?: AgentProviderKind;
  baseUrl?: string;
  /** Replace the full custom model list (openai-compatible). */
  customModels?: AgentCustomModel[];
  addCustomModel?: AgentCustomModel;
  removeCustomModelId?: string;
}

export type AgentStreamEvent =
  | {
      type: 'status';
      phase: AgentSessionPhase;
      message: string;
      workflowId?: string | null;
      sessionId?: string | null;
      chatSessionId?: string | null;
    }
  | {
      type: 'assistant_delta';
      messageId: string;
      delta: string;
      chatSessionId?: string | null;
    }
  | {
      type: 'assistant_done';
      messageId: string;
      content: string;
      chatSessionId?: string | null;
    }
  | {
      type: 'user';
      messageId: string;
      content: string;
      chatSessionId?: string | null;
    }
  | {
      type: 'tool';
      messageId: string;
      name: string;
      detail?: string;
      chatSessionId?: string | null;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'done';
      phase: AgentSessionPhase;
      message: string;
      chatSessionId?: string | null;
    }
  | {
      type: 'sessions_changed';
      activeId: string | null;
    };

export interface AgentApi {
  getStatus(): Promise<AgentBridgeStatus>;
  listModels(): Promise<AgentModelInfo[]>;
  setConfig(request: AgentSetConfigRequest): Promise<AgentBridgeStatus>;
  analyzeWorkflow(request: AgentAnalyzeWorkflowRequest): Promise<{ sessionId: string; chatSessionId: string }>;
  send(request: AgentSendRequest): Promise<{ sessionId: string; chatSessionId: string }>;
  cancel(): Promise<void>;
  clearSession(): Promise<AgentBridgeStatus>;
  listSessions(): Promise<AgentChatSessionSummary[]>;
  getSession(id: string): Promise<AgentChatSession | null>;
  createSession(request?: AgentCreateSessionRequest): Promise<AgentChatSession>;
  updateSession(request: AgentUpdateSessionRequest): Promise<AgentChatSession>;
  deleteSession(id: string): Promise<{ activeId: string | null }>;
  switchSession(id: string): Promise<AgentChatSession>;
  /** Delete one or more messages from a chat session. */
  deleteMessages(request: AgentDeleteMessagesRequest): Promise<AgentChatSession>;
  /** Open a local file with the default app, or open a directory. */
  openLocalPath(targetPath: string): Promise<void>;
  /** Reveal a local file/directory in the system file manager. */
  revealLocalPath(targetPath: string): Promise<void>;
  onEvent(handler: (event: AgentStreamEvent) => void): () => void;
}

export const AgentIpc = {
  status: 'agent:status',
  listModels: 'agent:listModels',
  setConfig: 'agent:setConfig',
  analyzeWorkflow: 'agent:analyzeWorkflow',
  send: 'agent:send',
  cancel: 'agent:cancel',
  clearSession: 'agent:clearSession',
  listSessions: 'agent:listSessions',
  getSession: 'agent:getSession',
  createSession: 'agent:createSession',
  updateSession: 'agent:updateSession',
  deleteSession: 'agent:deleteSession',
  switchSession: 'agent:switchSession',
  deleteMessages: 'agent:deleteMessages',
  openLocalPath: 'agent:openLocalPath',
  revealLocalPath: 'agent:revealLocalPath',
  event: 'agent:event',
} as const;

export { AGENT_CURATED_MODELS as AGENT_FALLBACK_MODELS } from './agent-models';
export {
  AGENT_CURATED_MODELS,
  OPENAI_COMPAT_PRESET_MODELS,
  agentModelKey,
  mergeAgentModels,
  parseAgentModelKey,
  sortAgentModels,
} from './agent-models';
