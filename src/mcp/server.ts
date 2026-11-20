// mcp/server.ts - a small MCP server (Streamable HTTP, JSON responses) that lets
// other AIs on this computer use the vault through Cortana's tools.
//
// It listens on 127.0.0.1 only and needs the bearer token from the settings. It
// also refuses requests whose Host or Origin is not local, so a web page cannot
// reach it through DNS rebinding. No SDK: the server needs only a handful of
// methods, answered as plain JSON.
//
// Two eras of the protocol are served. Clients from 2025 open with `initialize`
// and may keep a session id. Clients on 2026-07-28 send no handshake: every
// request carries the version and client info in `_meta`, mirrored in the
// MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, and `server/discover`
// replaces `initialize`.

import http from 'http';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { listTools, TOOLS, ToolError, type ToolContext } from './tools.js';
import { createLogger } from '../utils/logger.js';
import type { JsonObject } from '../utils/json.js';

const logger = createLogger('mcp');

/** Stateless revisions, where each request says its version in `_meta`. */
export const MODERN_VERSIONS = ['2026-07-28'];
/** Revisions with an `initialize` handshake, newest first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';
const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS = 50;

export const SERVER_INSTRUCTIONS = 'This is the user\'s Obsidian vault, kept by their assistant Cortana. Call get_context at the start of a conversation to learn who the user is, their goals and what they are working on. File what the user tells you about people, projects and decisions with capture_note.';

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
}

/** The MCP headers of one HTTP request. */
export interface McpHeaders {
  sessionId?: string;
  protocolVersion?: string;
  method?: string;
  name?: string;
}

export interface McpAnswer {
  /** The JSON-RPC response, or null for a notification (HTTP 202). */
  body: JsonObject | null;
  /** HTTP status when it is not 200 (version and header errors). */
  status?: number;
  /** A new legacy session, sent back as Mcp-Session-Id. */
  sessionId?: string;
}

export interface McpOptions {
  /** Shared by every connected AI; `client` is filled in per session. */
  context: () => Omit<ToolContext, 'client'>;
  allowWrites: () => boolean;
  version: string;
}

/** The JSON-RPC side, independent of HTTP. Sessions only remember the client's name. */
export class McpHandler {
  private sessions = new Map<string, string>();

  constructor(private readonly opts: McpOptions) {}

  /** Answers one JSON-RPC message. */
  async handle(msg: unknown, headers: McpHeaders = {}): Promise<McpAnswer> {
    const req = msg as RpcRequest;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') return { body: rpcError(null, -32600, 'Invalid request'), status: 400 };
    if (typeof req.method !== 'string' || req.id === undefined) return { body: null };
    const id = req.id;
    const params = req.params && typeof req.params === 'object' ? req.params : {};
    const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as JsonObject;
    const version = typeof meta[META_VERSION] === 'string' ? meta[META_VERSION] : '';
    const modern = Boolean(version) && req.method !== 'initialize';

    if (modern) {
      if (!MODERN_VERSIONS.includes(version) && !LEGACY_VERSIONS.includes(version)) {
        return { status: 400, body: rpcError(id, -32022, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version }) };
      }
      const mismatch = headerMismatch(req.method, params, version, headers);
      if (mismatch) return { status: 400, body: rpcError(id, -32020, `Header mismatch: ${mismatch}`) };
    }
    const done = (result: JsonObject): McpAnswer => ({ body: rpcResult(id, modern ? { resultType: 'complete', ...result } : result) });
    const client = modern
      ? clientName((meta[META_CLIENT] ?? {}) as JsonObject)
      : (headers.sessionId && this.sessions.get(headers.sessionId)) || 'another AI';

