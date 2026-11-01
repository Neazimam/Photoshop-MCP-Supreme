import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PhotoshopBridge } from './bridge.js';
import { registerTools } from './tools.js';
import { BRIDGE_PORT, HTTP_PORT, ensureToken } from './paths.js';
import { INSTRUCTIONS, SERVER_INFO } from './meta.js';
import { dashboardHtml } from './dashboard.js';
import { log } from './log.js';

function readBody(req: IncomingMessage, limit = 80 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const p = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) });
  res.end(p);
};

/** Long-running process: owns the Photoshop WebSocket bridge and serves any number of MCP clients. */
export async function runDaemon(): Promise<void> {
  const token = Buffer.from(ensureToken());
  const bridge = new PhotoshopBridge(BRIDGE_PORT);
  await bridge.start();

  // Only our own origin / host names are accepted (blocks other websites and DNS-rebinding).
  const hosts = new Set([`127.0.0.1:${HTTP_PORT}`, `localhost:${HTTP_PORT}`]);
  const origins = new Set([`http://127.0.0.1:${HTTP_PORT}`, `http://localhost:${HTTP_PORT}`]);
  const hostOk = (req: IncomingMessage): boolean => hosts.has(String(req.headers.host ?? '').toLowerCase());

  const authorized = (req: IncomingMessage): boolean => {
    if (!hostOk(req)) return false;
    if (req.headers.origin && !origins.has(String(req.headers.origin))) return false; // other websites
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return false;
    const given = Buffer.from(h.slice(7));
    return given.length === token.length && timingSafeEqual(given, token);
  };

  const http = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        if (!hostOk(req)) return json(res, 403, { ok: false, error: 'Forbidden host' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
        });
        return void res.end(dashboardHtml(token.toString(), HTTP_PORT, BRIDGE_PORT));
      }
      if (req.method === 'GET' && path === '/favicon.ico') return void res.writeHead(204).end();
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, name: SERVER_INFO.name });
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST' });

      const body = await readBody(req);
      if (path === '/rpc') {
        try {
          const data = await bridge.call(String(body.action), body.params ?? {}, Number(body.timeoutMs) || 120_000);
          return json(res, 200, { ok: true, data });
        } catch (e) {
          return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (path === '/status') return json(res, 200, { ok: true, data: await bridge.status() });
      if (path === '/events') return json(res, 200, { ok: true, data: await bridge.drainEvents(body) });
      if (path === '/mcp') {
        // Streamable HTTP MCP endpoint (stateless) for clients that speak HTTP instead of stdio.
        const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
        registerTools(server, bridge);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      json(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(HTTP_PORT, '127.0.0.1', resolve);
  });
  log(`daemon ready — bridge ws://127.0.0.1:${BRIDGE_PORT}, api http://127.0.0.1:${HTTP_PORT}`);

  const stop = () => {
    bridge.close();
    http.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
