// stdout is reserved for the MCP protocol — log to stderr only.
export const log = (...a: unknown[]) => console.error('[photoshop-supreme-mcp]', ...a);