    switch (req.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const name = clientName((params.clientInfo ?? {}) as JsonObject);
        const sid = randomUUID();
        if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
        this.sessions.set(sid, name);
        logger.info(`${name} connected`);
        return {
          sessionId: sid,
          body: rpcResult(id, {
            protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo(),
            instructions: SERVER_INSTRUCTIONS,
          }),
        };
      }
      case 'server/discover':
        return done({
          supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          capabilities: { tools: {} },
          instructions: SERVER_INSTRUCTIONS,
          _meta: { 'io.modelcontextprotocol/serverInfo': this.serverInfo() },
        });
      case 'ping':
        return done({});
      case 'tools/list':
        return done({ tools: listTools(this.opts.allowWrites()) });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = TOOLS.find(t => t.name === name && (this.opts.allowWrites() || !t.writes));
        if (!tool) return { body: rpcError(id, -32602, `Unknown tool: ${name}`) };
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as JsonObject : {};
        try {
          const text = await tool.run(args, { ...this.opts.context(), client });
          return done({ content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          if (!(err instanceof ToolError)) logger.error(`${name} failed`, err);
          const text = err instanceof ToolError ? err.message : `Something went wrong: ${(err as Error).message}`;
          return done({ content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        return { body: rpcError(id, -32601, `Method not found: ${req.method}`), ...(modern ? { status: 404 } : {}) };
    }
  }

  private serverInfo(): JsonObject {
    return { name: 'cortana', title: 'Cortana', version: this.opts.version };
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** The client's own name, cleaned for use as a note source: "Claude Code", "codex-mcp-client". */
function clientName(info: JsonObject): string {
  const raw = typeof info.title === 'string' && info.title ? info.title : typeof info.name === 'string' ? info.name : '';
  const known: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-mcp-client': 'Codex', 'cursor-vscode': 'Cursor', 'gemini-cli-mcp-client': 'Gemini CLI' };
  const name = known[raw] ?? raw;
  return name.replace(/[[\]\n\r|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'another AI';
}

/** 2026-07-28: the headers must repeat the body's version, method and tool name. */
function headerMismatch(method: string, params: JsonObject, version: string, h: McpHeaders): string {
  if (h.protocolVersion !== version) return `MCP-Protocol-Version header "${h.protocolVersion ?? ''}" does not match "${version}"`;
  if (h.method !== method) return `Mcp-Method header "${h.method ?? ''}" does not match "${method}"`;
  if (method === 'tools/call' && h.name !== params.name) return `Mcp-Name header "${h.name ?? ''}" does not match "${String(params.name)}"`;
  return '';
}

function rpcResult(id: RpcRequest['id'], result: JsonObject): JsonObject {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcRequest['id'], code: number, message: string, data?: JsonObject): JsonObject {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only this computer: the Host must be the loopback address, and a browser Origin too. */
function isLocal(req: http.IncomingMessage, port: number): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  return !origin || hosts.some(h => origin === `http://${h}`);
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Starts listening on 127.0.0.1. Rejects if the port is taken. */
export function startMcpServer(handler: McpHandler, port: number, token: string): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body?: JsonObject | string, headers: Record<string, string> = {}) => {
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { ...(typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}), ...headers });
      res.end(text);
    };
    const actual = (server.address() as { port: number } | null)?.port ?? port;
    if (!isLocal(req, actual)) return send(403, 'Forbidden');
    if ((req.url ?? '').split('?')[0] !== '/mcp') return send(404, 'Not found');
    const auth = req.headers.authorization ?? '';
    if (!sameToken(auth.replace(/^Bearer\s+/i, ''), token)) return send(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });

    const header = (name: string) => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : undefined;
    };
    const mcpHeaders: McpHeaders = {
      sessionId: header('mcp-session-id'),
      protocolVersion: header('mcp-protocol-version'),
      method: header('mcp-method'),
      name: header('mcp-name'),
    };
    const sessionId = mcpHeaders.sessionId;
    if (req.method === 'DELETE' && sessionId) {
      handler.endSession(sessionId);
      return send(200);
    }
    if (req.method !== 'POST') return send(405, 'Method not allowed', { Allow: 'POST, DELETE' });

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, 'Too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let msg: unknown;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return send(400, rpcError(null, -32700, 'Parse error'));
      }
      void (async () => {
        // Batches (2025-03-26) are answered as an array; newer clients send one message.
        const messages = Array.isArray(msg) ? msg : [msg];
        const answers = await Promise.all(messages.map(m => handler.handle(m, mcpHeaders)));
        const bodies = answers.map(a => a.body).filter((b): b is JsonObject => b !== null);
        const newSession = answers.find(a => a.sessionId)?.sessionId;
        const headers = newSession ? { 'Mcp-Session-Id': newSession } : undefined;
        if (!bodies.length) return send(202, undefined, headers);
        if (!Array.isArray(msg)) return send(answers[0].status ?? 200, bodies[0], headers);
        send(200, JSON.stringify(bodies), { 'Content-Type': 'application/json', ...headers });
      })().catch(err => {
        logger.error('Request failed', err);
        if (!res.writableEnded) send(500, rpcError(null, -32603, 'Internal error'));
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const actual = (server.address() as { port: number }).port;
      resolve({
        port: actual,
        close: () => new Promise(done => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}
