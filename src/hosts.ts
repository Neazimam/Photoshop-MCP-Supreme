import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface HostStatus {
  name: string;
  file: string;
  state: 'configured' | 'node-missing' | 'not-configured' | 'not-installed' | 'unreadable';
}

const KEY = 'photoshop-supreme';

function claudeDirs(): string[] {
  const out: string[] = [];
  if (platform() === 'win32') {
    if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'Claude'));
    const pk = join(process.env.LOCALAPPDATA ?? '', 'Packages');
    if (process.env.LOCALAPPDATA && existsSync(pk))
      for (const d of readdirSync(pk)) if (/^Claude_/i.test(d)) out.push(join(pk, d, 'LocalCache', 'Roaming', 'Claude'));
  } else if (platform() === 'darwin') out.push(join(homedir(), 'Library', 'Application Support', 'Claude'));
  else out.push(join(homedir(), '.config', 'Claude'));
  return out;
}

/** Look at AI-app config files to see whether our server is registered (read-only). */
export function detectHosts(): HostStatus[] {
  const targets = [
    ...claudeDirs().map((d) => ({ name: 'Claude Desktop', dir: d, file: join(d, 'claude_desktop_config.json') })),
    { name: 'Cursor', dir: join(homedir(), '.cursor'), file: join(homedir(), '.cursor', 'mcp.json') },
  ];
  return targets.map((t) => {
    if (!existsSync(t.dir)) return { name: t.name, file: t.file, state: 'not-installed' as const };
    if (!existsSync(t.file)) return { name: t.name, file: t.file, state: 'not-configured' as const };
    try {
      const cfg = JSON.parse(readFileSync(t.file, 'utf8') || '{}');
      const e = cfg?.mcpServers?.[KEY];
      if (!e) return { name: t.name, file: t.file, state: 'not-configured' as const };
      return { name: t.name, file: t.file, state: existsSync(e.command) ? ('configured' as const) : ('node-missing' as const) };
    } catch {
      return { name: t.name, file: t.file, state: 'unreadable' as const };
    }
  });
}
