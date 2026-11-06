import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import type {
  AgentAnalyzeMode,
  AgentBridgeStatus,
  AgentChatMessage,
  AgentChatSessionSummary,
  AgentModelInfo,
  AgentProviderKind,
  AgentStreamEvent,
} from '../../shared/agent';
import {
  AGENT_PROVIDER_OPTIONS,
  DEFAULT_OPENAI_BASE_URL,
  agentModelKey,
} from '../../shared/agent';
import {
  extractLocalArtifacts,
  getLocalArtifactPreviewKind,
  localArtifactPreviewLabel,
  type LocalArtifactRef,
} from '../../shared/local-artifacts';
import {
  PLAYWRIGHT_ANALYZE_MODES,
  type PlaywrightWorkflowMeta,
} from '../../shared/playwright';
import { askConfirm } from '../confirm';
import { AgentMarkdown } from './AgentMarkdown';
import { FloatingNotice } from './FloatingNotice';
import { LocalArtifactPreview } from './LocalArtifactPreview';
import { PwSelect } from './PwSelect';
import { ResizeHandle } from './ResizeHandle';

interface MentionedWorkflow {
  id: string;
  name: string;
  url?: string;
}

/** Detect an in-progress `@query` mention just before the caret. */
function findAtMention(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, cursor));
  const match = before.match(/(^|[\s\n])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] || '';
  const start = before.length - query.length - 1;
  return { start, query };
}

interface AgentChatPanelProps {
  workflowId: string | null;
  workflowName?: string;
  autoStart?: boolean;
  capturePdf?: boolean;
  /** Analysis focus for analyzeWorkflow / toolbar actions. */
  analyzeMode?: AgentAnalyzeMode;
  /** Optional note appended to the first auto-started analysis. */
  analyzeNote?: string;
  /** When auto-starting, create a brand-new chat session instead of reusing the active one. */
  forceNewSession?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** Fired once after auto-start is consumed so the parent can clear autoStart. */
  onAutoStarted?: () => void;
}

function analyzeModeLabel(mode: AgentAnalyzeMode): string {
  if (mode === 'test-enhance') return '智能测试增强';
  if (mode === 'business-doc') return '业务理解与文档';
  if (mode === 'anomaly') return '基线异常分析';
  return '综合分析';
}

function analyzeModeHint(mode: AgentAnalyzeMode): string {
  if (mode === 'test-enhance') return '补断言、稳定选择器与可回归建议';
  if (mode === 'business-doc') return '梳理业务路径并生成说明文档';
  if (mode === 'anomaly') return '对比基线，定位异常与回归风险';
  return '通读脚本、产物与日志给出总览';
}

function modelValue(model: AgentModelInfo): string {
  return model.key || agentModelKey(model);
}

