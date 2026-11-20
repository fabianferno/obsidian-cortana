// mcp/setup.ts - how each AI app connects to Cortana's MCP server, as text to paste.
//
// Only apps that run on this computer can reach 127.0.0.1. Web apps (claude.ai,
// ChatGPT, grok.com) call MCP servers from their own cloud and would need a public
// tunnel, which Cortana does not set up.

export const SETUP_CLIENTS = {
  'claude-code': 'Claude Code (terminal command)',
  codex: 'Codex (~/.codex/config.toml)',
  cursor: 'Cursor (~/.cursor/mcp.json)',
  gemini: 'Gemini CLI (terminal command)',
  'claude-desktop': 'Claude Desktop (claude_desktop_config.json, needs Node)',
  openclaw: 'OpenClaw (mcp config)',
} as const;

export type SetupClient = keyof typeof SETUP_CLIENTS;

export function setupSnippet(client: SetupClient, url: string, token: string): string {
  const auth = `Bearer ${token}`;
  switch (client) {
    case 'claude-code':
      return `claude mcp add --scope user --transport http cortana ${url} --header "Authorization: ${auth}"`;
    case 'codex':
      return `[mcp_servers.cortana]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${auth}" }`;
    case 'cursor':
      return JSON.stringify({ mcpServers: { cortana: { url, headers: { Authorization: auth } } } }, null, 2);
    case 'gemini':
      return `gemini mcp add --scope user --transport http --header "Authorization: ${auth}" cortana ${url}`;
    case 'claude-desktop':
      // Its config file runs local commands only; mcp-remote bridges to the HTTP server.
      // The header goes through an env var because args with spaces get mangled on Windows.
      return JSON.stringify({ mcpServers: { cortana: { command: 'npx', args: ['-y', 'mcp-remote', url, '--allow-http', '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: auth } } } }, null, 2);
    case 'openclaw':
      return JSON.stringify({ mcp: { servers: { cortana: { url, transport: 'streamable-http', headers: { Authorization: auth } } } } }, null, 2);
  }
}
