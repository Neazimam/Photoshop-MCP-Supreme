import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PhotoshopBridge } from './bridge.js';
import { registerTools, toolCatalog, FULL } from './tools.js';
import { BRIDGE_PORT, HTTP_PORT, DATA_DIR, ensureToken } from './paths.js';
import { INSTRUCTIONS, SERVER_INFO } from './meta.js';
import { Telemetry, hintFor, summarizeArgs } from './telemetry.js';
import { callContext } from './context.js';
import { buildClientConfigs } from './clientconfigs.js';
import { detectHosts } from './hosts.js';
import { dashboardHtml } from './dashboard.js';
import { convertHtmlToSpec, prepareSpecImages, slimHtmlForConvert, type SpecNode } from './htmlconvert.js';
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

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  if (!v) return undefined;
  try {
    return decodeURIComponent(String(v)).slice(0, 80);
  } catch {
    return String(v).slice(0, 80);
  }
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface TreeRow { n: string; k: string; x: number; y: number; w: number; h: number; c?: TreeRow[] }
/** Compact layer blueprint of a spec: what the plugin will build, names + rects, depth-capped. */
function specTree(nodes: readonly SpecNode[], budget: { left: number } = { left: 80 }, depth = 0): TreeRow[] {
  const out: TreeRow[] = [];
  for (const nd of nodes) {
    if (budget.left <= 0) {
      out.push({ n: '… more layers below', k: 'more', x: 0, y: 0, w: 0, h: 0 });
      break;
    }
    budget.left--;
    const row: TreeRow = {
      n: nd.name,
      k: nd.kind,
      x: Math.round(nd.rect.x),
      y: Math.round(nd.rect.y),
      w: Math.round(nd.rect.w),
      h: Math.round(nd.rect.h),
    };
    if (depth < 3 && Array.isArray(nd.children) && nd.children.length) {
      row.c = specTree(nd.children as SpecNode[], budget, depth + 1);
    }
    out.push(row);
  }
  return out;
}

