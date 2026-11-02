import { AsyncLocalStorage } from 'node:async_hooks';

/** Who is calling and which MCP tool is running — propagated through async calls (for telemetry + shim->daemon headers). */
export interface CallContext {
  client: string;
  tool: string;
}
export const callContext = new AsyncLocalStorage<Partial<CallContext>>();
