import type { Bridge, BridgeEvent } from './bridge.js';
import { callContext } from './context.js';

/** Talks to the already-running daemon over its authenticated localhost HTTP API. */
export class RemoteBridge implements Bridge {
  constructor(
    readonly port: number,
    private readonly base: string,
    private readonly token: string
  ) {}

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const r = await fetch(this.base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.token,
        ...(() => {
          const c = callContext.getStore();
          const h: Record<string, string> = {};
          if (c?.client) h['X-PSS-Client'] = encodeURIComponent(c.client);
          if (c?.tool) h['X-PSS-Tool'] = encodeURIComponent(c.tool);
          return h;
        })(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await r.json()) as { ok: boolean; data?: T; error?: string };
    if (!j.ok) throw new Error(j.error ?? 'Daemon error');
    return j.data as T;
  }

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    return this.post<T>('/rpc', { action, params, timeoutMs }, timeoutMs + 10_000);
  }

  status() {
    return this.post<{ connected: boolean; pluginInfo: Record<string, unknown> | null }>('/status', {}, 5_000);
  }

  drainEvents(opts: { since?: number; filter?: string; clear?: boolean } = {}) {
    return this.post<BridgeEvent[]>('/events', opts, 10_000);
  }
}
