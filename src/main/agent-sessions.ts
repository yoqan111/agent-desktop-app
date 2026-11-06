import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  AgentChatMessage,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentCreateSessionRequest,
  AgentUpdateSessionRequest,
} from '../shared/agent';

interface SessionIndex {
  activeId: string | null;
  order: string[];
  /** Cached sidebar rows — avoids parsing full message payloads on list. */
  summaries?: Record<string, AgentChatSessionSummary>;
}

function sessionsRoot(): string {
  const dir = path.join(app.getPath('userData'), 'agent', 'sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(): string {
  return path.join(sessionsRoot(), 'index.json');
}

function sessionFile(id: string): string {
  return path.join(sessionsRoot(), `${id}.json`);
}

function readIndex(): SessionIndex {
  const file = indexPath();
  if (!existsSync(file)) {
    return { activeId: null, order: [], summaries: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as SessionIndex;
    return {
      activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
      order: Array.isArray(raw.order) ? raw.order.filter((id) => typeof id === 'string') : [],
      summaries: raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : {},
    };
  } catch {
    return { activeId: null, order: [], summaries: {} };
  }
}

function writeIndex(index: SessionIndex): void {
  const payload: SessionIndex = {
    activeId: index.activeId,
    order: index.order,
    summaries: index.summaries || {},
  };
  const tmp = `${indexPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, indexPath());
}

function summarize(session: AgentChatSession): AgentChatSessionSummary {
  const messages = session.messages || [];
  let preview = '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role === 'assistant' || item.role === 'user') {
      preview = (item.content || '').slice(0, 120);
      break;
    }
  }
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workflowId: session.workflowId ?? null,
    workflowName: session.workflowName ?? null,
    messageCount: messages.length,
    preview,
  };
}

function defaultTitle(workflowName?: string | null): string {
  const stamp = new Date().toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return workflowName?.trim() ? `${workflowName.trim()} · ${stamp}` : `新会话 · ${stamp}`;
}

function putSummary(summary: AgentChatSessionSummary, bump = true): void {
  const index = readIndex();
  const summaries = { ...(index.summaries || {}) };
  summaries[summary.id] = summary;
  let order = index.order.slice();
  const at = order.indexOf(summary.id);
  if (at < 0) {
    order = [summary.id, ...order];
  } else if (bump) {
    order.splice(at, 1);
    order = [summary.id, ...order];
  }
  writeIndex({
    activeId: index.activeId || summary.id,
    order,
    summaries,
  });
}

export function readSession(id: string): AgentChatSession | null {
  const file = sessionFile(id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as AgentChatSession;
    if (!raw?.id || !Array.isArray(raw.messages)) return null;
    return {
      id: raw.id,
      title: raw.title || '未命名会话',
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
      workflowId: raw.workflowId ?? null,
      workflowName: raw.workflowName ?? null,
      messages: raw.messages,
    };
  } catch {
    return null;
  }
}

export function writeSession(
  session: AgentChatSession,
  options?: { bump?: boolean },
): AgentChatSession {
  const next: AgentChatSession = {
    ...session,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${sessionFile(session.id)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, sessionFile(session.id));
  putSummary(summarize(next), options?.bump !== false);
  return next;
}

function rebuildSummaries(index: SessionIndex): SessionIndex {
  const summaries: Record<string, AgentChatSessionSummary> = {};
  const order: string[] = [];
  const seen = new Set<string>();

  const consider = (id: string) => {
    if (seen.has(id)) return;
    const session = readSession(id);
    if (!session) return;
    seen.add(id);
    summaries[id] = summarize(session);
    order.push(id);
  };

  for (const id of index.order) {
    consider(id);
  }
  for (const name of readdirSync(sessionsRoot())) {
    if (!name.endsWith('.json') || name === 'index.json' || name.endsWith('.tmp')) continue;
    consider(name.slice(0, -5));
  }

  order.sort((a, b) => (summaries[b]?.updatedAt || '').localeCompare(summaries[a]?.updatedAt || ''));
  const activeId = index.activeId && summaries[index.activeId]
    ? index.activeId
    : (order[0] || null);
  const next = { activeId, order, summaries };
  writeIndex(next);
  return next;
}

export function listChatSessions(): AgentChatSessionSummary[] {
  let index = readIndex();
  const summaries = index.summaries || {};
  const missing = index.order.some((id) => !summaries[id]) || Object.keys(summaries).length === 0;

  // Cheap orphan check: new files not in order.
  let hasOrphan = false;
  if (!missing) {
    for (const name of readdirSync(sessionsRoot())) {
      if (!name.endsWith('.json') || name === 'index.json' || name.endsWith('.tmp')) continue;
      const id = name.slice(0, -5);
      if (!summaries[id]) {
        hasOrphan = true;
        break;
      }
    }
  }

  if (missing || hasOrphan) {
    index = rebuildSummaries(index);
  }

  const map = index.summaries || {};
  return (index.order.length ? index.order : Object.keys(map))
    .map((id) => map[id])
    .filter((item): item is AgentChatSessionSummary => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getActiveChatSessionId(): string | null {
  return readIndex().activeId;
}

export function setActiveChatSessionId(id: string | null): void {
  const index = readIndex();
  if (index.activeId === id) return;
  index.activeId = id;
  writeIndex(index);
}

export function createChatSession(request: AgentCreateSessionRequest = {}): AgentChatSession {
  const now = new Date().toISOString();
  const session: AgentChatSession = {
    id: randomUUID(),
    title: request.title?.trim() || defaultTitle(request.workflowName),
    createdAt: now,
    updatedAt: now,
    workflowId: request.workflowId ?? null,
    workflowName: request.workflowName ?? null,
    messages: [],
  };
  writeSession(session);
  setActiveChatSessionId(session.id);
  return session;
}

export function ensureActiveChatSession(meta?: {
  workflowId?: string | null;
  workflowName?: string | null;
}): AgentChatSession {
  const activeId = getActiveChatSessionId();
  if (activeId) {
    const existing = readSession(activeId);
    if (existing) {
      let dirty = false;
      if (meta?.workflowId && existing.workflowId !== meta.workflowId) {
        existing.workflowId = meta.workflowId;
        dirty = true;
      }
      if (meta?.workflowName && existing.workflowName !== meta.workflowName) {
        existing.workflowName = meta.workflowName;
        dirty = true;
      }
      return dirty ? writeSession(existing) : existing;
    }
  }
  return createChatSession({
    workflowId: meta?.workflowId ?? null,
    workflowName: meta?.workflowName ?? null,
  });
}

export function updateChatSession(request: AgentUpdateSessionRequest): AgentChatSession {
  const session = readSession(request.id);
  if (!session) {
    throw new Error('会话不存在。');
  }
  if (typeof request.title === 'string') {
    const title = request.title.trim();
    if (!title) throw new Error('标题不能为空。');
    session.title = title;
  }
  if (request.workflowId !== undefined) {
    session.workflowId = request.workflowId;
  }
  if (request.workflowName !== undefined) {
    session.workflowName = request.workflowName;
  }
  return writeSession(session);
}

export function deleteChatSession(id: string): { activeId: string | null } {
  const file = sessionFile(id);
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
  const index = readIndex();
  const summaries = { ...(index.summaries || {}) };
  delete summaries[id];
  const order = index.order.filter((item) => item !== id);
  let activeId = index.activeId === id ? (order[0] || null) : index.activeId;
  writeIndex({ activeId, order, summaries });
  if (!activeId) {
    const created = createChatSession();
    return { activeId: created.id };
  }
  return { activeId };
}

export function clearChatSessionMessages(id: string): AgentChatSession {
  const session = readSession(id);
  if (!session) {
    throw new Error('会话不存在。');
  }
  session.messages = [];
  return writeSession(session);
}

/** Remove one or more messages from a chat session by id. */
export function deleteChatMessages(sessionId: string, messageIds: string[]): AgentChatSession {
  const session = readSession(sessionId);
  if (!session) {
    throw new Error('会话不存在。');
  }
  const remove = new Set(messageIds.filter((id) => typeof id === 'string' && id.trim()));
  if (!remove.size) {
    throw new Error('未指定要删除的消息。');
  }
  const next = session.messages.filter((item) => !remove.has(item.id));
  if (next.length === session.messages.length) {
    throw new Error('消息不存在或已删除。');
  }
  session.messages = next;
  return writeSession(session);
}

export function appendChatMessage(sessionId: string, message: AgentChatMessage): AgentChatSession {
  const session = readSession(sessionId) || ensureActiveChatSession();
  const targetId = session.id === sessionId ? sessionId : session.id;
  const current = readSession(targetId) || session;
  current.messages = [...current.messages, message];
  if (current.title.startsWith('新会话') && message.role === 'user') {
    current.title = message.content.replace(/\s+/g, ' ').slice(0, 36) || current.title;
  }
  return writeSession(current);
}

export function upsertChatMessage(sessionId: string, message: AgentChatMessage): AgentChatSession {
  const session = readSession(sessionId) || ensureActiveChatSession();
  const index = session.messages.findIndex((item) => item.id === message.id);
  if (index < 0) {
    session.messages = [...session.messages, message];
  } else {
    const copy = [...session.messages];
    copy[index] = { ...copy[index], ...message };
    session.messages = copy;
  }
  // Streaming upserts should not reshuffle the sidebar on every tick.
  return writeSession(session, { bump: message.role !== 'assistant' });
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: { sessionId: string; message: AgentChatMessage } | null = null;

/** Debounced upsert for streaming assistant deltas. */
export function scheduleUpsertChatMessage(sessionId: string, message: AgentChatMessage): void {
  pendingPersist = { sessionId, message };
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const pending = pendingPersist;
    pendingPersist = null;
    if (pending) {
      upsertChatMessage(pending.sessionId, pending.message);
    }
  }, 280);
}

export function flushChatMessagePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const pending = pendingPersist;
  pendingPersist = null;
  if (pending) {
    upsertChatMessage(pending.sessionId, pending.message);
  }
}
