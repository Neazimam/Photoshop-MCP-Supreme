// Silent, Creative-Cloud-free install of a UXP plugin into Photoshop's per-user plugin folder.
//   node uxp-plugin.mjs --install --src <plugin dir>   (reads id/name/version/minVersion from its manifest.json)
//   node uxp-plugin.mjs --remove  --id <plugin id>
//   node uxp-plugin.mjs --status  --id <plugin id>
// Layout: <UXP root>/Plugins/External/<id>_<version>/  +  <UXP root>/PluginsInfo/v1/PS.json
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

function uxpRoot() {
  if (process.env.PSS_UXP_ROOT) return process.env.PSS_UXP_ROOT; // override (tests)
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Adobe', 'UXP');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Adobe', 'UXP');
  return join(homedir(), '.config', 'Adobe', 'UXP');
}
const root = uxpRoot();
const extDir = join(root, 'Plugins', 'External');
const infoFile = join(root, 'PluginsInfo', 'v1', 'PS.json');
const sep = platform() === 'win32' ? '\\' : '/';

function readInfo() {
  if (!existsSync(infoFile)) return { plugins: [] };
  let j;
  try { j = JSON.parse(readFileSync(infoFile, 'utf8').replace(/^\uFEFF/, '') || '{}'); }
  catch { throw new Error(`${infoFile} is not valid JSON - refusing to modify it`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  if (!Array.isArray(j.plugins)) j.plugins = [];
  return j;
}
function writeInfo(j) {
  mkdirSync(dirname(infoFile), { recursive: true });
  if (existsSync(infoFile) && !existsSync(infoFile + '.bak-supreme')) copyFileSync(infoFile, infoFile + '.bak-supreme');
  writeFileSync(infoFile, JSON.stringify(j));
}
function removeFolders(id) {
  if (!existsSync(extDir)) return 0;
  let n = 0;
  for (const d of readdirSync(extDir)) {
    if (d === id || d.startsWith(id + '_')) { rmSync(join(extDir, d), { recursive: true, force: true }); n++; }
  }
  return n;
}
function dropEntries(id) {
  const j = readInfo();
  const before = j.plugins.length;
  j.plugins = j.plugins.filter((p) => p && p.pluginId !== id);
  if (existsSync(infoFile) || before) writeInfo(j);
  return before - j.plugins.length;
}
const out = (o) => console.log(JSON.stringify(o));

try {
  if (cmd === '--install') {
    const src = opt('--src');
    if (!src) throw new Error('--src required');
    const m = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    const { id, name, version } = m;
    const min = (m.host && (Array.isArray(m.host) ? m.host[0] : m.host).minVersion) || '24.2.0';
    removeFolders(id);
    const folder = `${id}_${version}`;
    mkdirSync(extDir, { recursive: true });
    cpSync(src, join(extDir, folder), { recursive: true });
    const j = readInfo();
    j.plugins = j.plugins.filter((p) => p && p.pluginId !== id);
    j.plugins.push({ hostMinVersion: min, name, path: `$localPlugins${sep}External${sep}${folder}`, pluginId: id, status: 'enabled', type: 'uxp', versionString: version });
    writeInfo(j);
    out({ ok: true, installed: true, folder: join(extDir, folder), version });
  } else if (cmd === '--remove') {
    const id = opt('--id');
    if (!id) throw new Error('--id required');
    out({ ok: true, foldersRemoved: removeFolders(id), entriesRemoved: dropEntries(id) });
  } else if (cmd === '--status') {
    const id = opt('--id');
    if (!id) throw new Error('--id required');
    const folders = existsSync(extDir) ? readdirSync(extDir).filter((d) => d === id || d.startsWith(id + '_')) : [];
    const entry = readInfo().plugins.find((p) => p && p.pluginId === id);
    const hasManifest = folders.some((f) => existsSync(join(extDir, f, 'manifest.json')));
    out({ ok: true, installed: hasManifest && !!entry, folder: hasManifest, registered: !!entry, version: entry?.versionString ?? null });
  } else {
    throw new Error('Usage: --install --src <dir> | --remove --id <id> | --status --id <id>');
  }
} catch (e) {
  out({ ok: false, error: String(e.message || e) });
  process.exit(1);
}
