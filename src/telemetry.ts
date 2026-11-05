import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

export interface CallEntry {
  id: number;
  ts: number;
  source: string; // 'stdio' | 'http' | 'dashboard'
  client: string;
  tool: string;
  ms: number;
  ok: boolean;
  error?: string;
  hint?: string;
  detail?: string;
  args?: string;
}
export interface Stat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  lastTs: number;
}

/** Turn a raw error into "what to do about it". */
export function hintFor(msg: string): string | undefined {
  const m = msg.toLowerCase();
  if (m.includes('plugin is not connected') || m.includes('not connected'))
    return 'Photoshop plugin is not connected. Start (or restart) Photoshop - the plugin loads at startup. Check Overview and run the self-test.';
  if (m.includes('disconnected mid-call')) return 'Photoshop closed or the plugin reloaded during the call. Retry once Photoshop is back.';
  if (m.includes('code generation') || m.includes('evalerror') || m.includes('unsafe-eval') || m.includes('allowcodegeneration'))
    return 'The plugin manifest must allow code from strings (allowCodeGenerationFromStrings). Re-run the installer to get plugin v0.3.0++.';
  if (m.includes('newdocumentfill') || m.includes("'transparent'") || m.includes("'white'"))
    return "This Photoshop build's installed plugin predates the version-safe document creator (fixed in plugin v0.9.0). Re-run the latest PhotoshopSupremeMCP-Setup.exe — it refreshes the plugin — then restart Photoshop.";
  if (m.includes('did not respond') || m.includes('timeout') || m.includes('timed out'))
    return 'Photoshop did not answer in time. A dialog may be open, or the job is long - close dialogs or raise timeout_ms.';
  if (m.includes('modal') && (m.includes('already') || m.includes('state')))
    return 'Photoshop is busy in another modal operation or has a dialog open. Close it and retry.';
  if (m.includes('no active document') || m.includes('no document'))
    return 'No document is open. Use ps_new_document or ps_open_document first.';
  if (m.includes('no open document with id')) return 'That document id is stale. Call ps_get_state for current ids.';
  if (/layer \d+ not found/.test(m)) return 'Layer ids change between sessions/edits. Call ps_get_state for current layer ids.';
  if (m.includes('unauthorized')) return 'Missing/incorrect bearer token. Token file: ~/.photoshop-supreme-mcp/token';
  if (m.includes('unrecognized image') || m.includes('provide exactly one of'))
    return 'ps_place_image needs exactly one of path, url or base64 containing a real image (png, jpg, gif, webp, psd, bmp, tif).';
  if (m.includes('extendscript') && m.includes('windows')) return 'ps_run_extendscript is Windows-only; use ps_run_uxp or ps_batch_play elsewhere.';
  if (m.includes('enoent') || m.includes('not found') || m.includes('cannot find'))
    return 'A file or object was not found. Check the path/name (use absolute paths).';
  return undefined;
}

/** Compact, safe-to-store summary of tool arguments (long strings such as base64 / code are truncated). */
export function summarizeArgs(a: unknown, max = 240): string {
  try {
    const s = JSON.stringify(a, (_k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 60) + `…(${v.length} chars)` : v));
    return (s ?? '').slice(0, max);
  } catch {
    return '';
  }
}

const bump = (m: Map<string, Stat>, name: string, ms: number, ok: boolean, ts: number) => {
  const s = m.get(name) ?? { name, calls: 0, errors: 0, totalMs: 0, lastTs: 0 };
  s.calls++;
  if (!ok) s.errors++;
  s.totalMs += ms;
  s.lastTs = ts;
  m.set(name, s);
};

export class Telemetry {
  readonly startedAt = Date.now();
  private entries: CallEntry[] = [];
  private seq = 0;
  private tools = new Map<string, Stat>();
  private clients = new Map<string, Stat>();
  private minutes = new Map<number, { calls: number; errors: number }>();
  private conn: { ts: number; type: string; detail?: string }[] = [];
  private logFile = join(DATA_DIR, 'calls.jsonl');
  private writes = 0;
  private total = { calls: 0, errors: 0, totalMs: 0 };

  constructor(private readonly max = 500) {}

  record(e: Omit<CallEntry, 'id' | 'ts'>): CallEntry {
    const entry: CallEntry = { ...e, id: ++this.seq, ts: Date.now() };
    if (entry.error && !entry.hint) entry.hint = hintFor(entry.error);
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.total.calls++;
    if (!entry.ok) this.total.errors++;
    this.total.totalMs += entry.ms;
    bump(this.tools, entry.tool, entry.ms, entry.ok, entry.ts);
    bump(this.clients, entry.client, entry.ms, entry.ok, entry.ts);
    const minute = Math.floor(entry.ts / 60000);
    const mm = this.minutes.get(minute) ?? { calls: 0, errors: 0 };
    mm.calls++;
    if (!entry.ok) mm.errors++;
    this.minutes.set(minute, mm);
    for (const k of this.minutes.keys()) if (k < minute - 180) this.minutes.delete(k);
    void this.persist(entry);
    return entry;
  }

  connection(type: string, detail?: string): void {
    this.conn.push({ ts: Date.now(), type, detail });
    if (this.conn.length > 50) this.conn.shift();
  }

  clear(): void {
    this.entries = [];
    this.tools.clear();
    this.clients.clear();
    this.minutes.clear();
    this.total = { calls: 0, errors: 0, totalMs: 0 };
  }

  private async persist(e: CallEntry): Promise<void> {
    try {
      if (this.writes++ === 0) await mkdir(DATA_DIR, { recursive: true });
      if (this.writes % 200 === 1) {
        const st = await stat(this.logFile).catch(() => null);
        if (st && st.size > 5 * 1024 * 1024) await rename(this.logFile, this.logFile + '.1');
      }
      await appendFile(this.logFile, JSON.stringify(e) + '\n');
    } catch {
      /* audit log is best-effort */
    }
  }

  snapshot() {
    const recent = this.entries.slice(-200);
    const lat = recent.map((e) => e.ms).sort((a, b) => a - b);
    const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0;
    const nowMin = Math.floor(Date.now() / 60000);
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const m = this.minutes.get(nowMin - i);
      series.push({ t: (nowMin - i) * 60000, calls: m?.calls ?? 0, errors: m?.errors ?? 0 });
    }
    const list = (m: Map<string, Stat>) =>
      [...m.values()]
        .sort((a, b) => b.calls - a.calls)
        .map((s) => ({ name: s.name, calls: s.calls, errors: s.errors, avgMs: Math.round(s.totalMs / Math.max(1, s.calls)), lastTs: s.lastTs }));
    return {
      uptimeMs: Date.now() - this.startedAt,
      summary: {
        total: this.total.calls,
        errors: this.total.errors,
        ok: this.total.calls - this.total.errors,
        avgMs: Math.round(this.total.totalMs / Math.max(1, this.total.calls)),
        p95Ms: p95,
        lastTs: this.entries.at(-1)?.ts ?? 0,
      },
      series,
      byTool: list(this.tools),
      byClient: list(this.clients),
      calls: [...recent].reverse(),
      errors: this.entries.filter((e) => !e.ok).slice(-50).reverse(),
      conn: [...this.conn].reverse().slice(0, 30),
    };
  }
}