function formatSessionTime(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function readPaneWidth(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw ? Number(raw) : fallback;
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storePaneWidth(key: string, value: number, min: number, max: number): number {
  const next = Math.round(Math.min(max, Math.max(min, value)));
  try {
    window.localStorage.setItem(key, String(next));
  } catch {
    // ignore quota / private mode
  }
  return next;
}

function IconEdit(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13.5 6.5l3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function IconTrash(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function IconJumpDown(): ReactElement {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M6.5 12.5 12 18l5.5-5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ChatRenderBlock =
  | { kind: 'user'; message: AgentChatMessage }
  | { kind: 'assistant'; message: AgentChatMessage; activity: AgentChatMessage[] }
  | { kind: 'pending-activity'; id: string; items: AgentChatMessage[] };

/** Attach tool/thinking rows to the assistant reply in the same turn (not as separate bubbles). */
function groupChatMessages(messages: AgentChatMessage[]): ChatRenderBlock[] {
  const blocks: ChatRenderBlock[] = [];
  let index = 0;
  while (index < messages.length) {
    const current = messages[index];
    if (current.role === 'user') {
      blocks.push({ kind: 'user', message: current });
      index += 1;
      continue;
    }

    const activity: AgentChatMessage[] = [];
    let assistant: AgentChatMessage | null = null;
    while (index < messages.length && messages[index].role !== 'user') {
      const item = messages[index];
      if (item.role === 'tool') {
        activity.push(item);
      } else if (item.role === 'assistant') {
        if (assistant && assistant.id !== item.id) {
          blocks.push({ kind: 'assistant', message: assistant, activity: activity.splice(0) });
        }
        assistant = item;
      }
      index += 1;
    }

    if (assistant) {
      blocks.push({ kind: 'assistant', message: assistant, activity });
    } else if (activity.length) {
      blocks.push({ kind: 'pending-activity', id: activity[0].id, items: activity });
    }
  }
  return blocks;
}

function activitySummary(items: AgentChatMessage[]): string {
  const thinking = items.filter((item) => (item.meta || '').toLowerCase() === 'thinking');
  const tools = items.filter((item) => (item.meta || '').toLowerCase() !== 'thinking');
  const parts: string[] = [];
  if (thinking.length) parts.push('思考过程');
  if (tools.length) {
    const names = [...new Set(tools.map((item) => item.meta || 'tool'))];
    const preview = names.slice(0, 4).join(' · ');
    parts.push(tools.length === 1
      ? `工具 ${preview}`
      : `${tools.length} 次工具调用${preview ? `（${preview}${names.length > 4 ? '…' : ''}）` : ''}`);
  }
  return parts.join(' · ') || '后台活动';
}

/** Strip leaked thinking / tool dumps from assistant body markdown. */
function sanitizeAssistantContent(content: string): string {
  return content
    .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '')
    .replace(/<\/?think(?:ing)?>/gi, '')
    .replace(/^#{1,3}\s*thinking[\s\S]*?(?=\n#{1,3}\s|\n\n[^#]|$)/gi, '')
    .trim();
}

function messagePreview(content: string, max = 72): string {
  const flat = (content || '')
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/[#>*`_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '空消息';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function AgentChatPanel({
  workflowId,
  workflowName,
  autoStart = false,
  capturePdf = true,
  analyzeMode = 'test-enhance',
  analyzeNote = '',
  forceNewSession = false,
  onBusyChange,
  onAutoStarted,
}: AgentChatPanelProps): ReactElement {
  const [status, setStatus] = useState<AgentBridgeStatus | null>(null);
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [customModelIdDraft, setCustomModelIdDraft] = useState('');
  const [customModelNameDraft, setCustomModelNameDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [pendingModelKey, setPendingModelKey] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [sessionsWidth, setSessionsWidth] = useState(() => readPaneWidth('agent-sessions', 220));
  const [streamingId, setStreamingId] = useState<string | null>(null);
  /** Message ids the user has collapsed (messages default expanded). */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  /** Activity fold ids the user has expanded (tool/thinking default collapsed). */
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(() => new Set());
  /** Local artifact fold ids expanded (default collapsed). */
  const [expandedArtifactIds, setExpandedArtifactIds] = useState<Set<string>>(() => new Set());
  const [previewArtifact, setPreviewArtifact] = useState<LocalArtifactRef | null>(null);
  const [workflows, setWorkflows] = useState<PlaywrightWorkflowMeta[]>([]);
  const [mentionedWorkflow, setMentionedWorkflow] = useState<MentionedWorkflow | null>(
    () => (workflowId ? { id: workflowId, name: workflowName || workflowId } : null),
  );
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [panelAnalyzeMode, setPanelAnalyzeMode] = useState<AgentAnalyzeMode>(analyzeMode);
  const listRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoStartedRef = useRef(false);
  const startAnalyzeRef = useRef<(
    withPdf?: boolean,
    note?: string,
    options?: {
      freshSession?: boolean;
      workflow?: MentionedWorkflow | null;
      mode?: AgentAnalyzeMode;
    },
  ) => Promise<void>>(async () => undefined);
  const onAutoStartedRef = useRef(onAutoStarted);
  const activeSessionIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    onAutoStartedRef.current = onAutoStarted;
  }, [onAutoStarted]);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (workflowId) {
      setMentionedWorkflow({ id: workflowId, name: workflowName || workflowId });
      return;
    }
    setMentionedWorkflow(null);
  }, [workflowId, workflowName]);

  useEffect(() => {
    setPanelAnalyzeMode(analyzeMode);
  }, [analyzeMode]);

  useEffect(() => {
    if (!window.playwright?.listWorkflows) return;
    void window.playwright.listWorkflows()
      .then((list) => setWorkflows(list))
      .catch(() => undefined);
  }, []);

  const sessionsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshSessions = useCallback(async (preferId?: string | null) => {
    if (!window.agent) return;
    const list = await window.agent.listSessions();
    setSessions(list);
    const nextId = preferId
      || activeSessionIdRef.current
      || list[0]?.id
      || null;
    if (!nextId) {
      setActiveSessionId(null);
      setMessages([]);
      return;
    }
    if (nextId !== activeSessionIdRef.current) {
      const detail = await window.agent.getSession(nextId);
      setActiveSessionId(nextId);
      setMessages(detail?.messages || []);
    }
  }, []);

  const scheduleRefreshSessions = useCallback((preferId?: string | null) => {
    if (sessionsRefreshTimer.current) {
      clearTimeout(sessionsRefreshTimer.current);
    }
    sessionsRefreshTimer.current = setTimeout(() => {
      sessionsRefreshTimer.current = null;
      void refreshSessions(preferId);
    }, 320);
  }, [refreshSessions]);

  const loadSession = useCallback(async (id: string) => {
    if (!window.agent) return;
    const detail = await window.agent.switchSession(id);
    setActiveSessionId(detail.id);
    setMessages(detail.messages || []);
    setStreamingId(null);
    autoStartedRef.current = false;
    if (detail.workflowId) {
      setMentionedWorkflow({
        id: detail.workflowId,
        name: detail.workflowName || detail.workflowId,
      });
    } else if (!workflowId) {
      setMentionedWorkflow(null);
    }
    // Sidebar already has rows; refresh summaries in background.
    scheduleRefreshSessions(detail.id);
  }, [scheduleRefreshSessions, workflowId]);

  const refreshStatus = useCallback(async () => {
    if (!window.agent) {
      setError('Agent 桥接不可用，请在 Electron 窗口中打开。');
      return;
    }
    const next = await window.agent.getStatus();
    setStatus(next);
    setBaseUrlDraft(next.baseUrl || DEFAULT_OPENAI_BASE_URL);
    setPendingModelKey((current) => (
      current && current !== next.modelKey ? current : null
    ));
    if (next.chatSessionId && next.chatSessionId !== activeSessionIdRef.current) {
      setActiveSessionId(next.chatSessionId);
    }
    if (!next.hasApiKey) {
      setShowKey(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (!window.agent) {
          setError('Agent 桥接不可用，请在 Electron 窗口中打开。');
          return;
        }
        // Show session list first; model catalog can load in the background.
        const [statusResult, list] = await Promise.all([
          window.agent.getStatus(),
          window.agent.listSessions(),
        ]);
        setStatus(statusResult);
        if (!statusResult.hasApiKey) setShowKey(true);
        setSessions(list);
        const initialId = statusResult.chatSessionId
          || list[0]?.id
          || null;
        if (initialId) {
          const detail = await window.agent.getSession(initialId);
          setActiveSessionId(initialId);
          setMessages(detail?.messages || []);
        }
        void window.agent.listModels()
          .then(() => refreshStatus())
          .catch(() => undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载 Agent 状态失败');
      }
    })();
    return () => {
      if (sessionsRefreshTimer.current) {
        clearTimeout(sessionsRefreshTimer.current);
      }
    };
  }, [refreshStatus]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!window.agent) return undefined;
    return window.agent.onEvent((event: AgentStreamEvent) => {
      if (event.type === 'sessions_changed') {
        scheduleRefreshSessions(event.activeId);
        return;
      }
      if ('chatSessionId' in event && event.chatSessionId
        && activeSessionIdRef.current
        && event.chatSessionId !== activeSessionIdRef.current) {
        // Ignore stream events for background sessions.
        if (event.type === 'assistant_delta' || event.type === 'assistant_done'
          || event.type === 'user' || event.type === 'tool') {
          return;
        }
      }
      if (event.type === 'user') {
        setMessages((prev) => [
          ...prev,
          {
            id: event.messageId,
            role: 'user',
            content: event.content,
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }
      if (event.type === 'assistant_delta') {
        setStreamingId(event.messageId);
        setMessages((prev) => {
          const index = prev.findIndex((item) => item.id === event.messageId);
          if (index >= 0) {
            const copy = [...prev];
            copy[index] = {
              ...copy[index],
              content: `${copy[index].content}${event.delta}`,
            };
            return copy;
          }
          return [
            ...prev,
            {
              id: event.messageId,
              role: 'assistant',
              content: event.delta,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        return;
      }
      if (event.type === 'assistant_done') {
        setStreamingId(null);
        setMessages((prev) => {
          const index = prev.findIndex((item) => item.id === event.messageId);
          if (index < 0) {
            return [
              ...prev,
              {
                id: event.messageId,
                role: 'assistant',
                content: event.content,
                createdAt: new Date().toISOString(),
              },
            ];
          }
          const copy = [...prev];
          copy[index] = { ...copy[index], content: event.content || copy[index].content };
          return copy;
        });
        scheduleRefreshSessions(event.chatSessionId);
        return;
      }
      if (event.type === 'tool') {
        setMessages((prev) => {
          const nextMsg: AgentChatMessage = {
            id: event.messageId,
            role: 'tool',
            content: event.detail || '调用工具',
            meta: event.name,
            createdAt: new Date().toISOString(),
          };
          const index = prev.findIndex((item) => item.id === event.messageId);
          if (index < 0) return [...prev, nextMsg];
          const copy = [...prev];
          copy[index] = { ...copy[index], ...nextMsg, createdAt: copy[index].createdAt };
          return copy;
        });
        return;
      }
      if (event.type === 'status') {
        setBusy(event.phase === 'running');
        if (event.chatSessionId && event.chatSessionId !== activeSessionIdRef.current) {
          setActiveSessionId(event.chatSessionId);
        }
        return;
      }
      if (event.type === 'error') {
        setError(event.message);
        setBusy(false);
        void refreshStatus();
        return;
      }
      if (event.type === 'done') {
        setBusy(false);
        void refreshStatus();
        scheduleRefreshSessions(event.chatSessionId);
      }
    });
  }, [refreshStatus, scheduleRefreshSessions]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return undefined;
    const onScroll = () => {
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      const nearBottom = gap < 96;
      stickToBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    };
    onScroll();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const node = listRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
    setAtBottom(true);
  }, [messages, busy, streamingId]);

  function jumpToOutputBottom(): void {
    const node = listRef.current;
    stickToBottomRef.current = true;
    setAtBottom(true);
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }

  useEffect(() => {
    if (!modelOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const node = modelMenuRef.current;
      if (node && !node.contains(event.target as Node)) {
        setModelOpen(false);
        setModelQuery('');
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelOpen(false);
        setModelQuery('');
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [modelOpen]);

  const selectedModelKey = pendingModelKey || status?.modelKey || status?.modelId || '';

  const selectedModel = useMemo(() => {
    const models = status?.models || [];
    return models.find((item) => modelValue(item) === selectedModelKey)
      || models.find((item) => item.id === status?.modelId)
      || null;
  }, [selectedModelKey, status?.modelId, status?.models]);

  const modelGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const groups = new Map<string, AgentModelInfo[]>();
    for (const model of status?.models || []) {
      if (q) {
        const hay = `${model.displayName || ''} ${model.id} ${model.description || ''} ${model.group || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const group = model.group || 'Other';
      const list = groups.get(group) || [];
      list.push(model);
      groups.set(group, list);
    }
    return [...groups.entries()];
  }, [modelQuery, status?.models]);

  const mentionCandidates = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    const list = workflows.filter((item) => {
      if (!q) return true;
      const hay = `${item.name} ${item.url} ${item.id}`.toLowerCase();
      return hay.includes(q);
    });
    return list.slice(0, 40);
  }, [mentionQuery, workflows]);

  const effectiveWorkflowId = mentionedWorkflow?.id || workflowId || null;

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionQuery('');
    setMentionIndex(0);
    setMentionStart(null);
  }, []);

  const openMentionPicker = useCallback((options?: { keepQuery?: boolean }) => {
    if (window.playwright?.listWorkflows) {
      void window.playwright.listWorkflows()
        .then((list) => {
          setWorkflows(list);
          const currentId = mentionedWorkflow?.id;
          if (currentId) {
            const q = (options?.keepQuery ? mentionQuery : '').trim().toLowerCase();
            const visible = list.filter((item) => {
              if (!q) return true;
              const hay = `${item.name} ${item.url} ${item.id}`.toLowerCase();
              return hay.includes(q);
            });
            const index = visible.findIndex((item) => item.id === currentId);
            setMentionIndex(index >= 0 ? index : 0);
          } else {
            setMentionIndex(0);
          }
        })
        .catch(() => undefined);
    }
    if (!options?.keepQuery) {
      setMentionQuery('');
      setMentionStart(null);
    }
    setMentionOpen(true);
  }, [mentionQuery, mentionedWorkflow?.id]);

  const applyMention = useCallback((workflow: PlaywrightWorkflowMeta) => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? draft.length;
    const start = mentionStart ?? findAtMention(draft, cursor)?.start ?? null;
    let nextDraft = draft;
    if (start != null) {
      const before = draft.slice(0, start);
      const after = draft.slice(cursor);
      nextDraft = `${before}${after}`.replace(/^\s+/, '');
    }
    setDraft(nextDraft);
    setMentionedWorkflow({ id: workflow.id, name: workflow.name, url: workflow.url });
    closeMention();
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      const pos = nextDraft.length;
      node.setSelectionRange(pos, pos);
    });
  }, [closeMention, draft, mentionStart]);

  useEffect(() => {
    if (!mentionOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const node = composerRef.current;
      if (node && !node.contains(event.target as Node)) {
        closeMention();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [closeMention, mentionOpen]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const startAnalyze = useCallback(async (
    withPdf = capturePdf,
    note = analyzeNote,
    options?: {
      freshSession?: boolean;
      workflow?: MentionedWorkflow | null;
      mode?: AgentAnalyzeMode;
    },
  ) => {
    const target = options?.workflow || mentionedWorkflow || (
      workflowId ? { id: workflowId, name: workflowName || workflowId } : null
    );
    if (!target?.id || !window.agent) return;
    const mode = options?.mode || panelAnalyzeMode;
    setError('');
    setBusy(true);
    try {
      let chatSessionId = activeSessionId || undefined;
      if (options?.freshSession) {
        const created = await window.agent.createSession({
          workflowId: target.id,
          workflowName: target.name,
          title: target.name ? `${analyzeModeLabel(mode)} · ${target.name}` : undefined,
        });
        chatSessionId = created.id;
        setActiveSessionId(created.id);
        setMessages([]);
        setStreamingId(null);
        setCollapsedIds(new Set());
        setExpandedActivityIds(new Set());
        setExpandedArtifactIds(new Set());
        scheduleRefreshSessions(created.id);
      } else if (chatSessionId) {
        try {
          await window.agent.updateSession({
            id: chatSessionId,
            workflowId: target.id,
            workflowName: target.name,
          });
        } catch {
          // ignore bind failures; analyze still carries workflowId
        }
      }
      setMentionedWorkflow(target);
      await window.agent.analyzeWorkflow({
        workflowId: target.id,
        capturePdf: withPdf,
        mode,
        note: note?.trim() || undefined,
        modelKey: selectedModelKey || status?.modelKey,
        modelId: status?.modelId,
        modelParams: status?.modelParams,
        chatSessionId,
      });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '启动分析失败');
    }
  }, [
    activeSessionId,
    analyzeNote,
    capturePdf,
    mentionedWorkflow,
    panelAnalyzeMode,
    scheduleRefreshSessions,
    selectedModelKey,
    status?.modelId,
    status?.modelKey,
    status?.modelParams,
    workflowId,
    workflowName,
  ]);

  startAnalyzeRef.current = startAnalyze;

  // Auto-start at most once per mount / autoStart rising edge.
  // Do NOT depend on startAnalyze identity — it changes on every status tick and was
  // spawning duplicate sessions (especially with forceNewSession).
  useEffect(() => {
    if (!autoStart) {
      autoStartedRef.current = false;
      return;
    }
    if (!workflowId || autoStartedRef.current) return;
    if (!status?.hasApiKey) return;
    autoStartedRef.current = true;
    onAutoStartedRef.current?.();
    void startAnalyzeRef.current(capturePdf, analyzeNote, {
      freshSession: forceNewSession,
      mode: analyzeMode,
    });
    // capturePdf / analyzeNote / mode / forceNewSession are read once at the rising edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot auto-start
  }, [autoStart, status?.hasApiKey, workflowId]);

  async function handleSaveProviderConfig(): Promise<void> {
    setError('');
    try {
      const payload: Parameters<typeof window.agent.setConfig>[0] = {};
      if (apiKeyDraft.trim()) {
        payload.apiKey = apiKeyDraft.trim();
      }
      if (status?.provider === 'openai-compatible') {
        payload.baseUrl = baseUrlDraft.trim() || DEFAULT_OPENAI_BASE_URL;
      }
      const next = await window.agent.setConfig(payload);
      setStatus(next);
      setApiKeyDraft('');
      setBaseUrlDraft(next.baseUrl || DEFAULT_OPENAI_BASE_URL);
      setShowKey(false);
      await window.agent.listModels();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败');
    }
  }

  async function handleProviderChange(nextProvider: AgentProviderKind): Promise<void> {
    if (!nextProvider || nextProvider === status?.provider) return;
    setError('');
    try {
      const next = await window.agent.setConfig({ provider: nextProvider });
      setStatus(next);
      setBaseUrlDraft(next.baseUrl || DEFAULT_OPENAI_BASE_URL);
      setApiKeyDraft('');
      setShowKey(!next.hasApiKey);
      await window.agent.listModels();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换 Provider 失败');
    }
  }

  async function handleAddCustomModel(): Promise<void> {
    const id = customModelIdDraft.trim();
    if (!id) return;
    setError('');
    try {
      const next = await window.agent.setConfig({
        addCustomModel: {
          id,
          displayName: customModelNameDraft.trim() || undefined,
        },
        modelKey: id,
      });
      setStatus(next);
      setCustomModelIdDraft('');
      setCustomModelNameDraft('');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加自定义模型失败');
    }
  }

  async function handleRemoveCustomModel(id: string): Promise<void> {
    setError('');
    try {
      const next = await window.agent.setConfig({ removeCustomModelId: id });
      setStatus(next);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除自定义模型失败');
    }
  }

  async function handleModelChange(nextKey: string): Promise<void> {
    if (!nextKey || nextKey === selectedModelKey) {
      setModelOpen(false);
      return;
    }
    setError('');
    setPendingModelKey(nextKey);
    setModelOpen(false);
    setModelQuery('');
    setStatus((prev) => {
      if (!prev) return prev;
      const matched = prev.models.find((item) => modelValue(item) === nextKey);
      return {
        ...prev,
        modelKey: nextKey,
        modelId: matched?.id || nextKey.split('?')[0] || prev.modelId,
        modelParams: matched?.params,
      };
    });
    try {
      const next = await window.agent.setConfig({ modelKey: nextKey });
      setStatus(next);
      setPendingModelKey(null);
    } catch (err) {
      setPendingModelKey(null);
      await refreshStatus();
      setError(err instanceof Error ? err.message : '切换模型失败');
    }
  }

  function syncMentionFromDraft(nextDraft: string, cursor: number): void {
    const trigger = findAtMention(nextDraft, cursor);
    if (!trigger) {
      if (mentionOpen) closeMention();
      return;
    }
    if (!mentionOpen && window.playwright?.listWorkflows) {
      void window.playwright.listWorkflows()
        .then((list) => setWorkflows(list))
        .catch(() => undefined);
    }
    setMentionOpen(true);
    setMentionQuery(trigger.query);
    setMentionStart(trigger.start);
  }

  function handleDraftChange(value: string, cursor: number): void {
    setDraft(value);
    syncMentionFromDraft(value, cursor);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionOpen && mentionCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((index) => (
          (index - 1 + mentionCandidates.length) % mentionCandidates.length
        ));
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const picked = mentionCandidates[mentionIndex] || mentionCandidates[0];
        if (picked) applyMention(picked);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const picked = mentionCandidates[mentionIndex] || mentionCandidates[0];
        if (picked) applyMention(picked);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (form && !busy && draft.trim() && status?.hasApiKey) {
        form.requestSubmit();
      }
    }
  }

  async function handleSend(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (mentionOpen) closeMention();
    const text = draft.trim();
    if (!text || busy) return;

    const target = mentionedWorkflow || (
      workflowId ? { id: workflowId, name: workflowName || workflowId } : null
    );
    // New / empty session: first send starts analysis with the Prompt.
    // Follow-ups stay as normal chat turns.
    const shouldAnalyze = Boolean(target && messages.length === 0);

    if (!target) {
      setError('请先输入 @ 选择一次录制，再填写 Prompt 发送分析。');
      return;
    }

    setDraft('');
    setError('');

    if (shouldAnalyze) {
      await startAnalyze(false, text, { workflow: target, mode: panelAnalyzeMode });
      return;
    }

    setBusy(true);
    try {
      await window.agent.send({
        message: text,
        modelKey: selectedModelKey || status?.modelKey,
        modelId: status?.modelId,
        modelParams: status?.modelParams,
        workflowId: target.id,
        chatSessionId: activeSessionId || undefined,
      });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '发送失败');
    }
  }

  async function handleClear(): Promise<void> {
    try {
      await window.agent.clearSession();
      setMessages([]);
      setStreamingId(null);
      autoStartedRef.current = false;
      await refreshStatus();
      await refreshSessions(activeSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空失败');
    }
  }

  async function handleCreateSession(): Promise<void> {
    try {
      const created = await window.agent.createSession({
        workflowId: workflowId || mentionedWorkflow?.id || null,
        workflowName: workflowName || mentionedWorkflow?.name || null,
      });
      setActiveSessionId(created.id);
      setMessages([]);
      setStreamingId(null);
      autoStartedRef.current = false;
      setDraft('');
      closeMention();
      if (!workflowId) {
        setMentionedWorkflow(null);
      }
      await refreshSessions(created.id);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建会话失败');
    }
  }

  async function handleDeleteSession(id: string, title: string): Promise<void> {
    const ok = await askConfirm({
      title: '删除会话',
      message: `确定删除「${title || '该会话'}」？消息将无法恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await window.agent.deleteSession(id);
      setStreamingId(null);
      if (result.activeId) {
        const detail = await window.agent.getSession(result.activeId);
        setActiveSessionId(result.activeId);
        setMessages(detail?.messages || []);
      } else {
        setActiveSessionId(null);
        setMessages([]);
      }
      await refreshSessions(result.activeId);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除会话失败');
    }
  }

  async function handleDeleteMessages(ids: string[], label: string): Promise<void> {
    const sessionId = activeSessionId;
    if (!ids.length || !sessionId) return;
    const ok = await askConfirm({
      title: '删除消息',
      message: `确定删除「${label}」？删除后无法恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const detail = await window.agent.deleteMessages({
        sessionId,
        messageIds: ids,
      });
      setMessages(detail.messages || []);
      setCollapsedIds((prev) => {
        const copy = new Set(prev);
        for (const id of ids) copy.delete(id);
        return copy;
      });
      scheduleRefreshSessions(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除消息失败');
    }
  }

  function resizeSessions(delta: number): void {
    setSessionsWidth((width) => storePaneWidth('agent-sessions', width + delta, 180, 420));
  }

  async function handleRenameSession(id: string): Promise<void> {
    const title = renameDraft.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      await window.agent.updateSession({ id, title });
      setRenamingId(null);
      setRenameDraft('');
      await refreshSessions(activeSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    }
  }

  const modelCount = status?.models?.length || 0;
  const modelLocked = busy;
  const activeSession = sessions.find((item) => item.id === activeSessionId) || null;
  const renderBlocks = useMemo(() => groupChatMessages(messages), [messages]);

  return (
    <section
      className="agent-panel"
      style={{ '--agent-sessions-width': `${sessionsWidth}px` } as CSSProperties}
    >
      <aside className="agent-sessions">
        <div className="agent-sessions-head">
          <strong>会话</strong>
          <button type="button" className="pw-tool-btn" disabled={busy} onClick={() => { void handleCreateSession(); }}>
            新建
          </button>
        </div>
        <div className="agent-sessions-list">
          {sessions.length === 0 ? (
            <p className="agent-sessions-empty">暂无会话</p>
          ) : (
            sessions.map((session) => {
              const active = session.id === activeSessionId;
              const renaming = renamingId === session.id;
              return (
                <div key={session.id} className={`agent-session-item${active ? ' is-active' : ''}`}>
                  {renaming ? (
                    <form
                      className="agent-session-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleRenameSession(session.id);
                      }}
                    >
                      <input
                        value={renameDraft}
                        autoFocus
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => { void handleRenameSession(session.id); }}
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="agent-session-main"
                      disabled={busy && !active}
                      onClick={() => { void loadSession(session.id); }}
                      onDoubleClick={() => {
                        setRenamingId(session.id);
                        setRenameDraft(session.title);
                      }}
                    >
                      <strong>{session.title}</strong>
                      <span>{formatSessionTime(session.updatedAt)} · {session.messageCount} 条</span>
                    </button>
                  )}
                  <div className="agent-session-ops">
                    <button
                      type="button"
                      className="agent-icon-btn"
                      title="重命名"
                      aria-label="重命名"
                      disabled={busy}
                      onClick={() => {
                        setRenamingId(session.id);
                        setRenameDraft(session.title);
                      }}
                    >
                      <IconEdit />
                    </button>
                    <button
                      type="button"
                      className="agent-icon-btn is-danger"
                      title="删除"
                      aria-label="删除"
                      disabled={busy}
                      onClick={() => { void handleDeleteSession(session.id, session.title); }}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <ResizeHandle label="调整会话列表宽度" onResize={resizeSessions} />

      <div className="agent-main">
        <header className="agent-chrome">
          <div className="agent-chrome-top">
            <div className="agent-chrome-meta">
              <span className="agent-chrome-eyebrow">
                {activeSession ? '当前会话' : 'Agent 分析'}
              </span>
              <strong>{activeSession?.title || workflowName || '未选择会话'}</strong>
              <em>
                {workflowName ? `工作流 · ${workflowName}` : '选择工作流后可一键分析'}
              </em>
            </div>
            <div className="agent-chrome-controls">
              <div className={`agent-model-field${modelOpen ? ' is-open' : ''}`} ref={modelMenuRef}>
                <button
                  type="button"
                  className="agent-model-trigger"
                  disabled={modelLocked || !modelCount}
                  aria-haspopup="listbox"
                  aria-expanded={modelOpen}
                  title={selectedModel?.description || selectedModelKey}
                  onClick={() => {
                    if (modelLocked || !modelCount) return;
                    setModelOpen((open) => !open);
                  }}
                >
                  <em>模型{modelCount ? ` · ${modelCount}` : ''}</em>
                  <span>{selectedModel?.displayName || selectedModelKey || '选择模型'}</span>
                  <i aria-hidden>▾</i>
                </button>
                {modelOpen ? (
                  <div className="agent-model-menu" role="listbox">
                    <input
                      className="agent-model-search"
                      value={modelQuery}
                      autoFocus
                      placeholder={
                        status?.provider === 'openai-compatible'
                          ? '搜索 GPT / DeepSeek / Qwen / 自定义…'
                          : '搜索 Cursor / Claude / GPT / Gemini…'
                      }
                      onChange={(e) => setModelQuery(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                    <div className="agent-model-menu-scroll">
                      {modelGroups.length === 0 ? (
                        <p className="agent-model-empty">没有匹配的模型</p>
                      ) : (
                        modelGroups.map(([group, models]) => (
                          <div key={group} className="agent-model-group">
                            <header>{group}</header>
                            {models.map((model) => {
                              const value = modelValue(model);
                              const selected = value === selectedModelKey;
                              return (
                                <button
                                  key={value}
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  className={`agent-model-option${selected ? ' is-active' : ''}`}
                                  title={model.description || model.id}
                                  onClick={() => { void handleModelChange(value); }}
                                >
                                  <strong>{model.displayName || model.id}</strong>
                                  <span>{model.id}</span>
                                </button>
                              );
                            })}
                          </div>
                        ))
                      )}
                    </div>
                    <p className="agent-model-footnote">
                      {status?.provider === 'openai-compatible'
                        ? 'OpenAI 兼容通道：使用预设或自定义模型 ID，需与 Base URL 匹配。'
                        : 'Cursor 通道：内置常用模型；配置 API Key 后点「刷新」可合并账户可用项。'}
                    </p>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="pw-tool-btn"
                disabled={busy}
                onClick={() => {
                  void window.agent.listModels().then(() => refreshStatus()).catch((err) => {
                    setError(err instanceof Error ? err.message : '刷新模型失败');
                  });
                }}
              >
                刷新
              </button>
              <button type="button" className="pw-tool-btn" disabled={busy} onClick={() => setShowKey((v) => !v)}>
                {status?.hasApiKey
                  ? `${status.provider === 'openai-compatible' ? '兼容' : 'Cursor'} ${status.apiKeyHint}`
                  : '接入配置'}
              </button>
            </div>
          </div>

          {showKey ? (
            <div className="agent-key-box">
              <label className="field">
                Provider
                <PwSelect
                  value={status?.provider || 'cursor'}
                  disabled={busy}
                  onChange={(value) => {
                    void handleProviderChange(value as AgentProviderKind);
                  }}
                  options={AGENT_PROVIDER_OPTIONS.map((item) => ({
                    value: item.id,
                    label: item.label,
                    description: item.hint,
                  }))}
                />
                <span className="hint">
                  {AGENT_PROVIDER_OPTIONS.find((item) => item.id === (status?.provider || 'cursor'))?.hint}
                </span>
              </label>

              {status?.provider === 'openai-compatible' ? (
                <label className="field">
                  Base URL
                  <input
                    type="text"
                    value={baseUrlDraft}
                    placeholder={DEFAULT_OPENAI_BASE_URL}
                    onChange={(e) => setBaseUrlDraft(e.target.value)}
                  />
                  <span className="hint">
                    示例：OpenAI / DeepSeek `…/v1` · 通义 `…/compatible-mode/v1` · OpenRouter `…/api/v1`
                  </span>
                </label>
              ) : null}

              <label className="field">
                {status?.provider === 'openai-compatible' ? 'API Key' : 'Cursor API Key'}
                <input
                  type="password"
                  value={apiKeyDraft}
                  placeholder={
                    status?.hasApiKey
                      ? '已保存，重新输入可覆盖'
                      : (status?.provider === 'openai-compatible' ? 'sk-…' : 'cursor_…')
                  }
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                />
              </label>

              {status?.provider === 'openai-compatible' ? (
                <div className="agent-custom-models">
                  <div className="agent-custom-models-form">
                    <label className="field">
                      自定义模型 ID
                      <input
                        type="text"
                        value={customModelIdDraft}
                        placeholder="例如 deepseek-chat / qwen-plus"
                        onChange={(e) => setCustomModelIdDraft(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      显示名（可选）
                      <input
                        type="text"
                        value={customModelNameDraft}
                        placeholder="列表里显示的名称"
                        onChange={(e) => setCustomModelNameDraft(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!customModelIdDraft.trim()}
                      onClick={() => { void handleAddCustomModel(); }}
                    >
                      添加模型
                    </button>
                  </div>
                  {(status.customModels || []).length ? (
                    <ul className="agent-custom-models-list">
                      {status.customModels.map((item) => (
                        <li key={item.id}>
                          <div>
                            <strong>{item.displayName || item.id}</strong>
                            <span>{item.id}</span>
                          </div>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => { void handleRemoveCustomModel(item.id); }}
                          >
                            移除
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="hint">可添加网关/厂商要求的精确 model id；也会出现在上方模型列表「自定义」分组。</p>
                  )}
                </div>
              ) : null}

              <div className="agent-key-actions">
                <button type="button" className="btn-primary" onClick={() => { void handleSaveProviderConfig(); }}>
                  保存
                </button>
                {status?.hasApiKey ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      void window.agent.setConfig({ clearApiKey: true }).then(() => refreshStatus());
                    }}
                  >
                    清除 Key
                  </button>
                ) : null}
                <span className="hint">
                  {status?.provider === 'openai-compatible'
                    ? 'Key 仅本机 safeStorage；也可用 OPENAI_API_KEY / OPENAI_BASE_URL。'
                    : 'Key 仅本机 safeStorage；也可用 CURSOR_API_KEY。'}
                </span>
              </div>
            </div>
          ) : null}
        </header>

        <div className="agent-chat-shell">
          <div className="agent-chat-log" ref={listRef}>
            {messages.length === 0 ? (
              <div className="agent-empty">
                <strong>把 Playwright 工作流交给 Agent 分析</strong>
                <p>
                  在下方输入框输入 @ 选择一次录制，再填写 Prompt 发送即可开始分析；也可使用「导出 PDF 并分析」或「脚本 / 产物分析」。本地产物会出现在回复底部。
                </p>
              </div>
            ) : (
              renderBlocks.map((block) => {
              if (block.kind === 'pending-activity') {
                const foldId = `activity-${block.id}`;
                const running = busy && renderBlocks[renderBlocks.length - 1] === block;
                const open = running || expandedActivityIds.has(foldId);
                return (
                  <div key={foldId} className={`agent-activity-fold${running ? ' is-running' : ''}${open ? ' is-open' : ''}`}>
                    <div className="agent-bubble-toolbar">
                      <button
                        type="button"
                        className="agent-activity-summary"
                        onClick={() => {
                          setExpandedActivityIds((prev) => {
                            const copy = new Set(prev);
                            if (copy.has(foldId)) copy.delete(foldId);
                            else copy.add(foldId);
                            return copy;
                          });
                        }}
                      >
                        <span>{activitySummary(block.items)}</span>
                        {running ? (
                          <em className="agent-stream-badge" aria-live="polite">
                            <span className="agent-stream-dots" aria-hidden>
                              <i /><i /><i />
                            </span>
                            进行中
                          </em>
                        ) : (
                          <em>{open ? '收起' : '展开'}</em>
                        )}
                      </button>
                      <button
                        type="button"
                        className="agent-icon-btn is-danger agent-bubble-delete"
                        title="删除"
                        aria-label="删除消息"
                        disabled={busy || running}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteMessages(
                            block.items.map((item) => item.id),
                            '工具 / 思考记录',
                          );
                        }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                    {open ? (
                      <ul className="agent-activity-list">
                        {block.items.map((item) => {
                          const isThinking = (item.meta || '').toLowerCase() === 'thinking';
                          return (
                            <li key={item.id} className={isThinking ? 'is-thinking' : ''}>
                              <strong>{isThinking ? '思考' : (item.meta || 'tool')}</strong>
                              <pre>{item.content || (isThinking ? '…' : '调用工具')}</pre>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                );
              }

              if (block.kind === 'user') {
                const item = block.message;
                const open = !collapsedIds.has(item.id);
                return (
                  <article
                    key={item.id}
                    className={`agent-bubble is-user${open ? ' is-open' : ' is-collapsed'}`}
                  >
                    <div className="agent-bubble-toolbar">
                      <button
                        type="button"
                        className="agent-bubble-summary"
                        onClick={() => {
                          setCollapsedIds((prev) => {
                            const copy = new Set(prev);
                            if (copy.has(item.id)) copy.delete(item.id);
                            else copy.add(item.id);
                            return copy;
                          });
                        }}
                      >
                        <span className="agent-bubble-role">你</span>
                        <span className="agent-bubble-preview">{messagePreview(item.content)}</span>
                        <em>{open ? '收起' : '展开'}</em>
                      </button>
                      <button
                        type="button"
                        className="agent-icon-btn is-danger agent-bubble-delete"
                        title="删除"
                        aria-label="删除消息"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteMessages([item.id], '你的消息');
                        }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                    {open ? (
                      <div className="agent-bubble-body">
                        <div className="agent-plain">{item.content}</div>
                      </div>
                    ) : null}
                  </article>
                );
              }

              const item = block.message;
              const activity = block.activity;
              const streaming = busy && item.id === streamingId;
              const body = sanitizeAssistantContent(item.content);
              const artifacts = extractLocalArtifacts(
                body,
                ...activity.map((toolItem) => toolItem.content),
              );
              if (!body && !streaming && activity.length === 0 && artifacts.length === 0) {
                return null;
              }
              const open = streaming || !collapsedIds.has(item.id);
              const activityId = `activity-in-${item.id}`;
              const activityOpen = expandedActivityIds.has(activityId);
              const artifactId = `artifacts-in-${item.id}`;
              const artifactsOpen = expandedArtifactIds.has(artifactId);
              return (
                <article
                  key={item.id}
                  className={`agent-bubble is-assistant${open ? ' is-open' : ' is-collapsed'}${streaming ? ' is-streaming' : ''}`}
                >
                  <div className="agent-bubble-toolbar">
                    <button
                      type="button"
                      className="agent-bubble-summary"
                      onClick={() => {
                        if (streaming) return;
                        setCollapsedIds((prev) => {
                          const copy = new Set(prev);
                          if (copy.has(item.id)) copy.delete(item.id);
                          else copy.add(item.id);
                          return copy;
                        });
                      }}
                    >
                      <span className="agent-bubble-role">Agent</span>
                      <span className="agent-bubble-preview">
                        {activity.length ? `${activitySummary(activity)} · ` : ''}
                        {artifacts.length ? `${artifacts.length} 个产物 · ` : ''}
                        {messagePreview(body || (streaming ? '正在生成…' : ''))}
                      </span>
                      {streaming ? (
                        <em className="agent-stream-badge" aria-live="polite">
                          <span className="agent-stream-dots" aria-hidden>
                            <i /><i /><i />
                          </span>
                          生成中
                        </em>
                      ) : (
                        <em>{open ? '收起' : '展开'}</em>
                      )}
                    </button>
                    <button
                      type="button"
                      className="agent-icon-btn is-danger agent-bubble-delete"
                      title="删除"
                      aria-label="删除消息"
                      disabled={busy || streaming}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDeleteMessages(
                          [item.id, ...activity.map((toolItem) => toolItem.id)],
                          'Agent 回复',
                        );
                      }}
                    >
                      <IconTrash />
                    </button>
                  </div>
                  {open ? (
                    <div className="agent-bubble-body">
                      {activity.length ? (
                        <div className={`agent-activity-fold is-nested${activityOpen ? ' is-open' : ''}`}>
                          <button
                            type="button"
                            className="agent-activity-summary"
                            onClick={() => {
                              setExpandedActivityIds((prev) => {
                                const copy = new Set(prev);
                                if (copy.has(activityId)) copy.delete(activityId);
                                else copy.add(activityId);
                                return copy;
                              });
                            }}
                          >
                            <span>{activitySummary(activity)}</span>
                            <em>{activityOpen ? '收起' : '展开'}</em>
                          </button>
                          {activityOpen ? (
                            <ul className="agent-activity-list">
                              {activity.map((toolItem) => {
                                const isThinking = (toolItem.meta || '').toLowerCase() === 'thinking';
                                return (
                                  <li key={toolItem.id} className={isThinking ? 'is-thinking' : ''}>
                                    <strong>{isThinking ? '思考' : (toolItem.meta || 'tool')}</strong>
                                    <pre>{toolItem.content || (isThinking ? '…' : '调用工具')}</pre>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                      {body || streaming ? (
                        <AgentMarkdown content={body} streaming={streaming} />
                      ) : null}
                      {artifacts.length ? (
                        <div className={`agent-artifacts-fold${artifactsOpen ? ' is-open' : ''}`}>
                          <button
                            type="button"
                            className="agent-artifacts-summary"
                            onClick={() => {
                              setExpandedArtifactIds((prev) => {
                                const copy = new Set(prev);
                                if (copy.has(artifactId)) copy.delete(artifactId);
                                else copy.add(artifactId);
                                return copy;
                              });
                            }}
                          >
                            <span>本地产物 · {artifacts.length} 个</span>
                            <em>{artifactsOpen ? '收起' : '展开'}</em>
                          </button>
                          {artifactsOpen ? (
                            <ul className="agent-artifacts-list">
                              {artifacts.map((artifact) => {
                                const previewKind = getLocalArtifactPreviewKind(artifact.path);
                                return (
                                  <li key={artifact.path}>
                                    <button
                                      type="button"
                                      className="agent-artifact-open"
                                      title={previewKind ? `预览 ${artifact.path}` : `打开 ${artifact.path}`}
                                      onClick={() => {
                                        if (previewKind) {
                                          setPreviewArtifact(artifact);
                                          return;
                                        }
                                        void window.agent.openLocalPath(artifact.path).catch((err) => {
                                          setError(err instanceof Error ? err.message : '打开文件失败');
                                        });
                                      }}
                                    >
                                      <strong>
                                        {previewKind ? (
                                          <span className="agent-artifact-kind">
                                            {localArtifactPreviewLabel(previewKind)}
                                          </span>
                                        ) : null}
                                        {artifact.name}
                                      </strong>
                                      <span>{artifact.path}</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="agent-artifact-reveal"
                                      title="在文件管理器中显示"
                                      onClick={() => {
                                        void window.agent.revealLocalPath(artifact.path).catch((err) => {
                                          setError(err instanceof Error ? err.message : '打开目录失败');
                                        });
                                      }}
                                    >
                                      目录
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
              })
            )}
          </div>
          {busy ? (
            <button
              type="button"
              className={`agent-jump-bottom${atBottom ? ' is-at-bottom' : ''}`}
              onClick={jumpToOutputBottom}
              title="跳到输出底部"
              aria-label="跳到输出底部"
            >
              <IconJumpDown />
            </button>
          ) : null}
        </div>

        <footer className="agent-dock">
          <form
            ref={composerRef}
            className="agent-composer"
            onSubmit={(e) => { void handleSend(e); }}
          >
            <div className="agent-composer-toolbar">
              <label className="agent-mode-field">
                <span>分析模式</span>
                <PwSelect
                  className="agent-mode-select"
                  value={panelAnalyzeMode}
                  disabled={busy}
                  placement="up"
                  aria-label="分析模式"
                  onChange={(value) => setPanelAnalyzeMode(value as AgentAnalyzeMode)}
                  options={PLAYWRIGHT_ANALYZE_MODES.map((mode) => ({
                    value: mode,
                    label: analyzeModeLabel(mode),
                    description: analyzeModeHint(mode),
                  }))}
                />
              </label>

              <div className="agent-composer-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !effectiveWorkflowId || !status?.hasApiKey}
                  title={`按「${analyzeModeLabel(panelAnalyzeMode)}」分析脚本 / 产物 / 基线（不导出 PDF）`}
                  onClick={() => { void startAnalyze(false, analyzeNote, { mode: panelAnalyzeMode }); }}
                >
                  {busy ? '分析中…' : '开始分析'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !effectiveWorkflowId || !status?.hasApiKey}
                  title="先导出页面 PDF，再按当前模式分析"
                  onClick={() => { void startAnalyze(true, analyzeNote, { mode: panelAnalyzeMode }); }}
                >
                  导出 PDF
                </button>
                <button type="button" className="btn-secondary" disabled={!busy} onClick={() => { void window.agent.cancel(); }}>
                  停止
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => { void handleClear(); }}>
                  清空
                </button>
              </div>

              {status?.mcpUrl ? (
                <span className="agent-mcp-hint" title={status.mcpUrl}>MCP 已连接</span>
              ) : (
                <span className="agent-mcp-hint is-warn">MCP 未就绪</span>
              )}
            </div>

            {mentionOpen ? (
              <div className="agent-mention-menu" role="listbox" aria-label="录制列表">
                <header>切换录制</header>
                <input
                  className="agent-mention-search"
                  value={mentionQuery}
                  autoFocus
                  placeholder="搜索录制名称 / URL…"
                  disabled={busy}
                  onChange={(event) => {
                    setMentionQuery(event.target.value);
                    setMentionIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      if (!mentionCandidates.length) return;
                      setMentionIndex((index) => (index + 1) % mentionCandidates.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      if (!mentionCandidates.length) return;
                      setMentionIndex((index) => (
                        (index - 1 + mentionCandidates.length) % mentionCandidates.length
                      ));
                      return;
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      const picked = mentionCandidates[mentionIndex] || mentionCandidates[0];
                      if (picked) applyMention(picked);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeMention();
                    }
                  }}
                />
                {mentionCandidates.length === 0 ? (
                  <p className="agent-mention-empty">
                    {workflows.length === 0 ? '暂无录制，请先在工作流中录制' : '没有匹配的录制'}
                  </p>
                ) : (
                  <ul className="agent-mention-list">
                    {mentionCandidates.map((item, index) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === mentionIndex}
                          className={`agent-mention-option${index === mentionIndex ? ' is-active' : ''}${
                            item.id === mentionedWorkflow?.id ? ' is-current' : ''
                          }`}
                          onMouseEnter={() => setMentionIndex(index)}
                          onClick={() => applyMention(item)}
                        >
                          <strong>{item.name}</strong>
                          <span>{item.url || item.id}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {mentionedWorkflow ? (
              <div className="agent-mention-chip-row">
                <button
                  type="button"
                  className={`agent-mention-chip${mentionOpen ? ' is-open' : ''}`}
                  title={`${mentionedWorkflow.url || mentionedWorkflow.id} · 点击切换录制`}
                  disabled={busy}
                  aria-haspopup="listbox"
                  aria-expanded={mentionOpen}
                  onClick={() => {
                    if (mentionOpen) {
                      closeMention();
                      return;
                    }
                    openMentionPicker();
                  }}
                >
                  <em>@</em>
                  <strong>{mentionedWorkflow.name}</strong>
                  <i aria-hidden>▾</i>
                </button>
                <button
                  type="button"
                  className="agent-mention-chip-clear"
                  aria-label="取消选择录制"
                  disabled={busy || Boolean(workflowId && workflowId === mentionedWorkflow.id)}
                  title={workflowId && workflowId === mentionedWorkflow.id ? '当前来自已打开工作流' : '清除绑定'}
                  onClick={() => {
                    if (workflowId) {
                      setMentionedWorkflow({
                        id: workflowId,
                        name: workflowName || workflowId,
                      });
                    } else {
                      setMentionedWorkflow(null);
                    }
                    closeMention();
                  }}
                >
                  ×
                </button>
                <span className="agent-mention-hint">@ 切换录制 · Enter 发送 · Shift+Enter 换行</span>
              </div>
            ) : null}

            <textarea
              ref={textareaRef}
              value={draft}
              disabled={busy || !status?.hasApiKey}
              onChange={(e) => {
                handleDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onClick={(e) => {
                syncMentionFromDraft(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
              }}
              onKeyUp={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter' || e.key.startsWith('Arrow')) return;
                syncMentionFromDraft(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
              }}
              rows={2}
              placeholder={
                !status?.hasApiKey
                  ? '请先配置 API Key'
                  : messages.length === 0
                    ? (mentionedWorkflow
                      ? '输入分析 Prompt，Enter 发送 · Shift+Enter 换行'
                      : '输入 @ 选择录制，再填写 Prompt 发送分析')
                    : '继续追问，Enter 发送 · @ 可切换录制 · Shift+Enter 换行'
              }
              onKeyDown={handleComposerKeyDown}
            />
            <button type="submit" className="agent-send" disabled={busy || !draft.trim() || !status?.hasApiKey}>
              发送
            </button>
          </form>
        </footer>
      </div>

      {previewArtifact ? (
        <LocalArtifactPreview
          artifact={previewArtifact}
          onClose={() => setPreviewArtifact(null)}
          onOpenExternal={(targetPath) => {
            void window.agent.openLocalPath(targetPath).catch((err) => {
              setError(err instanceof Error ? err.message : '打开文件失败');
            });
          }}
          onReveal={(targetPath) => {
            void window.agent.revealLocalPath(targetPath).catch((err) => {
              setError(err instanceof Error ? err.message : '打开目录失败');
            });
          }}
        />
      ) : null}

      <FloatingNotice message={error} onClose={() => setError('')} />
    </section>
  );
}
