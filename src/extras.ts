import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { RECIPES } from './cookbook.js';
import { runExtendScript } from './extendscript.js';
import { deleteScript, listScripts, loadScript, saveScript } from './scripts.js';

type Shape = Record<string, z.ZodTypeAny>;
export type ToolFn = (
  name: string,
  description: string,
  shape: Shape,
  handler: (a: any) => Promise<unknown>,
  opts?: { full?: boolean }
) => void;

interface Deps {
  tool: ToolFn;
  js: (code: string, args?: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown>;
  bridge: Bridge;
  docId: z.ZodTypeAny;
}

export function registerExtras({ tool, js, bridge, docId }: Deps): void {
  // ------------------------------------------------------------ discovery
  tool(
    'ps_inspect',
    'Discover the Photoshop API at runtime. Evaluates a JS expression in Photoshop and returns the object\'s type, properties (with current values) and methods. Start with "app", "app.activeDocument", "app.activeDocument.activeLayers[0]", "ctx.constants", "require(\'photoshop\').core". Use it to find what exists before writing ps_run_uxp code.',
    {
      expr: z.string().describe('JS expression; available names: app, core, action, constants, doc, uxp, fs, storage'),
      max_props: z.number().int().min(10).max(1000).default(200),
      document_id: docId as z.ZodTypeAny,
    },
    (a) => bridge.call('inspect', a),
    { full: true }
  );

  tool(
    'ps_cookbook',
    'Ready-made Photoshop recipes (raw descriptors / UXP snippets) and the method for doing anything Photoshop can do. Call with no topic to list; pass a topic id or keyword to get the full recipe. Recipes are starting points — verify with ps_record_start/ps_record_stop if one is rejected.',
    { topic: z.string().optional().describe('Recipe id or keyword') },
    async (a) => {
      if (!a.topic) return RECIPES.map((r) => ({ id: r.id, title: r.title }));
      const t = String(a.topic).toLowerCase();
      const hits = RECIPES.filter((r) => r.id === t || (r.id + ' ' + r.title + ' ' + r.description).toLowerCase().includes(t));
      if (!hits.length) return { error: `No recipe matches "${a.topic}"`, available: RECIPES.map((r) => r.id) };
      return hits;
    }
  );

  // --------------------------------------------------------- safety net
  tool(
    'ps_snapshot',
    'Create or restore a named history snapshot — a safety net before risky experiments. action "create" saves the current state; "restore" returns the document to it.',
    { action: z.enum(['create', 'restore']), name: z.string().min(1), document_id: docId as z.ZodTypeAny },
    (a) =>
      js(
        `if (ctx.args.action === 'create') {
  await ctx.batchPlay([{ _obj: 'make', _target: [{ _ref: 'snapshotClass' }], from: { _ref: 'historyState', _property: 'currentHistoryState' }, name: ctx.args.name, using: { _enum: 'historyState', _value: 'fullDocument' }, _options: { dialogOptions: 'dontDisplay' } }], {});
} else {
  await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'snapshotClass', _name: ctx.args.name }], _options: { dialogOptions: 'dontDisplay' } }], {});
}
return { snapshot: ctx.args.name, action: ctx.args.action };`,
        a,
        { document_id: a.document_id, single_history: false, name: 'Supreme: snapshot' }
      )
  );

  tool(
    'ps_play_action',
    'Play a Photoshop Action (from the Actions panel) by set and action name — unlocks anything you or your studio already recorded.',
    { set: z.string(), action: z.string(), document_id: docId as z.ZodTypeAny },
    (a) =>
      js(
        `await ctx.batchPlay([{ _obj: 'play', _target: [{ _ref: 'action', _name: ctx.args.action }, { _ref: 'actionSet', _name: ctx.args.set }], _options: { dialogOptions: 'dontDisplay' } }], {});
return { played: ctx.args.set + ' / ' + ctx.args.action };`,
        a,
        { document_id: a.document_id, name: 'Supreme: play action' }
      )
  );

  // ------------------------------------------------------ legacy scripting
  tool(
    'ps_run_extendscript',
    'Run ExtendScript (classic Photoshop JSX) via COM — for legacy-only features and anything the UXP DOM lacks. Windows only; launches Photoshop if it is not running. The value of the last expression is returned as a string. Optional `args` is exposed as the JS variable `args`. WARNING: ExtendScript can run system commands — only use with trusted prompts.',
    {
      code: z.string(),
      args: z.record(z.any()).optional(),
      timeout_ms: z.number().int().min(1000).max(900000).default(120000),
    },
    async (a) => ({ result: await runExtendScript(a.code, a.args, a.timeout_ms) }),
    { full: true }
  );

  // ----------------------------------------------------- script library
  tool(
    'ps_save_script',
    'Save a working UXP script under a name so it can be re-run later with ps_run_script (even in future sessions). Build up your own library of Photoshop abilities. Code has the same form as ps_run_uxp (async function body using ctx.*).',
    {
      name: z.string().describe('lowercase letters, digits, - or _'),
      description: z.string().describe('What it does and which ctx.args it expects'),
      code: z.string(),
      read_only: z.boolean().default(false),
    },
    async (a) => {
      await saveScript({ name: a.name, description: a.description, code: a.code, read_only: a.read_only });
      return { saved: a.name };
    },
    { full: true }
  );
  tool('ps_list_scripts', 'List saved scripts.', {}, () => listScripts(), { full: true });
  tool(
    'ps_run_script',
    'Run a saved script by name.',
    { name: z.string(), args: z.record(z.any()).optional(), document_id: docId as z.ZodTypeAny },
    async (a) => {
      const s = await loadScript(a.name);
      return js(s.code, a.args ?? {}, { document_id: a.document_id, read_only: s.read_only, name: 'Supreme: ' + s.name });
    },
    { full: true }
  );
  tool('ps_delete_script', 'Delete a saved script.', { name: z.string() }, async (a) => {
    await deleteScript(a.name);
    return { deleted: a.name };
  }, { full: true });
}
