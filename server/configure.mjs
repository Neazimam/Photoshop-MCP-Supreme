// Registers / unregisters "photoshop-supreme" in MCP host configs (Claude Desktop, Cursor).
// Usage: node configure.mjs --install --node <node.exe> --server <supreme.mjs>
//        node configure.mjs --uninstall
// Never overwrites a config it cannot parse; keeps a one-time backup (<file>.bak-supreme).
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

const KEY = 'photoshop-supreme';
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const install = flag('--install');
const uninstall = flag('--uninstall');
if (!install && !uninstall) { console.error('Specify --install or --uninstall'); process.exit(2); }
const nodePath = val('--node'), serverPath = val('--server');
if (install && (!nodePath || !serverPath)) { console.error('--install needs --node and --server'); process.exit(2); }

function claudeDesktopDirs() {
  const out = [];
  if (platform() === 'win32') {
    if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'Claude'));
    const pk = join(process.env.LOCALAPPDATA ?? '', 'Packages'); // Microsoft Store build
    if (process.env.LOCALAPPDATA && existsSync(pk)) {
      for (const d of readdirSync(pk)) if (/^Claude_/i.test(d)) out.push(join(pk, d, 'LocalCache', 'Roaming', 'Claude'));
    }
  } else if (platform() === 'darwin') out.push(join(homedir(), 'Library', 'Application Support', 'Claude'));
  else out.push(join(homedir(), '.config', 'Claude'));
  return out;
}

const targets = [
  ...claudeDesktopDirs().map((d) => ({ name: 'Claude Desktop', dir: d, file: join(d, 'claude_desktop_config.json'), create: true })),
  { name: 'Cursor', dir: join(homedir(), '.cursor'), file: join(homedir(), '.cursor', 'mcp.json'), create: false },
];

let changed = 0;
for (const t of targets) {
  // Only touch hosts that are actually installed (their config folder exists).
  if (!existsSync(t.dir)) { console.log(`skip: ${t.name} not found (${t.dir})`); continue; }
  let cfg = {};
  if (existsSync(t.file)) {
    try { cfg = JSON.parse(readFileSync(t.file, 'utf8') || '{}'); }
    catch (e) { console.log(`WARN: ${t.file} is not valid JSON — left untouched`); continue; }
    const bak = t.file + '.bak-supreme';
    if (!existsSync(bak)) copyFileSync(t.file, bak);
  } else if (!t.create && !install) continue;
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) { console.log(`WARN: ${t.file} unexpected shape — left untouched`); continue; }
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  if (install) cfg.mcpServers[KEY] = { command: nodePath, args: [serverPath] };
  else if (KEY in cfg.mcpServers) delete cfg.mcpServers[KEY];
  else continue;
  mkdirSync(dirname(t.file), { recursive: true });
  writeFileSync(t.file, JSON.stringify(cfg, null, 2));
  console.log(`${install ? 'configured' : 'removed from'}: ${t.name} (${t.file})`);
  changed++;
}
console.log(`done: ${changed} config(s) ${install ? 'updated' : 'cleaned'}`);
