import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import http from 'http';
import path from 'path';
import { setLayout } from '../src/config/paths.js';
import { fsVaultOps } from '../src/vault/ops.js';
import { Store } from '../src/store/store.js';
import { McpHandler, startMcpServer, type RunningServer } from '../src/mcp/server.js';

const TOKEN = 'test-token-123';
const BOARD = `---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] Write intro\n\n## Doing\n\n- [ ] Ship MCP\n\n## Done\n\n`;

let vault: string;
let server: RunningServer;
let allowWrites: boolean;
let writes: string[];

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

function post(body: unknown, headers: Record<string, string> = {}, opts: { method?: string; auth?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: '/mcp', method: opts.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(opts.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (opts.method !== 'GET') req.write(data);
    req.end();
  });
}

const MODERN = '2026-07-28';
function modern(method: string, params: Record<string, unknown> = {}, id = 1) {
  return {
    body: {
      jsonrpc: '2.0', id, method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '3.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } },
    },
    headers: { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) },
  };
}
async function callModern(name: string, args: Record<string, unknown>) {
  const m = modern('tools/call', { name, arguments: args });
  return post(m.body, m.headers);
}

beforeEach(async () => {
  vault = mkdtempSync(path.join(tmpdir(), 'vault-mcp-'));
  setLayout({ boardPath: 'Board.md', agentFolder: 'agent', captureFolder: 'Synapses', notesFolder: 'Neurons', dailyFolder: 'Daily' });
  mkdirSync(path.join(vault, 'Neurons'), { recursive: true });
  mkdirSync(path.join(vault, 'Daily'), { recursive: true });
  mkdirSync(path.join(vault, 'agent'), { recursive: true });
  writeFileSync(path.join(vault, 'Board.md'), BOARD);
  writeFileSync(path.join(vault, 'Neurons', 'Maria Silva.md'), '---\ntags:\n  - people\naliases:\n  - Maria\n---\n# Maria Silva\n\n- Designer at Acme, loves kayaking\n');
  writeFileSync(path.join(vault, 'Daily', '2026-11-20.md'), 'private diary about kayaking\n');
  writeFileSync(path.join(vault, 'agent', 'user.md'), '# User\n\n- Name: Sam\n');
  writeFileSync(path.join(vault, 'agent', 'goals.md'), '# Goals\n\n- Launch Cortana\n');
  writeFileSync(path.join(vault, 'agent', 'memory.md'), '# Memory\n\n## Entries\n\n- [2026-11-01] Likes short answers\n');
  allowWrites = true;
  writes = [];
  const handler = new McpHandler({
    context: () => ({ vaultPath: vault, ops: fsVaultOps(vault), store: new Store(), onWrite: (client, s) => writes.push(`${client}: ${s}`) }),
    allowWrites: () => allowWrites,
    version: '0.0.0',
  });
  server = await startMcpServer(handler, 0, TOKEN);
});

afterEach(async () => {
  await server.close();
  rmSync(vault, { recursive: true, force: true });
});

describe('MCP server: who may connect', () => {
  it('needs the bearer token', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, { auth: false });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' }, { auth: false })).status).toBe(401);
  });

  it('refuses a foreign Host or Origin (DNS rebinding)', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Host: `evil.example:${server.port}` })).status).toBe(403);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: `http://localhost:${server.port}` })).status).toBe(200);
  });

  it('answers GET with 405 and notifications with 202', async () => {
    expect((await post('', {}, { method: 'GET' })).status).toBe(405);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('rejects malformed JSON', async () => {
    const r = await post('{not json');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32700);
  });
});

describe('MCP server: 2025 clients (initialize)', () => {
  it('negotiates a version, issues a session and names the client in what it files', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0' } } });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.serverInfo.name).toBe('cortana');
    const sid = init.headers['mcp-session-id'] as string;
    expect(sid).toBeTruthy();

    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capture_note', arguments: { title: 'Maria', text: 'starting a studio in Lisbon', type: 'people' } } }, { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-06-18' });
    expect(r.json.result.isError).toBe(false);
    const note = readFileSync(path.join(vault, 'Neurons', 'Maria Silva.md'), 'utf-8');
    expect(note).toContain('- Designer at Acme, loves kayaking');
    expect(note).toMatch(/## Timeline\n- \*\*\d{4}-\d{2}-\d{2}\*\* \| starting a studio in Lisbon \[Source: Claude Code\]/);
    expect(writes).toHaveLength(1);
  });

  it('offers the newest version it knows to an unknown one', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', clientInfo: { name: 'x' } } });
    expect(init.json.result.protocolVersion).toBe('2025-11-25');
  });
});

