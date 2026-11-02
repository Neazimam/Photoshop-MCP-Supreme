import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { log } from './log.js';

export interface BridgeEvent {
  ts: number;
  event: string;
  descriptor: unknown;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** What tools need from a bridge — implemented in-process (PhotoshopBridge) or via the daemon (RemoteBridge). */
export interface Bridge {
  readonly port: number;
  call<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  status(): Promise<{ connected: boolean; pluginInfo: Record<string, unknown> | null }>;
  drainEvents(opts?: { since?: number; filter?: string; clear?: boolean }): Promise<BridgeEvent[]>;
}

export class NotConnectedError extends Error {
  constructor() {
    super(
      'Photoshop plugin is not connected. In Photoshop open Plugins → Photoshop Supreme MCP ' +
        '(load it with the UXP Developer Tool the first time), then retry.'
    );
  }
}

/**
 * Local WebSocket server. The Photoshop UXP plugin connects to it as a client,
 * so commands are PUSHED to Photoshop and results/events are pushed back.
 */
export class PhotoshopBridge implements Bridge {
  private wss: WebSocketServer | null = null;
  private sock: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private events: BridgeEvent[] = [];
  pluginInfo: Record<string, unknown> | null = null;
  /** Optional hook: plugin connected / disconnected (used by the dashboard's connection history). */
  onPluginEvent?: (type: 'connected' | 'disconnected', detail?: string) => void;

  constructor(
    readonly port: number,
    private readonly maxEvents = 1000
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        // Block browser pages (cross-site WebSocket hijacking): they always send an http(s) Origin.
        verifyClient: (info: { origin: string }) => !info.origin || !/^https?:/i.test(info.origin),
      });
      wss.once('listening', () => {
        this.wss = wss;
        log(`bridge listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });
      wss.on('error', (e) => {
        log('bridge error:', e.message);
        reject(e);
      });
      wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  get connected(): boolean {
    return !!this.sock && this.sock.readyState === WebSocket.OPEN;
  }

  private onConnection(ws: WebSocket): void {
    if (this.sock && this.sock !== ws) {
      try {
        this.sock.close();
      } catch {
        /* ignore */
      }
    }
    this.sock = ws;
    log('plugin connected');
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.sock === ws) {
        this.sock = null;
        this.pluginInfo = null;
        this.rejectAll(new Error('Photoshop plugin disconnected mid-call'));
        this.onPluginEvent?.('disconnected');
        log('plugin disconnected');
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      this.pluginInfo = msg.info ?? {};
      this.onPluginEvent?.('connected', `Photoshop ${(msg.info as any)?.photoshop ?? '?'}, plugin v${(msg.info as any)?.plugin ?? '?'}`);
    } else if (msg.type === 'event') {
      this.events.push({ ts: Date.now(), event: msg.event, descriptor: msg.descriptor });
      if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else {
        const err = new Error(msg.error?.message ?? 'Unknown Photoshop error');
        (err as any).pluginStack = msg.error?.stack;
        p.reject(err);
      }
    }
  }

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    if (!this.connected) return Promise.reject(new NotConnectedError());
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Photoshop did not respond to "${action}" within ${timeoutMs}ms (a modal dialog may be open).`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sock!.send(JSON.stringify({ type: 'call', id, action, params }));
    });
  }

  async status() {
    return { connected: this.connected, pluginInfo: this.pluginInfo };
  }

  async drainEvents(opts: { since?: number; filter?: string; clear?: boolean } = {}): Promise<BridgeEvent[]> {
    let out = this.events.filter((e) => (opts.since ? e.ts > opts.since : true));
    if (opts.filter) out = out.filter((e) => e.event.includes(opts.filter!));
    if (opts.clear) this.events = [];
    return out;
  }

  close(): void {
    this.rejectAll(new Error('Bridge closing'));
    this.wss?.close();
  }
}