/** Long-running process: owns the Photoshop WebSocket bridge and serves any number of MCP clients + the dashboard. */
export async function runDaemon(): Promise<void> {
  const tokenStr = ensureToken();
  const token = Buffer.from(tokenStr);
  const bridge = new PhotoshopBridge(BRIDGE_PORT);
  const telemetry = new Telemetry();
  bridge.onPluginEvent = (type, detail) => telemetry.connection(type, detail);
  await bridge.start();

  // Fill the tool catalogue once so the dashboard can list tools.
  registerTools(new McpServer(SERVER_INFO), bridge);
  const script = process.argv[1] ?? '';
  const clientConfigs = buildClientConfigs(process.execPath, script, HTTP_PORT);
  let hostsCache: { at: number; value: ReturnType<typeof detectHosts> } = { at: 0, value: [] };

  const hosts = new Set([`127.0.0.1:${HTTP_PORT}`, `localhost:${HTTP_PORT}`]);
  const origins = new Set([`http://127.0.0.1:${HTTP_PORT}`, `http://localhost:${HTTP_PORT}`]);
  const hostOk = (req: IncomingMessage): boolean => hosts.has(String(req.headers.host ?? '').toLowerCase());
  const authorized = (req: IncomingMessage): boolean => {
    if (!hostOk(req)) return false;
    if (req.headers.origin && !origins.has(String(req.headers.origin))) return false;
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return false;
    const given = Buffer.from(h.slice(7));
    return given.length === token.length && timingSafeEqual(given, token);
  };

  // Identify HTTP MCP clients: initialize carries clientInfo; later stateless requests only have the User-Agent.
  const seenClients = new Map<string, string>();
  const httpClientLabel = (req: IncomingMessage, body: any): string => {
    const key = `${req.socket.remoteAddress ?? ''}|${req.headers['user-agent'] ?? ''}`;
    const first = Array.isArray(body) ? body[0] : body;
    const ci = first?.method === 'initialize' ? first?.params?.clientInfo : undefined;
    if (ci?.name) seenClients.set(key, `${ci.name}${ci.version ? '/' + ci.version : ''}`);
    return seenClients.get(key) ?? String(req.headers['user-agent'] ?? 'http client').slice(0, 60);
  };

  /** Run one bridge call for the dashboard and record it. */
  const dashCall = async <T>(tool: string, fn: () => Promise<T>, args?: unknown): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      telemetry.record({ source: 'dashboard', client: 'dashboard', tool, ms: Date.now() - t0, ok: true, args: summarizeArgs(args) });
      return r;
    } catch (e) {
      telemetry.record({ source: 'dashboard', client: 'dashboard', tool, ms: Date.now() - t0, ok: false, error: errMsg(e), args: summarizeArgs(args) });
      throw e;
    }
  };

  async function selfTest() {
    const steps: { name: string; ok: boolean; ms: number; detail?: string; error?: string; hint?: string }[] = [];
    const run = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
      const t0 = Date.now();
      try {
        const detail = await fn();
        steps.push({ name, ok: true, ms: Date.now() - t0, detail });
        telemetry.record({ source: 'dashboard', client: 'dashboard', tool: 'selftest: ' + name, ms: Date.now() - t0, ok: true });
        return true;
      } catch (e) {
        const m = errMsg(e);
        steps.push({ name, ok: false, ms: Date.now() - t0, error: m, hint: hintFor(m) });
        telemetry.record({ source: 'dashboard', client: 'dashboard', tool: 'selftest: ' + name, ms: Date.now() - t0, ok: false, error: m });
        return false;
      }
    };
    const connected = await run('Photoshop plugin connected', async () => {
      const st = await bridge.status();
      if (!st.connected) throw new Error('Photoshop plugin is not connected.');
      return JSON.stringify(st.pluginInfo);
    });
    if (!connected) return steps;
    await run('Round trip (5 pings)', async () => {
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) await bridge.call('ping', {}, 10_000);
      return `${Math.round((Date.now() - t0) / 5)} ms average`;
    });
    await run('Photoshop version', async () => {
      const c: any = await bridge.call('capabilities', {}, 10_000);
      return `Photoshop ${c.photoshop}, UXP ${c.uxp ?? '?'}, ${c.documents} document(s) open`;
    });
    await run('Read document state', async () => {
      const s: any = await bridge.call('get_state', { depth: 1 }, 20_000);
      return s.document ? `active: ${s.document.title} (${s.document.width}x${s.document.height})` : 'no document open (that is fine)';
    });
    await run('Raw batchPlay (get application)', async () => {
      const r: any = await bridge.call(
        'batch_play',
        { descriptors: [{ _obj: 'get', _target: [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }], _options: { dialogOptions: 'dontDisplay' } }], read_only: true },
        20_000
      );
      return Array.isArray(r) && r[0] ? 'descriptor returned' : 'empty result';
    });
    await run('Script execution (needs allowCodeGenerationFromStrings)', async () => {
      const r = await bridge.call('run_js', { code: 'return 1 + 1;', read_only: true }, 20_000);
      if (r !== 2) throw new Error('Unexpected result: ' + JSON.stringify(r));
      return '1 + 1 = 2';
    });
    await run('Modal edit rights (executeAsModal)', async () => {
      const r = await bridge.call('run_js', { code: "return 'modal ok';", name: 'Supreme: self-test' }, 30_000);
      return String(r);
    });
    return steps;
  }

  const http = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        if (!hostOk(req)) return json(res, 403, { ok: false, error: 'Forbidden host' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https: http:; connect-src 'self'; frame-src blob:",
        });
        return void res.end(dashboardHtml(tokenStr, HTTP_PORT, BRIDGE_PORT));
      }
      if (req.method === 'GET' && path === '/favicon.ico') return void res.writeHead(204).end();
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, name: SERVER_INFO.name });
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST' });

      const body = await readBody(req);

      if (path === '/rpc') {
        const client = header(req, 'x-pss-client') ?? 'direct rpc';
        const tool = header(req, 'x-pss-tool') ?? 'rpc:' + String(body.action);
        const t0 = Date.now();
        try {
          const data = await bridge.call(String(body.action), body.params ?? {}, Number(body.timeoutMs) || 120_000);
          telemetry.record({ source: 'stdio', client, tool, ms: Date.now() - t0, ok: true, args: summarizeArgs(body.params?.args ?? body.params) });
          return json(res, 200, { ok: true, data });
        } catch (e) {
          telemetry.record({
            source: 'stdio',
            client,
            tool,
            ms: Date.now() - t0,
            ok: false,
            error: errMsg(e),
            detail: (e as any)?.pluginStack ? String((e as any).pluginStack).slice(0, 600) : undefined,
            args: summarizeArgs(body.params?.args ?? body.params),
          });
          return json(res, 200, { ok: false, error: errMsg(e) });
        }
      }
      if (path === '/status') return json(res, 200, { ok: true, data: await bridge.status() });
      if (path === '/events') return json(res, 200, { ok: true, data: await bridge.drainEvents(body) });

      if (path === '/mcp') {
        const label = httpClientLabel(req, body);
        const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
        registerTools(server, bridge, { onCall: (e) => telemetry.record({ source: 'http', ...e }) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await callContext.run({ client: label }, () => transport.handleRequest(req, res, body));
        return;
      }

      // ---------------- dashboard API ----------------
      if (path === '/api/stats') {
        const st = await bridge.status();
        if (Date.now() - hostsCache.at > 5000) hostsCache = { at: Date.now(), value: detectHosts() };
        return json(res, 200, {
          ok: true,
          now: Date.now(),
          status: st,
          ...telemetry.snapshot(),
          hosts: hostsCache.value,
          env: {
            version: SERVER_INFO.version,
            node: process.version,
            platform: process.platform,
            pid: process.pid,
            nodePath: process.execPath,
            script,
            dataDir: DATA_DIR,
            tokenFile: join(DATA_DIR, 'token'),
            auditLog: join(DATA_DIR, 'calls.jsonl'),
            httpPort: HTTP_PORT,
            bridgePort: BRIDGE_PORT,
            mode: FULL ? 'full' : 'safe',
          },
        });
      }
      if (path === '/api/config') {
        return json(res, 200, { ok: true, clients: clientConfigs, tools: [...toolCatalog.values()] });
      }
      if (path === '/api/state') {
        try {
          return json(res, 200, { ok: true, data: await bridge.call('get_state', { depth: 3 }, 20_000) });
        } catch (e) {
          return json(res, 200, { ok: false, error: errMsg(e), hint: hintFor(errMsg(e)) });
        }
      }
      if (path === '/api/preview') {
        try {
          const data = await dashCall('dashboard: preview', () => bridge.call('preview', { max_dim: 900 }, 120_000));
          return json(res, 200, { ok: true, data });
        } catch (e) {
          return json(res, 200, { ok: false, error: errMsg(e), hint: hintFor(errMsg(e)) });
        }
      }
      if (path === '/api/convert') {
        const fail = (error: string, hint?: string) =>
          json(res, 200, { ok: false, error, hint, serverVersion: SERVER_INFO.version });
        const html0 = typeof body.html === 'string' ? body.html : '';
        const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : undefined;
        const target = body.target === 'active' ? 'active' : 'new';
        const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 8);
        const groupName = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : undefined;
        const dim = (v: unknown): number | undefined => {
          const n = Math.round(Number(v));
          return Number.isFinite(n) && n >= 16 ? Math.min(n, 300000) : undefined;
        };
        const docW = dim(body.docW);
        const docH = dim(body.docH);
        if (!html0.trim()) return fail('No HTML provided.');
        // Upload budget. Files over SOFT are almost always AI pages with huge embedded base64 photos;
        // only the largest of those get auto-slimmed instead of failing; HARD is a hard stop.
        const SOFT = 12_000_000;
        const KEEP = 1_500_000; // embedded images up to 1.5 MB always keep their real pixels
        const HARD = 25_000_000;
        const mb = (n: number) => (n / 1e6).toFixed(1) + ' MB';
        const sizeWarnings: string[] = [];
        let html = html0;
        if (html.length > HARD) {
          const slim = slimHtmlForConvert(html, HARD, KEEP);
          html = slim.html;
        }
        if (html.length > HARD) {
          return fail(
            `HTML too large: ${mb(html0.length)} (limit ${mb(HARD)}).`,
            'Pages this big usually embed many base64 photos. Export images as separate files and reference them by path instead, or split the page.'
          );
        }
        if (html.length > SOFT) {
          const slim = slimHtmlForConvert(html, SOFT, KEEP);
          if (slim.replaced > 0) {
            html = slim.html;
            sizeWarnings.push(
              `File was ${mb(html0.length)} — ${slim.replaced} embedded image(s) over ${mb(KEEP)} were swapped for placeholders so it could convert. Reference smaller or external images to keep the real pixels.`
            );
          }
        }
        try {
          const spec = convertHtmlToSpec(html, { sourcePath: filename, scale, docW, docH });
          await prepareSpecImages(spec);
          const timeout = Math.min(600_000, 120_000 + spec.stats.images * 30_000 + spec.stats.nodes * 150);
          const data = (await dashCall('dashboard: convert html', () =>
            bridge.call('html_layers', { spec, target, group_name: groupName }, timeout))) as Record<string, unknown>;
          // the plugin echoes the incoming spec warnings back — dedupe so nothing appears twice
          const warnings = [...new Set([...sizeWarnings, ...spec.warnings, ...((data.warnings as string[]) ?? [])])];
          return json(res, 200, {
            ok: true,
            data: { ...data, canvas: spec.canvas, stats: spec.stats, warnings, slimmed: sizeWarnings.length > 0, serverVersion: SERVER_INFO.version },
          });
        } catch (e) {
          return fail(errMsg(e), hintFor(errMsg(e)));
        }
      }
      if (path === '/api/analyze') {
        // Layer blueprint: parse + layout ONLY, never touches Photoshop. Powers the live
        // "What will become layers" tree so users see the plan before committing a convert.
        const fail = (error: string, hint?: string) =>
          json(res, 200, { ok: false, error, hint, serverVersion: SERVER_INFO.version });
        const html = typeof body.html === 'string' ? body.html : '';
        if (!html.trim()) {
          return json(res, 200, { ok: true, data: { tree: [], canvas: null, stats: { nodes: 0, images: 0 }, warnings: [], serverVersion: SERVER_INFO.version } });
        }
        if (html.length > 5_000_000) {
          return fail(`Too large to plan live (${(html.length / 1e6).toFixed(1)} MB). It can still convert — press "Convert to layers".`);
        }
        const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 8);
        const dim = (v: unknown): number | undefined => {
          const n = Math.round(Number(v));
          return Number.isFinite(n) && n >= 16 ? Math.min(n, 300000) : undefined;
        };
        try {
          const spec = convertHtmlToSpec(html, { scale, docW: dim(body.docW), docH: dim(body.docH) });
          return json(res, 200, {
            ok: true,
            data: {
              tree: specTree(spec.elements),
              canvas: { w: spec.canvas.w, h: spec.canvas.h },
              stats: spec.stats,
              warnings: spec.warnings.slice(0, 4),
              serverVersion: SERVER_INFO.version,
            },
          });
        } catch (e) {
          return fail(errMsg(e), hintFor(errMsg(e)));
        }
      }
      if (path === '/api/selftest') return json(res, 200, { ok: true, steps: await selfTest() });
      if (path === '/api/clear') {
        telemetry.clear();
        return json(res, 200, { ok: true });
      }
      json(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: errMsg(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(HTTP_PORT, '127.0.0.1', resolve);
  });
  log(`daemon ready — bridge ws://127.0.0.1:${BRIDGE_PORT}, dashboard http://127.0.0.1:${HTTP_PORT}/`);

  const stop = () => {
    bridge.close();
    http.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