describe('MCP server: 2026-07-28 clients (stateless)', () => {
  it('answers server/discover', async () => {
    const m = modern('server/discover');
    const r = await post(m.body, m.headers);
    expect(r.status).toBe(200);
    expect(r.json.result.resultType).toBe('complete');
    expect(r.json.result.supportedVersions).toContain(MODERN);
    expect(r.json.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('cortana');
  });

  it('rejects headers that do not match the body', async () => {
    const m = modern('tools/call', { name: 'get_context', arguments: {} });
    const r = await post(m.body, { ...m.headers, 'Mcp-Name': 'remember' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it('rejects an unsupported version with the supported list', async () => {
    const m = modern('tools/list');
    m.body.params._meta['io.modelcontextprotocol/protocolVersion'] = '1900-01-01';
    const r = await post(m.body, { ...m.headers, 'MCP-Protocol-Version': '1900-01-01' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32022);
    expect(r.json.error.data.supported).toContain(MODERN);
  });

  it('returns 404 for an unknown method', async () => {
    const m = modern('resources/list');
    expect((await post(m.body, m.headers)).status).toBe(404);
  });
});

describe('MCP tools', () => {
  it('get_context has the profile, goals, memory and board, but not the daily notes', async () => {
    const r = await callModern('get_context', {});
    const text = r.json.result.content[0].text as string;
    expect(text).toContain('Name: Sam');
    expect(text).toContain('Launch Cortana');
    expect(text).toContain('Likes short answers');
    expect(text).toContain('Ship MCP');
    expect(text).not.toContain('private diary');
  });

  it('search_notes and read_note never reach the daily notes or the agent folder', async () => {
    const found = (await callModern('search_notes', { query: 'kayaking' })).json.result.content[0].text as string;
    expect(found).toContain('Maria Silva');
    expect(found).not.toContain('Daily');

    expect((await callModern('read_note', { note: 'Maria' })).json.result.content[0].text).toContain('Designer at Acme');
    for (const note of ['Daily/2026-11-20.md', '2026-11-20', 'agent/user.md', '../outside.md']) {
      const r = await callModern('read_note', { note });
      expect(r.json.result.isError).toBe(true);
    }
  });

  it('remember adds a dated memory entry with where it came from', async () => {
    await callModern('remember', { fact: 'Prefers calls after 4pm' });
    expect(readFileSync(path.join(vault, 'agent', 'memory.md'), 'utf-8')).toMatch(/## Entries\n+- \[\d{4}-\d{2}-\d{2}\] Prefers calls after 4pm \(via Claude Code\)\n+- \[2026-11-01\] Likes short answers/);
  });

  it('add_task and move_task go through the board writer; a missing card is an error', async () => {
    await callModern('add_task', { text: 'Record demo' });
    await callModern('move_task', { task: 'Write intro', from: 'To Do', to: 'Doing' });
    const board = readFileSync(path.join(vault, 'Board.md'), 'utf-8');
    expect(board).toMatch(/## To Do\n[\s\S]*- \[ \] Record demo[\s\S]*## Doing/);
    expect(board).toMatch(/## Doing\n[\s\S]*Write intro[\s\S]*## Done/);
    const r = await callModern('move_task', { task: 'Nope', from: 'To Do', to: 'Doing' });
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toContain("couldn't find");
  });

  it('a missing argument is a tool error, not a crash', async () => {
    const r = await callModern('capture_note', { title: 'X' });
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toContain('"text" is required');
  });

  it('read-only mode hides and refuses the write tools', async () => {
    allowWrites = false;
    const m = modern('tools/list');
    const names = (await post(m.body, m.headers)).json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['get_context', 'search_notes', 'read_note']);
    const r = await callModern('remember', { fact: 'x' });
    expect(r.json.error.code).toBe(-32602);
    expect(readFileSync(path.join(vault, 'agent', 'memory.md'), 'utf-8')).not.toContain('(via');
  });
});

describe('setup snippets', async () => {
  const { setupSnippet, SETUP_CLIENTS } = await import('../src/mcp/setup.js');
  it('every client gets the URL and the token', () => {
    for (const c of Object.keys(SETUP_CLIENTS) as (keyof typeof SETUP_CLIENTS)[]) {
      const text = setupSnippet(c, 'http://127.0.0.1:27150/mcp', 'tok');
      expect(text).toContain('http://127.0.0.1:27150/mcp');
      expect(text).toContain('Bearer tok');
    }
  });
  it('JSON snippets parse', () => {
    for (const c of ['cursor', 'claude-desktop', 'openclaw'] as const) expect(() => JSON.parse(setupSnippet(c, 'u', 't'))).not.toThrow();
  });
});

describe('add_task to a missing column', () => {
  it('is an error, not a false "Added"', async () => {
    const r = await callModern('add_task', { text: 'Ghost', column: 'Nope' });
    expect(r.json.result.isError).toBe(true);
    expect(readFileSync(path.join(vault, 'Board.md'), 'utf-8')).not.toContain('Ghost');
  });
});
