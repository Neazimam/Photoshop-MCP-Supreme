#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PhotoshopBridge, type Bridge } from './bridge.js';
import { RemoteBridge } from './remote.js';
import { registerTools } from './tools.js';
import { runDaemon } from './daemon.js';
import { BRIDGE_PORT, HTTP_PORT, readToken } from './paths.js';
import { INSTRUCTIONS, SERVER_INFO } from './meta.js';
import { log } from './log.js';

async function daemonAlive(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.includes('--daemon')) {
    try {
      await runDaemon();
    } catch (e) {
      log('daemon failed to start:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
    return;
  }

  // stdio mode (spawned by Claude Desktop / Cursor): prefer the shared daemon, else run self-contained.
  let bridge: Bridge;
  const token = readToken();
  if (token && (await daemonAlive())) {
    bridge = new RemoteBridge(BRIDGE_PORT, `http://127.0.0.1:${HTTP_PORT}`, token);
    log('using background daemon');
  } else {
    const local = new PhotoshopBridge(BRIDGE_PORT);
    try {
      await local.start();
    } catch (e) {
      log(`Could not start bridge on port ${BRIDGE_PORT}:`, e instanceof Error ? e.message : e);
      log('Another instance owns the port. Start the daemon (installer does this) or set PS_SUPREME_PORT.');
      process.exit(1);
    }
    bridge = local;
    log('no daemon found — running self-contained');
  }

  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server, bridge);
  await server.connect(new StdioServerTransport());
  log('MCP server ready (stdio)');
}

main().catch((e) => {
  log('fatal:', e);
  process.exit(1);
});
