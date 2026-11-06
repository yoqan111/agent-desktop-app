import { callTool, listAgentTools } from '../../../platform/tools';

const MAX_TOOL_ROUNDS = 8;

export interface OpenAICompatRunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTool?: (name: string, detail?: string) => void;
}

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
    role: 'assistant';
    content: string | null;
    tool_calls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }
  | { role: 'tool'; tool_call_id: string; content: string };

interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamResult {
  content: string;
  toolCalls: StreamToolCall[];
  finishReason?: string;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  return trimmed || 'https://api.openai.com/v1';
}

function toOpenAITools() {
  return listAgentTools().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

function summarizeArgs(raw: string, max = 180): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return json.error?.message || json.message || text.slice(0, 400);
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function streamChatCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: ReturnType<typeof toOpenAITools>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}): Promise<StreamResult> {
  const url = `${normalizeBaseUrl(input.baseUrl)}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream: true,
      tools: input.tools.length ? input.tools : undefined,
      tool_choice: input.tools.length ? 'auto' : undefined,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  if (!response.body) {
    throw new Error('模型接口未返回流式响应。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | undefined;
  const toolCallMap = new Map<number, StreamToolCall>();

  const consumeData = (payload: string) => {
    if (!payload || payload === '[DONE]') return;
    let json: {
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      input.onDelta?.(delta.content);
    }
    for (const part of delta.tool_calls || []) {
      const index = typeof part.index === 'number' ? part.index : 0;
      const current = toolCallMap.get(index) || { id: '', name: '', arguments: '' };
      if (part.id) current.id = part.id;
      if (part.function?.name) current.name += part.function.name;
      if (part.function?.arguments) current.arguments += part.function.arguments;
      toolCallMap.set(index, current);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n');
    buffer = chunks.pop() || '';
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('data:')) {
        consumeData(trimmed.slice(5).trim());
      }
    }
  }
  if (buffer.trim().startsWith('data:')) {
    consumeData(buffer.trim().slice(5).trim());
  }

  const toolCalls = [...toolCallMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => ({
      id: item.id || `tool_${Math.random().toString(36).slice(2, 10)}`,
      name: item.name,
      arguments: item.arguments || '{}',
    }))
    .filter((item) => item.name);

  return { content, toolCalls, finishReason };
}

const DEFAULT_SYSTEM = [
  '你是 MediaDo 桌面端的分析助手。',
  '可通过 function tools 调用 Playwright Studio / 媒体能力。',
  '优先基于用户给出的上下文作答；确有必要时再调用工具。',
  '使用简洁的中文 Markdown 回复。',
].join('\n');

/** Run an OpenAI-compatible chat/completions agent loop with local MediaDo tools. */
export async function runOpenAICompatibleAgent(options: OpenAICompatRunOptions): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error('请先配置 API Key。');
  }
  const model = options.model.trim();
  if (!model) {
    throw new Error('请先选择模型。');
  }

  const tools = toOpenAITools();
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt || DEFAULT_SYSTEM },
    { role: 'user', content: options.prompt },
  ];

  let finalText = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (options.signal?.aborted) {
      throw new Error('已取消');
    }
    const result = await streamChatCompletion({
      baseUrl: options.baseUrl,
      apiKey,
      model,
      messages,
      tools,
      signal: options.signal,
      onDelta: options.onDelta,
    });

    if (!result.toolCalls.length) {
      finalText = result.content;
      break;
    }

    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((item) => ({
        id: item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      })),
    });

    for (const call of result.toolCalls) {
      options.onTool?.(call.name, summarizeArgs(call.arguments) || '调用工具');
      let toolResult: unknown;
      try {
        let args: unknown = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          args = { raw: call.arguments };
        }
        toolResult = await callTool(call.name, args, { source: 'agent' });
      } catch (error) {
        toolResult = {
          error: error instanceof Error ? error.message : '工具调用失败',
        };
      }
      let content: string;
      try {
        content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
      } catch {
        content = String(toolResult);
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: content.slice(0, 40_000),
      });
    }
  }

  if (!finalText && messages.length) {
    // Last assistant text content if loop exhausted on tools.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
        finalText = msg.content;
        break;
      }
    }
  }

  return finalText;
}
