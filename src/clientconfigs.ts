import { platform } from 'node:os';

export interface ClientConfig {
  id: string;
  title: string;
  where: string;
  lang: 'json' | 'toml' | 'shell' | 'text';
  /** May contain the placeholder __TOKEN__ (the page masks it and substitutes the real token on copy). */
  text: string;
  note?: string;
}

const win = platform() === 'win32';
const mac = platform() === 'darwin';
const J = (o: unknown) => JSON.stringify(o, null, 2);
const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/** Ready-to-paste MCP configuration for popular AI apps. `node`/`script` are the exact paths this daemon runs from. */
export function buildClientConfigs(node: string, script: string, httpPort: number): ClientConfig[] {
  const stdio = { command: node, args: [script] };
  const url = `http://127.0.0.1:${httpPort}/mcp`;
  const bearer = { Authorization: 'Bearer __TOKEN__' };
  const home = win ? '%USERPROFILE%' : '~';
  return [
    {
      id: 'claude-desktop',
      title: 'Claude Desktop',
      where: win ? '%APPDATA%\\Claude\\claude_desktop_config.json' : mac ? '~/Library/Application Support/Claude/claude_desktop_config.json' : '~/.config/Claude/claude_desktop_config.json',
      lang: 'json',
      text: J({ mcpServers: { 'photoshop-supreme': stdio } }),
      note: 'The installer already does this. Merge into your existing "mcpServers" and fully restart Claude Desktop (quit from the tray).',
    },
    {
      id: 'claude-code',
      title: 'Claude Code (CLI)',
      where: 'run once in a terminal',
      lang: 'shell',
      text: `claude mcp add photoshop-supreme -- ${q(node)} ${q(script)}\n\n# or over HTTP (shares this daemon):\nclaude mcp add --transport http photoshop-supreme ${url} --header "Authorization: Bearer __TOKEN__"`,
    },
    {
      id: 'cursor',
      title: 'Cursor',
      where: `${home}${win ? '\\.cursor\\mcp.json' : '/.cursor/mcp.json'}  (or Settings > MCP)`,
      lang: 'json',
      text: J({ mcpServers: { 'photoshop-supreme': stdio } }),
      note: 'The installer already does this. HTTP alternative: { "url": "' + url + '", "headers": { "Authorization": "Bearer <token>" } }',
    },
    {
      id: 'vscode',
      title: 'VS Code (Copilot Agent mode)',
      where: '.vscode/mcp.json in your workspace (or "MCP: Open User Configuration")',
      lang: 'json',
      text: J({ servers: { 'photoshop-supreme': { type: 'stdio', command: node, args: [script] } } }),
    },
    {
      id: 'windsurf',
      title: 'Windsurf',
      where: `${home}${win ? '\\.codeium\\windsurf\\mcp_config.json' : '/.codeium/windsurf/mcp_config.json'}`,
      lang: 'json',
      text: J({ mcpServers: { 'photoshop-supreme': stdio } }),
    },
    {
      id: 'cline',
      title: 'Cline / Roo Code',
      where: 'Cline panel > MCP Servers > Configure (cline_mcp_settings.json)',
      lang: 'json',
      text: J({ mcpServers: { 'photoshop-supreme': { ...stdio, disabled: false, autoApprove: [] } } }),
    },
    {
      id: 'gemini-cli',
      title: 'Gemini CLI',
      where: `${home}${win ? '\\.gemini\\settings.json' : '/.gemini/settings.json'}`,
      lang: 'json',
      text: J({ mcpServers: { 'photoshop-supreme': stdio } }),
    },
    {
      id: 'codex',
      title: 'OpenAI Codex CLI',
      where: `${home}${win ? '\\.codex\\config.toml' : '/.codex/config.toml'}`,
      lang: 'toml',
      text: `[mcp_servers.photoshop-supreme]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(script)}]`,
    },
    {
      id: 'http',
      title: 'Any client with HTTP MCP support',
      where: 'client\'s "remote / streamable HTTP" server setting',
      lang: 'text',
      text: `URL:     ${url}\nHeader:  Authorization: Bearer __TOKEN__\nTransport: Streamable HTTP (stateless)`,
      note: 'Only reachable from this computer (127.0.0.1). Token file: ~/.photoshop-supreme-mcp/token',
    },
    {
      id: 'chatgpt',
      title: 'ChatGPT',
      where: 'Settings > Apps & Connectors > Advanced > Developer mode > create connector',
      lang: 'text',
      text: `ChatGPT cannot start local (stdio) MCP servers and cannot reach 127.0.0.1.\nIt only connects to REMOTE servers over HTTPS (developer mode, paid plans; write tools may be plan-limited).\n\nTo use it you would have to publish this daemon's endpoint (${url}) at a public https:// address yourself and secure it.\nThat exposes Photoshop and your files to the internet - NOT recommended and not set up by the installer.\nA static bearer header may not be supported by ChatGPT connectors (they use OAuth / no-auth); I could not verify this.\nSafer: use Claude Desktop, Claude Code, Cursor, VS Code or Codex CLI above.`,
      note: 'Details change often - check OpenAI\'s "Developer mode and MCP apps in ChatGPT" help article.',
    },
  ];
}
