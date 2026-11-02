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
const modes = { RGB: c.NewDocumentMode.RGB, CMYK: c.NewDocumentMode.CMYK, Grayscale: c.NewDocumentMode.GRAYSCALE };
const fills = { white: c.NewDocumentFill.WHITE, transparent: c.NewDocumentFill.TRANSPARENT, background: c.NewDocumentFill.BACKGROUNDCOLOR };
const d = await ctx.app.documents.add({ title: ctx.args.name, width: ctx.args.width, height: ctx.args.height, resolution: ctx.args.resolution, mode: modes[ctx.args.mode], fill: fills[ctx.args.fill] });
return { id: d.id, title: d.title };`,
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
    'Move / scale / rotate a layer. dx, dy in px; scale_x, scale_y in percent (100 = unchanged); rotate in degrees.',
    {
      layer_id: z.number().int(),
      dx: z.number().default(0),
      dy: z.number().default(0),
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

  registerExtras({ tool, js, bridge, docId });
}
