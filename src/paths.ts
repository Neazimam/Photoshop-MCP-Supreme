import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const DATA_DIR = join(homedir(), '.photoshop-supreme-mcp');
const TOKEN_FILE = join(DATA_DIR, 'token');

export const BRIDGE_PORT = Number.parseInt(process.env.PS_SUPREME_PORT ?? '38460', 10);
export const HTTP_PORT = Number.parseInt(process.env.PS_SUPREME_HTTP_PORT ?? '38461', 10);

export function readToken(): string | null {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Create the shared secret once (readable only by the current user where the OS supports it). */
export function ensureToken(): string {
  const existing = readToken();
  if (existing) return existing;
  mkdirSync(DATA_DIR, { recursive: true });
  const t = randomBytes(32).toString('hex');
  if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return readToken() ?? t;
}
