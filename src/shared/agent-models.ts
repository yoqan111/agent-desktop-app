import type { AgentModelInfo, AgentModelParam } from './agent';

/** Build a stable select value for id + optional params. */
export function agentModelKey(model: Pick<AgentModelInfo, 'id' | 'params'>): string {
  if (!model.params?.length) return model.id;
  const encoded = model.params
    .map((item) => `${item.id}=${item.value}`)
    .sort()
    .join('&');
  return `${model.id}?${encoded}`;
}

export function parseAgentModelKey(key: string): { id: string; params?: AgentModelParam[] } {
  const q = key.indexOf('?');
  if (q < 0) return { id: key };
  const id = key.slice(0, q);
  const params = key
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return { id: part, value: '' };
      return { id: part.slice(0, eq), value: decodeURIComponent(part.slice(eq + 1)) };
    });
  return { id, params };
}

/**
 * Curated catalog aligned with Cursor IDE / docs / SDK common IDs.
 * API list is merged on top; unavailable IDs may fail at create-time depending on plan.
 */
export const AGENT_CURATED_MODELS: AgentModelInfo[] = [
  { id: 'auto', displayName: 'Auto', description: 'Cursor 自动路由', group: 'Cursor' },
  { id: 'auto-smart', displayName: 'Auto (Smart)', description: '智能路由', group: 'Cursor' },
  { id: 'default', displayName: 'Default', description: '账户默认', group: 'Cursor' },

  { id: 'composer-2.5', displayName: 'Composer 2.5', description: 'Cursor 编程代理默认', group: 'Cursor' },
  { id: 'composer-2', displayName: 'Composer 2', group: 'Cursor' },
  { id: 'composer-1.5', displayName: 'Composer 1.5', group: 'Cursor' },

  { id: 'grok-4.7', displayName: 'Grok 4.7', description: 'Cursor 旗舰', group: 'Cursor' },
  { id: 'grok-4.6', displayName: 'Grok 4.6', group: 'Cursor' },
  { id: 'grok-4.5', displayName: 'Grok 4.5', group: 'Cursor' },
  { id: 'grok-4-20', displayName: 'Grok 4.20', group: 'Cursor' },

  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', group: 'Anthropic' },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', group: 'Anthropic' },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', group: 'Anthropic' },
  { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', group: 'Anthropic' },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', group: 'Anthropic' },
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', group: 'Anthropic' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', group: 'Anthropic' },
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', group: 'Anthropic' },
  { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', group: 'Anthropic' },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', group: 'Anthropic' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', group: 'Anthropic' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', group: 'Anthropic' },
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', group: 'Anthropic' },
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', group: 'Anthropic' },

  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', group: 'OpenAI' },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', group: 'OpenAI' },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', group: 'OpenAI' },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', group: 'OpenAI' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', group: 'OpenAI' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', group: 'OpenAI' },
  { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', group: 'OpenAI' },
  { id: 'gpt-5.3-codex', displayName: 'Codex 5.3', group: 'OpenAI' },
  { id: 'gpt-5.3-codex-spark', displayName: 'Codex 5.3 Spark', group: 'OpenAI' },
  { id: 'gpt-5.2', displayName: 'GPT-5.2', group: 'OpenAI' },
  { id: 'gpt-5.2-codex', displayName: 'Codex 5.2', group: 'OpenAI' },
  { id: 'gpt-5.1', displayName: 'GPT-5.1', group: 'OpenAI' },
  { id: 'gpt-5.1-codex-max', displayName: 'Codex 5.1 Max', group: 'OpenAI' },
  { id: 'gpt-5.1-codex-mini', displayName: 'Codex 5.1 Mini', group: 'OpenAI' },
  { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', group: 'OpenAI' },

  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', group: 'Google' },
  { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', group: 'Google' },
  { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', group: 'Google' },
  { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', group: 'Google' },
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', group: 'Google' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', group: 'Google' },

  { id: 'kimi-k3', displayName: 'Kimi K3', group: 'Other' },
  { id: 'kimi-k2.5', displayName: 'Kimi K2.5', group: 'Other' },
  { id: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', group: 'Other' },
];

/** Presets shown when provider = openai-compatible (plus user customModels). */
export const OPENAI_COMPAT_PRESET_MODELS: AgentModelInfo[] = [
  { id: 'gpt-4o', displayName: 'GPT-4o', description: 'OpenAI', group: 'OpenAI Compatible' },
  { id: 'gpt-4.1', displayName: 'GPT-4.1', description: 'OpenAI', group: 'OpenAI Compatible' },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', description: 'OpenAI', group: 'OpenAI Compatible' },
  { id: 'o4-mini', displayName: 'o4-mini', description: 'OpenAI', group: 'OpenAI Compatible' },
  { id: 'deepseek-chat', displayName: 'DeepSeek Chat', description: 'DeepSeek', group: 'OpenAI Compatible' },
  { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', description: 'DeepSeek', group: 'OpenAI Compatible' },
  { id: 'qwen-plus', displayName: 'Qwen Plus', description: '通义兼容模式', group: 'OpenAI Compatible' },
  { id: 'qwen-max', displayName: 'Qwen Max', description: '通义兼容模式', group: 'OpenAI Compatible' },
  { id: 'qwen3-max', displayName: 'Qwen3 Max', description: '通义兼容模式', group: 'OpenAI Compatible' },
  { id: 'moonshot-v1-auto', displayName: 'Kimi Auto', description: 'Moonshot', group: 'OpenAI Compatible' },
  { id: 'kimi-k2.5', displayName: 'Kimi K2.5', description: 'Moonshot', group: 'OpenAI Compatible' },
];

const GROUP_ORDER = ['自定义', 'OpenAI Compatible', 'Cursor', 'Anthropic', 'OpenAI', 'Google', 'Other'];

export function sortAgentModels(models: AgentModelInfo[]): AgentModelInfo[] {
  return [...models].sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group || 'Other');
    const gb = GROUP_ORDER.indexOf(b.group || 'Other');
    const g = (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    if (g !== 0) return g;
    return (a.displayName || a.id).localeCompare(b.displayName || b.id, 'en');
  });
}

export function guessModelGroup(id: string): string {
  if (id.startsWith('claude') || id.includes('fable')) return 'Anthropic';
  if (id.startsWith('gpt') || id.includes('codex')) return 'OpenAI';
  if (id.startsWith('gemini')) return 'Google';
  if (id.startsWith('composer') || id.startsWith('grok') || id === 'auto' || id === 'auto-smart' || id === 'default') {
    return 'Cursor';
  }
  return 'Other';
}

/** Merge curated catalog with live API/SDK items (API wins on same key). */
export function mergeAgentModels(
  curated: AgentModelInfo[],
  live: AgentModelInfo[],
): AgentModelInfo[] {
  const map = new Map<string, AgentModelInfo>();
  for (const item of curated) {
    const key = agentModelKey(item);
    map.set(key, { ...item, key });
  }
  for (const item of live) {
    const key = agentModelKey(item);
    const prev = map.get(key);
    map.set(key, {
      ...prev,
      ...item,
      key,
      group: item.group || prev?.group || guessModelGroup(item.id),
      displayName: item.displayName || prev?.displayName || item.id,
      description: item.description || prev?.description,
    });
  }
  return sortAgentModels([...map.values()]);
}
