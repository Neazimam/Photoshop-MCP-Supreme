import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bridge } from './bridge.js';
import { registerExtras } from './extras.js';
import { callContext } from './context.js';
import { summarizeArgs } from './telemetry.js';

export interface CallRecord {
  client: string;
  tool: string;
  ms: number;
  ok: boolean;
  error?: string;
  detail?: string;
  args?: string;
}
export interface ToolHooks {
  onCall?: (e: CallRecord) => void;
}
/** name -> description of every tool registered in this process (for the dashboard). */
export const toolCatalog = new Map<string, { name: string; description: string; full: boolean }>();

/** PS_SUPREME_MODE=safe disables every tool that executes arbitrary code (UXP, ExtendScript, saved scripts). */
export const FULL = (process.env.PS_SUPREME_MODE ?? 'full').toLowerCase() !== 'safe';

type Shape = Record<string, z.ZodTypeAny>;

interface RunOpts {
  document_id?: number | null;
  read_only?: boolean;
  name?: string;
  single_history?: boolean;
}

const docId = z
  .number()
  .int()
  .optional()
  .describe('Target document id (from ps_get_state). Pins the edit so a UI tab switch cannot retarget it. Defaults to the active document.');

const text = (v: unknown) => ({
  content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

export function registerTools(server: McpServer, bridge: Bridge, hooks: ToolHooks = {}): void {
  function tool(name: string, description: string, shape: Shape, handler: (a: any) => Promise<unknown>, opts: { full?: boolean } = {}) {
    if (opts.full && !FULL) return;
    toolCatalog.set(name, { name, description, full: !!opts.full });
    server.registerTool(
      name,
      { description, inputSchema: shape },
      (async (args: any) => {
        const outer = callContext.getStore();
        let client = outer?.client;
        if (!client) {
          const v = (server.server as any).getClientVersion?.();
          client = v?.name ? `${v.name}${v.version ? '/' + v.version : ''}` : 'unknown client';
        }
        const t0 = Date.now();
        return callContext.run({ client, tool: name }, async () => {
          try {
            const r: any = await handler(args ?? {});
            hooks.onCall?.({ client: client!, tool: name, ms: Date.now() - t0, ok: true, args: summarizeArgs(args) });
            if (r && typeof r === 'object' && r.__content) return { content: r.__content };
            return text(r);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            hooks.onCall?.({
              client: client!,
              tool: name,
              ms: Date.now() - t0,
              ok: false,
              error: msg,
              detail: (e as any)?.pluginStack ? String((e as any).pluginStack).slice(0, 600) : undefined,
              args: summarizeArgs(args),
            });
            return { isError: true, content: [{ type: 'text' as const, text: msg }] };
          }
        });
      }) as any
    );
  }

  /** Run a UXP JS function body in Photoshop. `ctx` = { app, core, action, constants, fs, doc, args, layer(id), batchPlay }. */
  const js = (code: string, args: Record<string, unknown> = {}, o: RunOpts = {}) =>
    bridge.call('run_js', { code, args, ...o });

  // ===================================================================== status
  tool(
    'ps_status',
    'Check the bridge: is the Photoshop plugin connected, and which Photoshop/plugin versions are running.',
    {},
    async () => {
      const st = await bridge.status();
      return {
        connected: st.connected,
        port: bridge.port,
        plugin: st.pluginInfo,
        ...(st.connected ? { capabilities: await bridge.call('capabilities') } : {}),
      };
    }
  );

  tool(
    'ps_get_state',
    'Snapshot of Photoshop: open documents, active document, layer tree (id/name/kind/visible/opacity/blend/bounds), active layers, selection bounds, history. Call this before editing and after to verify.',
    { document_id: docId, depth: z.number().int().min(0).max(10).optional().describe('Layer-group nesting depth to expand (default 2)') },
    (a) => bridge.call('get_state', a)
  );

  tool(
    'ps_preview',
    'Render the document to a JPEG and return it as an image so you can visually verify your work.',
    {
      document_id: docId,
      max_dim: z.number().int().min(64).max(4096).optional().describe('Longest side in px (default 1024)'),
      quality: z.number().int().min(1).max(12).optional().describe('JPEG quality 1-12 (default 8)'),
    },
    async (a) => {
      const r = await bridge.call<{ mimeType: string; data: string }>('preview', a, 180_000);
      return { __content: [{ type: 'image', data: r.data, mimeType: r.mimeType }] };
    }
  );

  // ============================================================ escape hatches
  tool(
    'ps_batch_play',
    'Run raw Photoshop ActionDescriptors via batchPlay — the lowest-level, complete control surface (anything Photoshop can do from its UI). By default all descriptors are collapsed into ONE undo step. Use ps_record_start/ps_record_stop to capture the exact descriptors for any manual action.',
    {
      descriptors: z.array(z.record(z.any())).min(1).describe('Array of ActionDescriptor objects, e.g. [{"_obj":"select","_target":[{"_ref":"layer","_name":"Background"}]}]'),
      options: z.record(z.any()).optional().describe('batchPlay options, e.g. {"synchronousExecution":false,"dialogOptions":"dontDisplay"}'),
      document_id: docId,
      read_only: z.boolean().optional().describe('True for get-only calls (skips modal state; faster)'),
      single_history: z.boolean().optional().describe('Collapse into one history state (default true)'),
      name: z.string().optional().describe('History state name'),
      timeout_ms: z.number().int().min(1000).max(3600000).optional().describe('Max wait (default 120000)'),
    },
    (a) => bridge.call('batch_play', a, a.timeout_ms)
  );

  tool(
    'ps_run_uxp',
    'Run arbitrary JavaScript inside Photoshop (UXP). The code is an async function BODY and must `return` JSON-serializable data. Available as `ctx`: app, core, action, constants, fs (localFileSystem), storage, doc (target document or null), args, layer(id), batchPlay(descriptors, options). Full Photoshop DOM + batchPlay + file access. Wrapped in executeAsModal and one history state unless read_only.',
    {
      code: z.string().describe('Async function body, e.g. "const l = ctx.layer(ctx.args.id); l.opacity = 50; return l.name;"'),
      args: z.record(z.any()).optional().describe('Values exposed as ctx.args'),
      document_id: docId,
      read_only: z.boolean().optional().describe('True if the code only reads (no modal state)'),
      single_history: z.boolean().optional().describe('Collapse into one history state (default true)'),
      name: z.string().optional().describe('History state name'),
      timeout_ms: z.number().int().min(1000).max(3600000).optional().describe('Max wait (default 120000) — raise for long batch jobs'),
    },
    (a) => bridge.call('run_js', a, a.timeout_ms),
    { full: true }
  );

  tool(
    'ps_get_descriptor',
    'Read any Photoshop property via a batchPlay "get". Pass the _target reference chain, property first. Examples: active layer effects → [{"_property":"layerEffects"},{"_ref":"layer","_enum":"ordinal","_value":"targetEnum"}]; document size → [{"_property":"width"},{"_ref":"document","_enum":"ordinal","_value":"targetEnum"}]; app info → [{"_ref":"application","_enum":"ordinal","_value":"targetEnum"}].',
    { target: z.array(z.record(z.any())).min(1).describe('_target reference chain') },
    async (a) => {
      const res = (await bridge.call('batch_play', {
        descriptors: [{ _obj: 'get', _target: a.target, _options: { dialogOptions: 'dontDisplay' } }],
        read_only: true,
      })) as unknown[];
      return res[0] ?? null;
    }
  );

  // ======================================================== recorder + events
  tool(
    'ps_record_start',
    'Start recording every Photoshop event/descriptor produced by manual actions in the UI. Perform the action by hand in Photoshop, then call ps_record_stop to see the descriptors — the fastest way to learn what to send to ps_batch_play.',
    { ignore: z.array(z.string()).optional().describe('Event names to skip (default: toolModalStateChanged)') },
    (a) => bridge.call('record_start', { ignore: a.ignore ?? ['toolModalStateChanged'] })
  );
  tool('ps_record_stop', 'Stop recording and return all captured events with their descriptors.', {}, () =>
    bridge.call('record_stop')
  );

  tool(
    'ps_subscribe',
    'Subscribe to Photoshop notification events (e.g. "select", "make", "delete", "set", "open", "close", "save", "historyStateChanged", "all"). Events are buffered server-side; read them with ps_get_events.',
    { events: z.array(z.string()).min(1) },
    (a) => bridge.call('subscribe', a)
  );
  tool('ps_unsubscribe', 'Stop event subscription.', {}, () => bridge.call('unsubscribe'));
  tool(
    'ps_get_events',
    'Read buffered Photoshop events from ps_subscribe.',
    {
      since_ms_ago: z.number().int().optional().describe('Only events newer than this many ms ago'),
      filter: z.string().optional().describe('Substring filter on event name'),
      clear: z.boolean().optional().describe('Clear the buffer after reading'),
    },
    async (a) => {
      const events = await bridge.drainEvents({
        since: a.since_ms_ago ? Date.now() - a.since_ms_ago : undefined,
        filter: a.filter,
        clear: a.clear,
      });
      return { count: events.length, events };
    }
  );

  // ============================================================== documents
  tool(
    'ps_new_document',
    'Create a new document.',
    {
      name: z.string().default('Untitled'),
      width: z.number().int().min(1).max(300000),
      height: z.number().int().min(1).max(300000),
      resolution: z.number().default(72),
      mode: z.enum(['RGB', 'CMYK', 'Grayscale']).default('RGB'),
      fill: z.enum(['white', 'transparent', 'background']).default('white'),
    },
    (a) =>
      js(
        `const c = ctx.constants;
const ndm = c.NewDocumentMode || {};
const ndf = c.NewDocumentFill || {};
const modeVal = ndm[ctx.args.mode === 'CMYK' ? 'CMYK' : ctx.args.mode === 'Grayscale' ? 'GRAYSCALE' : 'RGB'];
const fillVal = ndf[{ white: 'WHITE', transparent: 'TRANSPARENT', background: 'BACKGROUNDCOLOR' }[ctx.args.fill]];
// Older Photoshop builds lack constants.NewDocumentFill — fall back to the classic batchPlay descriptor.
if (modeVal != null && fillVal != null) {
  const d = await ctx.app.documents.add({ title: ctx.args.name, width: ctx.args.width, height: ctx.args.height, resolution: ctx.args.resolution, mode: modeVal, fill: fillVal });
  return { id: d.id, title: d.title };
}
const colorSpace = { RGB: 'RGBColor', CMYK: 'CMYKColor', Grayscale: 'grayscale' }[ctx.args.mode] || 'RGBColor';
const fillEnum = { white: 'white', transparent: 'transparent', background: 'backgroundColor' }[ctx.args.fill] || 'white';
await ctx.batchPlay([{ _obj: 'make', _target: [{ _ref: 'document' }], using: { _obj: 'document', name: ctx.args.name, mode: { _enum: 'colorSpace', _value: colorSpace }, resolution: { _unit: 'resolutionUnit', _value: ctx.args.resolution }, width: { _unit: 'pixelsUnit', _value: ctx.args.width }, height: { _unit: 'pixelsUnit', _value: ctx.args.height }, fill: { _enum: 'fill', _value: fillEnum } }, _options: { dialogOptions: 'dontDisplay' } }], { synchronousExecution: true });
const d2 = ctx.app.activeDocument || ctx.app.documents[ctx.app.documents.length - 1];
return { id: d2.id, title: d2.title };`,
        a,
        { single_history: false, name: 'Supreme: new document' }
      )
  );

  tool(
    'ps_open_document',
    'Open a file (PSD, PNG, JPG, TIFF, …) by absolute path.',
    { path: z.string().describe('Absolute file path') },
    (a) =>
      js(
        `const p = ctx.args.path.replace(/\\\\/g, '/');
const cands = p.startsWith('/') ? ['file:' + p] : ['file:/' + p, 'file:' + p];
let entry = null, err = null;
for (const u of cands) { try { entry = await ctx.fs.getEntryWithUrl(u); break; } catch (e) { err = e; } }
if (!entry) throw err;
const d = await ctx.app.open(entry);
return { id: d.id, title: d.title };`,
        a,
        { single_history: false, name: 'Supreme: open' }
      )
  );

  tool(
    'ps_save_document',
    'Save/export the document (as a copy) to an absolute path. Format is inferred from the extension: psd, jpg/jpeg, png.',
    { path: z.string(), quality: z.number().int().min(1).max(12).default(10), document_id: docId },
    (a) =>
      js(
        `const p = ctx.args.path.replace(/\\\\/g, '/');
const ext = p.split('.').pop().toLowerCase();
const cands = p.startsWith('/') ? ['file:' + p] : ['file:/' + p, 'file:' + p];
let entry = null, err = null;
for (const u of cands) { try { entry = await ctx.fs.createEntryWithUrl(u, { overwrite: true }); break; } catch (e) { err = e; } }
if (!entry) throw err;
if (!ctx.doc) throw new Error('No document');
if (ext === 'psd') await ctx.doc.saveAs.psd(entry, {}, true);
else if (ext === 'jpg' || ext === 'jpeg') await ctx.doc.saveAs.jpg(entry, { quality: ctx.args.quality }, true);
else if (ext === 'png') await ctx.doc.saveAs.png(entry, {}, true);
else throw new Error('Unsupported extension: ' + ext + ' (use psd, jpg, png — or ps_batch_play for other formats)');
return { saved: ctx.args.path };`,
        a,
        { document_id: a.document_id, single_history: false, name: 'Supreme: save' }
      )
  );

  tool(
    'ps_close_document',
    'Close a document.',
    { save: z.boolean().default(false).describe('Save changes before closing'), document_id: docId },
    (a) =>
      js(
        `if (!ctx.doc) throw new Error('No document');
await ctx.doc.close(ctx.args.save ? ctx.constants.SaveOptions.SAVECHANGES : ctx.constants.SaveOptions.DONOTSAVECHANGES);
return { closed: true };`,
        a,
        { document_id: a.document_id, single_history: false, name: 'Supreme: close' }
      )
  );

  tool('ps_undo', 'Undo the last history step(s).', { steps: z.number().int().min(1).max(50).default(1), document_id: docId }, (a) =>
    js(
      `for (let i = 0; i < ctx.args.steps; i++) {
  await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'historyState', _enum: 'ordinal', _value: 'previous' }], _options: { dialogOptions: 'dontDisplay' } }], {});
}
return { undone: ctx.args.steps };`,
      a,
      { document_id: a.document_id, single_history: false, name: 'Supreme: undo' }
    )
  );

  tool('ps_redo', 'Redo history step(s).', { steps: z.number().int().min(1).max(50).default(1), document_id: docId }, (a) =>
    js(
      `for (let i = 0; i < ctx.args.steps; i++) {
  await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'historyState', _enum: 'ordinal', _value: 'next' }], _options: { dialogOptions: 'dontDisplay' } }], {});
}
return { redone: ctx.args.steps };`,
      a,
      { document_id: a.document_id, single_history: false, name: 'Supreme: redo' }
    )
  );

  // ================================================================== layers
  tool(
    'ps_create_layer',
    'Create an empty pixel layer or a group.',
    { name: z.string().default('Layer'), kind: z.enum(['pixel', 'group']).default('pixel'), document_id: docId },
    (a) =>
      js(
        `const l = ctx.args.kind === 'group' ? await ctx.doc.createLayerGroup({ name: ctx.args.name }) : await ctx.doc.createLayer({ name: ctx.args.name });
return { id: l.id, name: l.name };`,
        a,
        { document_id: a.document_id, name: 'Supreme: create layer' }
      )
  );

  tool(
    'ps_set_layer_props',
    'Change layer properties: name, visibility, opacity (0-100), blend mode (e.g. NORMAL, MULTIPLY, SCREEN, OVERLAY, SOFTLIGHT), lock.',
    {
      layer_id: z.number().int(),
      name: z.string().optional(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(100).optional(),
      blend_mode: z.string().optional(),
      locked: z.boolean().optional(),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
if (a.name != null) l.name = a.name;
if (a.visible != null) l.visible = a.visible;
if (a.opacity != null) l.opacity = a.opacity;
if (a.blend_mode != null) { const k = a.blend_mode.toUpperCase(); l.blendMode = ctx.constants.BlendMode[k] || a.blend_mode; }
if (a.locked != null) l.allLocked = a.locked;
return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode };`,
        a,
        { document_id: a.document_id, name: 'Supreme: layer props' }
      )
  );

  tool('ps_delete_layer', 'Delete a layer.', { layer_id: z.number().int(), document_id: docId }, (a) =>
    js(`ctx.layer(ctx.args.layer_id).delete(); return { deleted: ctx.args.layer_id };`, a, {
      document_id: a.document_id,
      name: 'Supreme: delete layer',
    })
  );

  tool('ps_duplicate_layer', 'Duplicate a layer.', { layer_id: z.number().int(), document_id: docId }, (a) =>
    js(`const d = await ctx.layer(ctx.args.layer_id).duplicate(); return { id: d.id, name: d.name };`, a, {
      document_id: a.document_id,
      name: 'Supreme: duplicate layer',
    })
  );

  tool(
    'ps_transform_layer',
    'Move / scale / rotate a layer. dx, dy in px (relative); x, y in px (absolute top-left position, applied last); scale_x, scale_y in percent (100 = unchanged); rotate in degrees.',
    {
      layer_id: z.number().int(),
      dx: z.number().default(0),
      dy: z.number().default(0),
      x: z.number().optional().describe('Absolute left position of the layer bounds after transforming'),
      y: z.number().optional().describe('Absolute top position of the layer bounds after transforming'),
      scale_x: z.number().optional(),
      scale_y: z.number().optional(),
      rotate: z.number().optional(),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
if (a.scale_x != null || a.scale_y != null) await l.scale(a.scale_x ?? 100, a.scale_y ?? 100);
if (a.rotate != null) await l.rotate(a.rotate);
if (a.dx || a.dy) await l.translate(a.dx, a.dy);
if (a.x != null || a.y != null) { const b0 = l.bounds; await l.translate(a.x != null ? a.x - b0.left : 0, a.y != null ? a.y - b0.top : 0); }
const b = l.bounds; return { id: l.id, bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } };`,
        a,
        { document_id: a.document_id, name: 'Supreme: transform' }
      )
  );

  tool(
    'ps_create_text_layer',
    'Create a text layer.',
    {
      text: z.string(),
      x: z.number().default(100),
      y: z.number().default(100),
      font_size: z.number().default(48),
      font_name: z.string().optional().describe('PostScript font name, e.g. "ArialMT"'),
      color: z.object({ r: z.number(), g: z.number(), b: z.number() }).default({ r: 0, g: 0, b: 0 }),
      document_id: docId,
    },
    (a) =>
      js(
        `const a = ctx.args;
const opts = { contents: a.text, fontSize: a.font_size, textColor: { red: a.color.r, green: a.color.g, blue: a.color.b }, position: { x: a.x, y: a.y } };
if (a.font_name) opts.fontName = a.font_name;
const l = await ctx.doc.createTextLayer(opts);
return { id: l.id, name: l.name };`,
        a,
        { document_id: a.document_id, name: 'Supreme: text layer' }
      )
  );


  // ================================================================ images
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
  const sniffExt = (b: Buffer): string => {
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
    if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    if (b.subarray(0, 4).toString('latin1') === '8BPS') return 'psd';
    if (b.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
    if (b.subarray(0, 4).toString('latin1') === 'II*\0' || b.subarray(0, 4).toString('latin1') === 'MM\0*') return 'tif';
    throw new Error('Unrecognized image data (supported: png, jpg, gif, webp, psd, bmp, tif)');
  };

  tool(
    'ps_place_image',
    'Push an image into Photoshop as a new placed (smart object) layer. Give ONE source: `path` (absolute file path on this machine — most reliable), `url` (http/https), or `base64` (raw base64 or data: URL — only practical for small images). If no document is open, the image is opened as a new document. Note: an image merely attached to a chat is NOT automatically available to tools; pass a path, URL, or base64.',
    {
      path: z.string().optional(),
      url: z.string().url().optional(),
      base64: z.string().optional(),
      name: z.string().optional().describe('Layer name'),
      x: z.number().optional().describe('Move placed layer so its left edge is at x (px)'),
      y: z.number().optional().describe('Move placed layer so its top edge is at y (px)'),
      document_id: docId,
    },
    async (a) => {
      const sources = [a.path, a.url, a.base64].filter((v) => v != null).length;
      if (sources !== 1) throw new Error('Provide exactly one of: path, url, base64');
      let file: string = a.path;
      if (!file) {
        let bytes: Buffer;
        if (a.url) {
          if (!/^https?:\/\//i.test(a.url)) throw new Error('Only http(s) URLs are allowed');
          const r = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
          if (!r.ok) throw new Error('Download failed: HTTP ' + r.status);
          const len = Number(r.headers.get('content-length') ?? 0);
          if (len > MAX_IMAGE_BYTES) throw new Error('Image larger than 50 MB');
          bytes = Buffer.from(await r.arrayBuffer());
        } else {
          bytes = Buffer.from(String(a.base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, ''), 'base64');
        }
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image empty or larger than 50 MB');
        const dir = join(tmpdir(), 'photoshop-supreme');
        await mkdir(dir, { recursive: true });
        file = join(dir, randomUUID() + '.' + sniffExt(bytes));
        await writeFile(file, bytes);
      }
      return js(
        `const p = ctx.args.path.replace(/\\\\/g, '/');
const cands = p.startsWith('/') ? ['file:' + p] : ['file:/' + p, 'file:' + p];
let entry = null, err = null;
for (const u of cands) { try { entry = await ctx.fs.getEntryWithUrl(u); break; } catch (e) { err = e; } }
if (!entry) throw err;
if (!ctx.doc) { const d = await ctx.app.open(entry); return { openedAsDocument: true, id: d.id, title: d.title }; }
const token = await ctx.fs.createSessionToken(entry);
await ctx.batchPlay([{ _obj: 'placeEvent', null: { _path: token, _kind: 'local' }, freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' }, offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 0 }, vertical: { _unit: 'pixelsUnit', _value: 0 } }, _options: { dialogOptions: 'dontDisplay' } }], {});
const l = ctx.doc.activeLayers[0];
if (ctx.args.name) l.name = ctx.args.name;
if (ctx.args.x != null || ctx.args.y != null) { const b = l.bounds; await l.translate(ctx.args.x != null ? ctx.args.x - b.left : 0, ctx.args.y != null ? ctx.args.y - b.top : 0); }
const b2 = l.bounds;
return { id: l.id, name: l.name, bounds: { left: b2.left, top: b2.top, right: b2.right, bottom: b2.bottom } };`,
        { path: file, name: a.name, x: a.x, y: a.y },
        { document_id: a.document_id, name: 'Supreme: place image' }
      );
    }
  );

  // ======================================================= selection + filters
  tool(
    'ps_select',
    'Make a selection: all, none (deselect), rect, or ellipse. Coordinates in px.',
    {
      kind: z.enum(['all', 'none', 'rect', 'ellipse']),
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
      feather: z.number().default(0),
      document_id: docId,
    },
    (a) =>
      js(
        `const a = ctx.args; const s = ctx.doc.selection; const rep = ctx.constants.SelectionType.REPLACE;
const box = { left: a.left, top: a.top, right: a.right, bottom: a.bottom };
if (a.kind === 'all') await s.selectAll();
else if (a.kind === 'none') await s.deselect();
else if (a.kind === 'rect') await s.selectRectangle(box, rep, a.feather, true);
else await s.selectEllipse(box, rep, a.feather, true);
return { selected: a.kind };`,
        a,
        { document_id: a.document_id, name: 'Supreme: select' }
      )
  );

  tool(
    'ps_fill_selection',
    'Fill the current selection on the active layer with an RGB color.',
    { r: z.number().min(0).max(255), g: z.number().min(0).max(255), b: z.number().min(0).max(255), opacity: z.number().min(0).max(100).default(100), document_id: docId },
    (a) =>
      js(
        `const c = new ctx.app.SolidColor(); c.rgb.red = ctx.args.r; c.rgb.green = ctx.args.g; c.rgb.blue = ctx.args.b;
await ctx.doc.selection.fill(c, ctx.constants.BlendMode.NORMAL, ctx.args.opacity);
return { filled: true };`,
        a,
        { document_id: a.document_id, name: 'Supreme: fill' }
      )
  );

  tool(
    'ps_gaussian_blur',
    'Apply Gaussian Blur to a layer.',
    { layer_id: z.number().int(), radius: z.number().min(0.1).max(1000), document_id: docId },
    (a) =>
      js(`await ctx.layer(ctx.args.layer_id).applyGaussianBlur(ctx.args.radius); return { blurred: ctx.args.layer_id };`, a, {
        document_id: a.document_id,
        name: 'Supreme: gaussian blur',
      })
  );

  // ================================================= dynamic layer control
  const rgbObj = z.object({ r: z.number().min(0).max(255), g: z.number().min(0).max(255), b: z.number().min(0).max(255) });

  tool(
    'ps_layer_effects',
    'Add live (non-destructive) layer styles to a layer: drop shadow, inner shadow, outer glow, stroke, color overlay. Pass only the effects you want; they are MERGED into existing effects (pass clear_effects: true to reset them all first). Much safer than baking pixels.',
    {
      layer_id: z.number().int(),
      drop_shadow: z.object({ color: rgbObj.default({ r: 0, g: 0, b: 0 }), opacity: z.number().min(0).max(100).default(75), angle: z.number().default(130).describe('degrees, 90 = straight up'), distance: z.number().default(5), spread: z.number().default(0), size: z.number().min(0).default(5), blend_mode: z.string().default('MULTIPLY') }).optional(),
      inner_shadow: z.object({ color: rgbObj.default({ r: 0, g: 0, b: 0 }), opacity: z.number().min(0).max(100).default(75), angle: z.number().default(130), distance: z.number().default(5), choke: z.number().default(0), size: z.number().min(0).default(5) }).optional(),
      outer_glow: z.object({ color: rgbObj.default({ r: 255, g: 255, b: 190 }), opacity: z.number().min(0).max(100).default(50), size: z.number().min(0).default(10), blend_mode: z.string().default('SCREEN') }).optional(),
      stroke: z.object({ size: z.number().min(1).default(3), color: rgbObj.default({ r: 0, g: 0, b: 0 }), position: z.enum(['OUTSIDE', 'INSIDE', 'CENTER']).default('OUTSIDE'), opacity: z.number().min(0).max(100).default(100) }).optional(),
      color_overlay: z.object({ color: rgbObj, opacity: z.number().min(0).max(100).default(100), blend_mode: z.string().default('NORMAL') }).optional(),
      clear_effects: z.boolean().default(false).describe('Remove ALL existing layer effects before applying'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
const rgb = (c) => ({ _obj: 'RGBColor', red: Math.round(c.r), grain: Math.round(c.g), blue: Math.round(c.b) });
const pc = (n) => ({ _unit: 'percentUnit', _value: n });
const au = (n) => ({ _unit: 'angleUnit', _value: n });
const pu = (n) => ({ _unit: 'pixelsUnit', _value: n });
let fx = {};
if (!a.clear_effects) {
  try {
    const g = await ctx.batchPlay([{ _obj: 'get', _target: [{ _property: 'layerEffects' }, { _ref: 'layer', _id: l.id }], _options: { dialogOptions: 'dontDisplay' } }], { synchronousExecution: true });
    if (g && g[0] && g[0].layerEffects) fx = g[0].layerEffects;
  } catch (e) { /* start fresh */ }
}
const applied = []; const failed = [];
if (a.drop_shadow) { try {
  fx.dropShadow = { _obj: 'dropShadow', enabled: true, present: true, shown: true, mode: { _enum: 'blendMode', _value: String(a.drop_shadow.blend_mode || 'MULTIPLY').toUpperCase() }, color: rgb(a.drop_shadow.color), opacity: pc(a.drop_shadow.opacity), useGlobalAngle: false, angle: au(a.drop_shadow.angle), distance: pu(a.drop_shadow.distance), choke: pu(Math.max(a.drop_shadow.spread || 0, 0)), size: pu(Math.max(a.drop_shadow.size, 1)), noise: 0, layerConceals: true };
  applied.push('drop_shadow');
} catch (e) { failed.push('drop_shadow: ' + e); } }
if (a.inner_shadow) { try {
  fx.innerShadow = { _obj: 'innerShadow', enabled: true, present: true, shown: true, mode: { _enum: 'blendMode', _value: 'NORMAL' }, color: rgb(a.inner_shadow.color), opacity: pc(a.inner_shadow.opacity), useGlobalAngle: false, angle: au(a.inner_shadow.angle), distance: pu(a.inner_shadow.distance), choke: pu(Math.max(a.inner_shadow.choke || 0, 0)), size: pu(Math.max(a.inner_shadow.size, 1)), noise: 0 };
  applied.push('inner_shadow');
} catch (e) { failed.push('inner_shadow: ' + e); } }
if (a.outer_glow) { try {
  fx.outerGlow = { _obj: 'outerGlow', enabled: true, present: true, shown: true, mode: { _enum: 'blendMode', _value: String(a.outer_glow.blend_mode || 'SCREEN').toUpperCase() }, color: rgb(a.outer_glow.color), opacity: pc(a.outer_glow.opacity), glowTechnique: { _enum: 'glowTechnique', _value: 'softer' }, choke: pu(0), size: pu(Math.max(a.outer_glow.size, 1)), noise: 0 };
  applied.push('outer_glow');
} catch (e) { failed.push('outer_glow: ' + e); } }
if (a.stroke) { try {
  fx.frameFX = { _obj: 'frameFX', enabled: true, present: true, shown: true, mode: { _enum: 'blendMode', _value: 'NORMAL' }, color: rgb(a.stroke.color), opacity: pc(a.stroke.opacity), size: pu(a.stroke.size), position: { _enum: 'frameStrokeStyle', _value: String(a.stroke.position || 'OUTSIDE').toLowerCase() }, fillEnabled: false };
  applied.push('stroke');
} catch (e) { failed.push('stroke: ' + e); } }
if (a.color_overlay) { try {
  fx.solidFill = { _obj: 'solidFill', enabled: true, present: true, shown: true, mode: { _enum: 'blendMode', _value: String(a.color_overlay.blend_mode || 'NORMAL').toUpperCase() }, color: rgb(a.color_overlay.color), opacity: pc(a.color_overlay.opacity) };
  applied.push('color_overlay');
} catch (e) { failed.push('color_overlay: ' + e); } }
await ctx.batchPlay([{ _obj: 'set', _target: [{ _property: 'layerEffects' }, { _ref: 'layer', _id: l.id }], to: fx, _obj: 'scale', fxStyle: pc(100), useAccurateStyling: true, _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, applied, failed: failed.length ? failed : undefined };`,
        a,
        { document_id: a.document_id, name: 'Supreme: layer effects' }
      )
  );

  tool(
    'ps_adjustment',
    'Apply a pixel adjustment to a layer: brightness/contrast, hue/saturation, vibrance, photo filter, invert, desaturate, posterize or threshold. One undo step.',
    {
      layer_id: z.number().int(),
      kind: z.enum(['brightness_contrast', 'hue_saturation', 'vibrance', 'photo_filter', 'invert', 'desaturate', 'posterize', 'threshold']),
      brightness: z.number().min(-150).max(150).optional(),
      contrast: z.number().min(-150).max(150).optional(),
      hue: z.number().min(-180).max(180).optional(),
      saturation: z.number().min(-100).max(100).optional(),
      lightness: z.number().min(-100).max(100).optional(),
      colorize: z.boolean().optional(),
      vibrance: z.number().min(-100).max(100).optional(),
      filter_color: rgbObj.default({ r: 255, g: 176, b: 66 }).describe('photo_filter color (warming: 255,176,66 · cooling: 115,190,255)'),
      density: z.number().min(0).max(100).optional().describe('photo_filter strength %'),
      preserve_luminosity: z.boolean().optional().describe('photo_filter preserve luminosity (default true)'),
      levels: z.number().int().min(2).max(255).optional().describe('posterize levels'),
      level: z.number().int().min(1).max(255).optional().describe('threshold level'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
const rgb = (c) => ({ _obj: 'RGBColor', red: Math.round(c.r), grain: Math.round(c.g), blue: Math.round(c.b) });
const pc = (n) => ({ _unit: 'percentUnit', _value: n });
await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: l.id }] }], {});
let d = null;
if (a.kind === 'brightness_contrast') d = { _obj: 'brightnessEvent', brightnessLevel: a.brightness ?? 0, contrastLevel: a.contrast ?? 0, _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'hue_saturation') { const h = { _obj: 'hueSaturation', hue: a.hue ?? 0, saturation: a.saturation ?? 0, lightness: a.lightness ?? 0, _options: { dialogOptions: 'dontDisplay' } }; if (a.colorize) h.colorize = true; d = h; }
else if (a.kind === 'vibrance') d = { _obj: 'vibrance', vibrance: pc(a.vibrance ?? 0), _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'photo_filter') d = { _obj: 'photoFilter', color: rgb(a.filter_color), density: pc(a.density ?? 25), preserveLuminosity: a.preserve_luminosity !== false, _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'invert') d = { _obj: 'invert', _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'desaturate') d = { _obj: 'desaturate', _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'posterize') d = { _obj: 'posterize', levels: a.levels ?? 8, _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'threshold') d = { _obj: 'threshold', level: a.level ?? 128, _options: { dialogOptions: 'dontDisplay' } };
try {
  await ctx.batchPlay([d], {});
} catch (e) {
  // some builds want unit-wrapped integers for posterize/threshold
  if (a.kind === 'posterize') await ctx.batchPlay([{ _obj: 'posterize', levels: { _unit: 'pixelsUnit', _value: a.levels ?? 8 }, _options: { dialogOptions: 'dontDisplay' } }], {});
  else if (a.kind === 'threshold') await ctx.batchPlay([{ _obj: 'threshold', level: { _unit: 'pixelsUnit', _value: a.level ?? 128 }, _options: { dialogOptions: 'dontDisplay' } }], {});
  else throw e;
}
return { id: l.id, applied: a.kind };`,
        a,
        { document_id: a.document_id, name: 'Supreme: adjustment' }
      )
  );

  tool(
    'ps_filter',
    'Apply a destructive pixel filter to a layer: gaussian_blur, motion_blur, unsharp_mask, sharpen, sharpen_edges, add_noise, median or high_pass. Text/shape layers are auto-rasterized first (set rasterize: false to skip).',
    {
      layer_id: z.number().int(),
      kind: z.enum(['gaussian_blur', 'motion_blur', 'unsharp_mask', 'sharpen', 'sharpen_edges', 'add_noise', 'median', 'high_pass']),
      radius: z.number().min(0.1).max(1000).optional().describe('px — blur radius / unsharp radius / median / high_pass'),
      angle: z.number().optional().describe('motion_blur angle (degrees)'),
      distance: z.number().min(1).max(1999).optional().describe('motion_blur distance (px)'),
      amount: z.number().min(1).max(500).optional().describe('unsharp_mask % or add_noise %'),
      threshold: z.number().int().min(0).max(255).optional().describe('unsharp_mask threshold'),
      monochromatic: z.boolean().optional().describe('add_noise monochrome (default true)'),
      rasterize: z.boolean().default(true).describe('Auto-rasterize text/shape layers before filtering'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
const pc = (n) => ({ _unit: 'percentUnit', _value: n });
const pu = (n) => ({ _unit: 'pixelsUnit', _value: n });
const au = (n) => ({ _unit: 'angleUnit', _value: n });
let rasterized = false;
if (a.rasterize !== false && l.kind && l.kind !== 'pixelLayer') {
  await ctx.batchPlay([{ _obj: 'rasterize', _target: [{ _ref: 'layer', _id: l.id }], using: { _enum: 'rasterizeItem', _value: 'entireLayer' }, _options: { dialogOptions: 'dontDisplay' } }], {});
  rasterized = true;
}
await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: l.id }] }], {});
let d = null;
if (a.kind === 'gaussian_blur') d = { _obj: 'gaussianBlur', radius: pu(a.radius ?? 5), _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'motion_blur') d = { _obj: 'motionBlur', angle: au(a.angle ?? 0), distance: pu(a.distance ?? 30), _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'unsharp_mask') d = { _obj: 'unsharpMask', amount: pc(a.amount ?? 100), radius: pu(a.radius ?? 1), threshold: a.threshold ?? 4, _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'sharpen') d = { _obj: 'sharpen', _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'sharpen_edges') d = { _obj: 'sharpenEdges', _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'add_noise') d = { _obj: 'addNoise', amount: pc(a.amount ?? 10), gaussian: false, monochromatic: a.monochromatic !== false, _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'median') d = { _obj: 'median', radius: pu(a.radius ?? 1), _options: { dialogOptions: 'dontDisplay' } };
else if (a.kind === 'high_pass') d = { _obj: 'highPass', radius: pu(a.radius ?? 3), _options: { dialogOptions: 'dontDisplay' } };
await ctx.batchPlay([d], {});
return { id: l.id, applied: a.kind, rasterized };`,
        a,
        { document_id: a.document_id, name: 'Supreme: filter' }
      )
  );

  tool(
    'ps_edit_text',
    'Edit an EXISTING text layer: change its contents, font size (pt), font (PostScript name), color, tracking, leading (pt) or alignment — the layer stays editable. Optionally apply faux bold/italic.',
    {
      layer_id: z.number().int(),
      text: z.string().optional().describe('New text contents (\\r or \\n for line breaks)'),
      font_size: z.number().min(0.5).max(5000).optional(),
      font_postscript: z.string().optional().describe('PostScript font name, e.g. "Arial-BoldMT"'),
      color: rgbObj.optional(),
      tracking: z.number().int().min(-1000).max(10000).optional().describe('1/1000 em, 0 = normal'),
      leading: z.number().min(0.5).max(5000).optional().describe('Line height in pt (disables auto-leading)'),
      align: z.enum(['left', 'center', 'right', 'justify']).optional(),
      bold: z.boolean().optional().describe('Faux bold on/off'),
      italic: z.boolean().optional().describe('Faux italic on/off'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
if (l.kind !== 'textLayer') throw new Error('Layer ' + l.id + ' is not a text layer (kind: ' + l.kind + ') — create one with ps_create_text_layer');
const applied = []; const failed = [];
if (a.text != null) { try { l.textItem.contents = a.text; applied.push('text'); } catch (e) { failed.push('text: ' + e); } }
if (a.font_size != null) { try { l.textItem.size = a.font_size; applied.push('font_size'); } catch (e) { failed.push('font_size: ' + e); } }
if (a.font_postscript) { try { l.textItem.font = a.font_postscript; applied.push('font'); } catch (e) { failed.push('font: ' + e); } }
let len = 0; try { len = String(l.textItem.contents).length; } catch (e) { len = 0; }
const style = {};
if (a.color) style.color = { _obj: 'RGBColor', red: Math.round(a.color.r), grain: Math.round(a.color.g), blue: Math.round(a.color.b) };
if (a.tracking != null) style.tracking = a.tracking;
if (a.leading != null) { style.autoLeading = false; style.useAutoLeading = false; style.leading = { _unit: 'pointsUnit', _value: a.leading }; }
if (a.bold != null) style.syntheticBold = a.bold;
if (a.italic != null) style.syntheticItalic = a.italic;
if (Object.keys(style).length) {
  try {
    await ctx.batchPlay([{ _obj: 'set', _target: [{ _property: 'textStyleRange' }, { _ref: 'layer', _id: l.id }], to: [{ _obj: 'textStyleRange', from: 0, to: Math.max(len - 1, 0), textStyle: { _obj: 'textStyle', ...style } }], _options: { dialogOptions: 'dontDisplay' } }], {});
    applied.push('style');
  } catch (e) { failed.push('style: ' + e); }
}
if (a.align) {
  try {
    await ctx.batchPlay([{ _obj: 'set', _target: [{ _property: 'paragraphStyleRange' }, { _ref: 'layer', _id: l.id }], to: [{ _obj: 'paragraphStyleRange', from: 0, to: Math.max(len - 1, 0), paragraphStyle: { _obj: 'paragraphStyle', alignment: { _enum: 'alignment', _value: a.align } } }], _options: { dialogOptions: 'dontDisplay' } }], {});
    applied.push('align');
  } catch (e) { failed.push('align: ' + e); }
}
if (!applied.length) throw new Error('Nothing applied: ' + failed.join('; '));
let contents = null; try { contents = String(l.textItem.contents).slice(0, 200); } catch (e) { /* ignore */ }
return { id: l.id, applied, failed: failed.length ? failed : undefined, contents };`,
        a,
        { document_id: a.document_id, name: 'Supreme: edit text' }
      )
  );

  tool(
    'ps_reorder_layer',
    'Move a layer in the stacking order: to the very front, the very back, one step forward/backward — or place it INSIDE a group (top of that group).',
    {
      layer_id: z.number().int(),
      position: z.enum(['front', 'back', 'forward', 'backward', 'into_group']),
      group_id: z.number().int().optional().describe('Target group for position "into_group"'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
if (a.position === 'into_group') {
  const g = ctx.layer(a.group_id);
  await l.move(g, ctx.constants.ElementPlacement.PLACEATBEGINNING);
  return { id: l.id, name: l.name, moved_into: a.group_id };
}
const v = { front: 'front', back: 'back', forward: 'forward', backward: 'backward' }[a.position];
await ctx.batchPlay([{ _obj: 'move', _target: [{ _ref: 'layer', _id: l.id }], to: { _ref: 'layer', _enum: 'ordinal', _value: v }, _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, name: l.name, position: a.position };`,
        a,
        { document_id: a.document_id, name: 'Supreme: reorder' }
      )
  );

  tool(
    'ps_group_layers',
    'Group several existing layers into one new layer group (kept in their current stacking order).',
    { layer_ids: z.array(z.number().int()).min(1), name: z.string().default('Group'), document_id: docId },
    (a) =>
      js(
        `const ids = ctx.args.layer_ids;
await ctx.batchPlay([{ _obj: 'select', _target: ids.map((id) => ({ _ref: 'layer', _id: id })), makeVisible: false, layerID: ids, _options: { dialogOptions: 'dontDisplay' } }], {});
await ctx.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layerSection' }], from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }, name: ctx.args.name || 'Group', _options: { dialogOptions: 'dontDisplay' } }], {});
const g = ctx.doc.activeLayers[0];
return { id: g.id, name: g.name, members: ids.length };`,
        a,
        { document_id: a.document_id, name: 'Supreme: group layers' }
      )
  );

  tool('ps_smart_object', 'Convert a layer into a smart object (non-destructive scaling/filters).', { layer_id: z.number().int(), document_id: docId }, (a) =>
    js(
      `const l = ctx.layer(ctx.args.layer_id);
await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: l.id }] }], {});
await ctx.batchPlay([{ _obj: 'newPlacedLayer', _options: { dialogOptions: 'dontDisplay' } }], {});
const so = ctx.doc.activeLayers[0];
return { id: so.id, name: so.name, smart_object: true };`,
      a,
      { document_id: a.document_id, name: 'Supreme: smart object' }
    )
  );

  tool(
    'ps_rasterize',
    'Rasterize a layer (entire layer by default, or just its vector mask / type / shape / fill) so pixel filters and painting work on it.',
    {
      layer_id: z.number().int(),
      what: z.enum(['entireLayer', 'vectorMask', 'textContents', 'shape', 'layerContent']).default('entireLayer'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id);
await ctx.batchPlay([{ _obj: 'rasterize', _target: [{ _ref: 'layer', _id: l.id }], using: { _enum: 'rasterizeItem', _value: ctx.args.what || 'entireLayer' }, _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, name: l.name, rasterized: ctx.args.what || 'entireLayer' };`,
        a,
        { document_id: a.document_id, name: 'Supreme: rasterize' }
      )
  );

  tool(
    'ps_create_fill_layer',
    'Create a non-destructive FILL layer covering the whole canvas: solid color or linear/radial gradient with custom stops. Optional opacity, blend mode, and clip_to_below to clip it to the layer beneath.',
    {
      kind: z.enum(['solid', 'gradient']),
      name: z.string().optional(),
      color: rgbObj.default({ r: 255, g: 0, b: 0 }),
      stops: z.array(z.object({ pos: z.number().min(0).max(100), color: rgbObj, alpha: z.number().min(0).max(1).default(1) })).optional().describe('Gradient stops, pos in % (needs at least 2)'),
      gradient_type: z.enum(['linear', 'radial']).default('linear'),
      angle: z.number().default(90).describe('Photoshop gradient angle in degrees (90 = top to bottom)'),
      opacity: z.number().min(0).max(100).optional(),
      blend_mode: z.string().optional(),
      clip_to_below: z.boolean().default(false).describe('Clip the fill layer to the layer below (clipping mask)'),
      document_id: docId,
    },
    (a) =>
      js(
        `const a = ctx.args;
const rgb = (c) => ({ _obj: 'RGBColor', red: Math.round(c.r), grain: Math.round(c.g), blue: Math.round(c.b) });
const pc = (n) => ({ _unit: 'percentUnit', _value: n });
const au = (n) => ({ _unit: 'angleUnit', _value: n });
let type;
if (a.kind === 'gradient') {
  const stops = (a.stops && a.stops.length >= 2 ? a.stops : [{ pos: 0, color: a.color, alpha: 1 }, { pos: 100, color: { r: 255, g: 255, b: 255 }, alpha: 1 }]).slice().sort((x, y) => x.pos - y.pos);
  type = { _obj: 'gradientLayer', type: { _enum: 'gradientType', _value: a.gradient_type === 'radial' ? 'radial' : 'linear' }, angle: au(a.angle == null ? 90 : a.angle), scale: pc(100), gradient: { _obj: 'gradientClassEvent', name: 'Supreme Fill', gradientForm: { _enum: 'gradientForm', _value: 'customEnum' }, interfaceIconFrameDimmed: 4096, colors: stops.map((st) => ({ _obj: 'colorStop', color: rgb(st.color), type: { _enum: 'colorStopType', _value: 'userStop' }, location: Math.round(st.pos / 100 * 4096), midpoint: 50 })), transparent: stops.map((st) => ({ _obj: 'transferSpec', opacity: pc(Math.round((st.alpha == null ? 1 : st.alpha) * 100)), location: Math.round(st.pos / 100 * 4096), midpoint: 50 })) } };
} else {
  type = { _obj: 'solidColorLayer', color: rgb(a.color) };
}
await ctx.batchPlay([{ _obj: 'make', _target: [{ _ref: 'contentLayer' }], using: { _obj: 'contentLayer', type, _options: { dialogOptions: 'dontDisplay' } } }], {});
const fl = ctx.doc.activeLayers[0];
if (a.name) try { fl.name = a.name; } catch (e) { /* ignore */ }
if (a.opacity != null) try { fl.opacity = a.opacity; } catch (e) { /* ignore */ }
if (a.blend_mode) try { fl.blendMode = ctx.constants.BlendMode[String(a.blend_mode).toUpperCase()] || fl.blendMode; } catch (e) { /* ignore */ }
if (a.clip_to_below) await ctx.batchPlay([{ _obj: 'groupEvent', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: fl.id, name: fl.name, kind: a.kind };`,
        a,
        { document_id: a.document_id, name: 'Supreme: fill layer' }
      )
  );

  tool(
    'ps_crop_document',
    'Crop the document to a rectangle (px). Destructive outside the rect.',
    { left: z.number(), top: z.number(), right: z.number(), bottom: z.number(), document_id: docId },
    (a) =>
      js(
        `if (!ctx.doc) throw new Error('No document');
const a = ctx.args;
await ctx.doc.crop({ left: a.left, top: a.top, right: a.right, bottom: a.bottom });
return { cropped: { left: a.left, top: a.top, right: a.right, bottom: a.bottom } };`,
        a,
        { document_id: a.document_id, name: 'Supreme: crop' }
      )
  );

  tool(
    'ps_resize_canvas',
    'Resize the document CANVAS (px) without scaling the artwork — anchor says which corner/edge stays put.',
    {
      width: z.number().int().min(1).max(300000),
      height: z.number().int().min(1).max(300000),
      anchor: z.enum(['TOPLEFT', 'TOPCENTER', 'TOPRIGHT', 'MIDDLELEFT', 'MIDDLECENTER', 'MIDDLERIGHT', 'BOTTOMLEFT', 'BOTTOMCENTER', 'BOTTOMRIGHT']).default('MIDDLECENTER'),
      document_id: docId,
    },
    (a) =>
      js(
        `if (!ctx.doc) throw new Error('No document');
const a = ctx.args;
const anchor = (ctx.constants.AnchorPosition && ctx.constants.AnchorPosition[String(a.anchor || 'MIDDLECENTER')]) || undefined;
await ctx.doc.resizeCanvas(a.width, a.height, anchor);
return { canvas: a.width + 'x' + a.height, anchor: a.anchor };`,
        a,
        { document_id: a.document_id, name: 'Supreme: canvas size' }
      )
  );

  tool(
    'ps_resize_image',
    'Scale the whole document IMAGE (px, or percentage) and/or its resolution (ppi). Bicubic resampling.',
    {
      width: z.number().int().min(1).max(300000).optional(),
      height: z.number().int().min(1).max(300000).optional(),
      percentage: z.number().min(0.1).max(1000).optional().describe('Scale both sides by this % (overrides width/height)'),
      resolution: z.number().min(1).max(10000).optional().describe('New resolution in ppi'),
      document_id: docId,
    },
    (a) =>
      js(
        `if (!ctx.doc) throw new Error('No document');
const a = ctx.args;
if (a.width == null && a.height == null && a.percentage == null && a.resolution == null) throw new Error('Provide width/height, percentage and/or resolution');
const px = (v) => { try { return (v && typeof v === 'object' && v.as) ? v.as('px') : Number(v); } catch (e) { return Number(v); } };
const cw = px(ctx.doc.width); const ch = px(ctx.doc.height);
let w = a.width; let h = a.height;
if (a.percentage != null) { w = cw * a.percentage / 100; h = ch * a.percentage / 100; }
const resample = (ctx.constants.ResampleMethod && ctx.constants.ResampleMethod.BICUBIC) || undefined;
await ctx.doc.resizeImage(w, h, a.resolution, resample);
return { resized: { width: w ?? cw, height: h ?? ch, resolution: a.resolution ?? null } };`,
        a,
        { document_id: a.document_id, name: 'Supreme: image size' }
      )
  );

  // ================================================== detect everything
  tool(
    'ps_list_fonts',
    'List every font installed in Photoshop (postScript name, family, style). Use it to pick a valid font_postscript for text tools before creating text layers.',
    { filter: z.string().optional().describe('Case-insensitive substring on family or PostScript name') },
    async (a) => {
      const r: any = await bridge.call('fonts', {}, 30_000);
      if (a.filter) {
        const q = String(a.filter).toLowerCase();
        const fonts = (r.fonts ?? []).filter((f: any) => `${f.family ?? ''} ${f.postScriptName ?? ''}`.toLowerCase().includes(q));
        return { count: fonts.length, families: [...new Set(fonts.map((f: any) => f.family).filter(Boolean))].sort(), fonts };
      }
      return r;
    }
  );

  tool(
    'ps_describe_layer',
    'DEEP inspection of one layer — everything Photoshop knows about it: DOM properties (bounds/opacity/blend/effects), text item (contents, font, size, color, tracking) and the RAW batchPlay descriptor (fills, gradients, layer effects, smart object info, masks). Use it to detect exactly what a layer is before editing it.',
    { layer_id: z.number().int(), document_id: docId },
    (a) => bridge.call('describe_layer', a, 30_000)
  );

  tool(
    'ps_get_history',
    'List the document history states (undo timeline) with the active one marked. Combine with ps_goto_history to time-travel.',
    { document_id: docId },
    (a) => bridge.call('history', a)
  );

  tool(
    'ps_goto_history',
    'Jump to a history state by name (from ps_get_history) or index — time-travel without repeated undo.',
    { name: z.string().optional(), index: z.number().int().optional(), document_id: docId },
    (a) => bridge.call('goto_history', a)
  );

  tool('ps_get_colors', 'Read the current foreground and background colors (r/g/b + hex).', {}, () => bridge.call('colors'));

  tool(
    'ps_set_colors',
    'Set the foreground and/or background color (r/g/b). Paint tools, gradients and fills use these.',
    { foreground: rgbObj.optional(), background: rgbObj.optional() },
    (a) => bridge.call('set_colors', a)
  );

  // ================================================== control everything
  tool(
    'ps_export_layer',
    'Export ONE layer as its own PNG/JPG file: the layer is isolated in a temporary copy (everything else hidden), trimmed to its pixels and saved to an absolute path. The original document is untouched.',
    {
      layer_id: z.number().int(),
      path: z.string().describe('Absolute destination path, extension .png or .jpg'),
      quality: z.number().int().min(1).max(12).default(10).describe('JPG quality'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
const p = a.path.replace(/\\\\/g, '/');
const ext = p.split('.').pop().toLowerCase();
if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg') throw new Error('Use a .png or .jpg path');
const cands = p.startsWith('/') ? ['file:' + p] : ['file:/' + p, 'file:' + p];
let entry = null, err = null;
for (const u of cands) { try { entry = await ctx.fs.createEntryWithUrl(u, { overwrite: true }); break; } catch (e) { err = e; } }
if (!entry) throw err;
const dup = await ctx.doc.duplicate('supreme-export', false);
try {
  const keep = new Set();
  (function pathTo(layers, id, trail) {
    for (const ly of layers) {
      if (ly.id === id) { trail.forEach((x) => keep.add(x)); keep.add(id); return true; }
      if (ly.layers && ly.layers.length && pathTo(ly.layers, id, trail.concat(ly.id))) return true;
    }
    return false;
  })(dup.layers, l.id, []);
  (function setVis(layers) { for (const ly of layers) { ly.visible = keep.has(ly.id); if (ly.layers && ly.layers.length) setVis(ly.layers); } })(dup.layers);
  await dup.flatten();
  await ctx.batchPlay([{ _obj: 'trim', trimBasedOn: { _enum: 'trimBasedOn', _value: 'transparency' }, top: true, bottom: true, left: true, right: true, _options: { dialogOptions: 'dontDisplay' } }], {});
  if (ext === 'png') await dup.saveAs.png(entry, {}, true);
  else await dup.saveAs.jpg(entry, { quality: a.quality }, true);
} finally {
  await dup.closeWithoutSaving();
  try { ctx.app.activeDocument = ctx.doc; } catch (e) { /* ignore */ }
}
return { exported: a.path, layer: l.name };`,
        a,
        { document_id: a.document_id, name: 'Supreme: export layer' }
      )
  );

  tool(
    'ps_merge_layers',
    'Merge several layers into one pixel layer (one undo step), or flatten the whole document with flatten: true.',
    { layer_ids: z.array(z.number().int()).min(1).optional(), flatten: z.boolean().default(false), document_id: docId },
    (a) =>
      js(
        `const a = ctx.args;
if (a.flatten) { await ctx.doc.flatten(); return { flattened: true, id: ctx.doc.activeLayers[0] && ctx.doc.activeLayers[0].id }; }
const ids = a.layer_ids;
await ctx.batchPlay([{ _obj: 'select', _target: ids.map((id) => ({ _ref: 'layer', _id: id })), makeVisible: false, layerID: ids, _options: { dialogOptions: 'dontDisplay' } }], {});
await ctx.batchPlay([{ _obj: 'mergeLayers', _options: { dialogOptions: 'dontDisplay' } }], {});
const m = ctx.doc.activeLayers[0];
return { merged: ids.length, id: m && m.id, name: m && m.name };`,
        a,
        { document_id: a.document_id, name: 'Supreme: merge layers' }
      )
  );

  tool(
    'ps_align_layer',
    'Align a layer to the canvas edges/center or to another layer (horizontal AND/OR vertical), by computing exact offsets — works on any layer kind, including groups.',
    {
      layer_id: z.number().int(),
      horizontal: z.enum(['left', 'center', 'right']).optional(),
      vertical: z.enum(['top', 'middle', 'bottom']).optional(),
      to_layer_id: z.number().int().optional().describe('Align relative to this layer instead of the canvas'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
if (!a.horizontal && !a.vertical) throw new Error('Give horizontal and/or vertical alignment');
const ref = a.to_layer_id != null ? ctx.layer(a.to_layer_id) : null;
const rb = ref ? ref.bounds : { left: 0, top: 0, right: ctx.doc.width, bottom: ctx.doc.height };
const b = l.bounds;
const dx = a.horizontal === 'left' ? rb.left - b.left : a.horizontal === 'right' ? rb.right - b.right : a.horizontal === 'center' ? (rb.left + rb.right) / 2 - (b.left + b.right) / 2 : 0;
const dy = a.vertical === 'top' ? rb.top - b.top : a.vertical === 'bottom' ? rb.bottom - b.bottom : a.vertical === 'middle' ? (rb.top + rb.bottom) / 2 - (b.top + b.bottom) / 2 : 0;
if (dx || dy) await l.translate(dx, dy);
const b2 = l.bounds;
return { id: l.id, moved: { dx, dy }, bounds: { left: b2.left, top: b2.top, right: b2.right, bottom: b2.bottom } };`,
        a,
        { document_id: a.document_id, name: 'Supreme: align' }
      )
  );

  tool(
    'ps_flip_layer',
    'Flip a layer horizontally or vertically around its own center.',
    { layer_id: z.number().int(), axis: z.enum(['horizontal', 'vertical']), document_id: docId },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id);
await ctx.batchPlay([{ _obj: 'flip', _target: [{ _ref: 'layer', _id: l.id }], axis: { _enum: 'orientation', _value: ctx.args.axis }, _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, flipped: ctx.args.axis };`,
        a,
        { document_id: a.document_id, name: 'Supreme: flip' }
      )
  );

  tool(
    'ps_add_mask',
    'Add a layer mask: reveal all (transparent mask to paint into), hide all, or reveal the current selection (rounded corners, cutouts). Pair with ps_select for custom shapes.',
    { layer_id: z.number().int(), mode: z.enum(['reveal_all', 'hide_all', 'from_selection']).default('reveal_all'), document_id: docId },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: l.id }] }], {});
const using = { _enum: 'userMaskEnabled', _value: a.mode === 'hide_all' ? 'hideAll' : a.mode === 'from_selection' ? 'revealSelection' : 'revealAll' };
await ctx.batchPlay([{ _obj: 'make', _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }], using, _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, mask: a.mode };`,
        a,
        { document_id: a.document_id, name: 'Supreme: layer mask' }
      )
  );

  tool(
    'ps_set_clipping',
    'Clip a layer to the one below (clipping mask — Layer > Create Clipping Mask) or release it.',
    { layer_id: z.number().int(), clip: z.boolean().default(true), document_id: docId },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id);
await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: l.id }] }], {});
await ctx.batchPlay([{ _obj: ctx.args.clip ? 'groupEvent' : 'ungroupEvent', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, clipped: ctx.args.clip };`,
        a,
        { document_id: a.document_id, name: 'Supreme: clipping mask' }
      )
  );

  tool(
    'ps_set_shape_fill',
    'Change the fill of an EXISTING shape/fill layer: a solid RGB color, or a linear/radial gradient with custom stops. The shape keeps its geometry, stroke and effects.',
    {
      layer_id: z.number().int(),
      color: rgbObj.optional().describe('Solid fill color'),
      stops: z.array(z.object({ pos: z.number().min(0).max(100), color: rgbObj, alpha: z.number().min(0).max(1).default(1) })).optional().describe('Gradient stops (needs at least 2) — overrides color'),
      gradient_type: z.enum(['linear', 'radial']).default('linear'),
      angle: z.number().default(90).describe('Gradient angle (90 = top to bottom)'),
      document_id: docId,
    },
    (a) =>
      js(
        `const l = ctx.layer(ctx.args.layer_id); const a = ctx.args;
const rgb = (c) => ({ _obj: 'RGBColor', red: Math.round(c.r), grain: Math.round(c.g), blue: Math.round(c.b) });
const pc = (n) => ({ _unit: 'percentUnit', _value: n });
const au = (n) => ({ _unit: 'angleUnit', _value: n });
let to;
if (a.stops && a.stops.length >= 2) {
  const stops = a.stops.slice().sort((x, y) => x.pos - y.pos);
  to = { _obj: 'gradientLayer', type: { _enum: 'gradientType', _value: a.gradient_type === 'radial' ? 'radial' : 'linear' }, angle: au(a.angle == null ? 90 : a.angle), scale: pc(100), gradient: { _obj: 'gradientClassEvent', name: 'Supreme Fill', gradientForm: { _enum: 'gradientForm', _value: 'customEnum' }, interfaceIconFrameDimmed: 4096, colors: stops.map((st) => ({ _obj: 'colorStop', color: rgb(st.color), type: { _enum: 'colorStopType', _value: 'userStop' }, location: Math.round(st.pos / 100 * 4096), midpoint: 50 })), transparent: stops.map((st) => ({ _obj: 'transferSpec', opacity: pc(Math.round((st.alpha == null ? 1 : st.alpha) * 100)), location: Math.round(st.pos / 100 * 4096), midpoint: 50 })) } };
} else if (a.color) {
  to = { _obj: 'solidColorLayer', color: rgb(a.color) };
} else {
  throw new Error('Provide color or stops');
}
await ctx.batchPlay([{ _obj: 'set', _target: [{ _property: 'adjustment' }, { _ref: 'layer', _id: l.id }], to, _options: { dialogOptions: 'dontDisplay' } }], {});
return { id: l.id, fill: a.stops && a.stops.length >= 2 ? a.gradient_type + '-gradient' : 'solid' };`,
        a,
        { document_id: a.document_id, name: 'Supreme: shape fill' }
      )
  );

  registerExtras({ tool, js, bridge, docId });
}
