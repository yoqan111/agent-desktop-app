import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { callTool, listAgentTools } from './tools';

const PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
const DEFAULT_PORT = 47321;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

let server: Server | undefined;
const sseClients = new Set<ServerResponse>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('请求过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin || origin === 'null') {
    return true;
  }
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowOrigin = origin && originAllowed(origin) ? origin : 'http://127.0.0.1';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(origin),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function wantsEventStream(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/event-stream');
}

function writeSseMessage(res: ServerResponse, payload: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function openSseStream(req: IncomingMessage, res: ServerResponse): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  res.writeHead(200, {
    ...corsHeaders(origin),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers / comment so Cursor's streamable-http client sees a live SSE stream.
  res.write(': mediado-mcp connected\n\n');
  sseClients.add(res);

  const ping = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(ping);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(ping);
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handleRpc(message: JsonRpcRequest): Promise<unknown> {
  const method = message.method;
  const params = (message.params && typeof message.params === 'object')
    ? message.params as Record<string, unknown>
    : {};

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0];
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'mediado',
        version: app.getVersion(),
        description: 'MediaDo media tools + Playwright Studio (record / play / manage workflows)',
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return {};
  }
  if (method === 'ping') {
    return {};
  }
  if (method === 'tools/list') {
    return { tools: listAgentTools() };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    try {
      const result = await callTool(name, params.arguments ?? {}, { source: 'agent' });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: false,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : '工具执行失败。';
      return {
        content: [{ type: 'text', text }],
        isError: true,
      };
    }
  }
  throw Object.assign(new Error(`不支持的方法：${method || ''}`), { code: -32601 });
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!originAllowed(origin)) {
    sendJson(res, 403, { error: 'forbidden' }, origin);
    return;
  }

  const pathname = (req.url || '').split('?')[0];
  if (pathname !== '/mcp') {
    sendJson(res, 404, { error: 'not_found' }, origin);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  // Streamable HTTP: Cursor opens an SSE stream via GET before posting RPCs.
  if (req.method === 'GET') {
    if (!wantsEventStream(req) && String(req.headers.accept || '').includes('application/json')) {
      sendJson(res, 200, {
        ok: true,
        name: 'mediado',
        transport: 'streamable-http',
        message: 'POST JSON-RPC to this endpoint; GET with Accept: text/event-stream for SSE.',
      }, origin);
      return;
    }
    openSseStream(req, res);
    return;
  }

  if (req.method === 'DELETE') {
    // Session teardown — nothing sticky to clear in this lightweight server.
    res.writeHead(200, corsHeaders(origin));
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' }, origin);
    return;
  }

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(await readBody(req)) as JsonRpcRequest;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 无法解析。' } }, origin);
    return;
  }

  // Notifications (no id) — accept and return 202.
  if (message.id == null) {
    if (message.method) {
      try {
        await handleRpc(message);
      } catch {
        // ignore notification errors
      }
    }
    res.writeHead(202, corsHeaders(origin));
    res.end();
    return;
  }

  try {
    const result = await handleRpc(message);
    const response = { jsonrpc: '2.0', id: message.id, result };

    // If client prefers SSE, reply as a single SSE message (Streamable HTTP).
    if (wantsEventStream(req) && !String(req.headers.accept || '').includes('application/json')) {
      res.writeHead(200, {
        ...corsHeaders(origin),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      writeSseMessage(res, response);
      res.end();
      return;
    }

    sendJson(res, 200, response, origin);
  } catch (error) {
    const coded = error as { code?: number; message?: string };
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: coded.code ?? -32603, message: coded.message || '内部错误。' },
    }, origin);
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const next = createServer((req, res) => {
      void onRequest(req, res);
    });
    next.once('error', reject);
    next.listen(port, '127.0.0.1', () => {
      next.removeListener('error', reject);
      resolve(next);
    });
  });
}

export async function startMcpServer(): Promise<string> {
  const preferred = Number(process.env.MEDIA_STUDIO_MCP_PORT) || DEFAULT_PORT;
  let lastError: unknown;
  for (let port = preferred; port < preferred + 10; port += 1) {
    try {
      server = await listen(port);
      const url = `http://127.0.0.1:${port}/mcp`;
      const descriptor = path.join(app.getPath('userData'), 'mcp.json');
      writeFileSync(descriptor, JSON.stringify({
        url,
        name: 'MediaDo',
        type: 'streamable-http',
        tools: ['media_*', 'playwright_*'],
      }, null, 2));
      console.log(`MediaDo MCP ${url}`);
      return url;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MCP 服务启动失败。');
}

export function stopMcpServer(): void {
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  sseClients.clear();
  server?.close();
  server = undefined;
}
