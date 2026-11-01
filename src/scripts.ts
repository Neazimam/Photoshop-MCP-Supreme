import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

export interface SavedScript {
  name: string;
  description: string;
  code: string;
  read_only: boolean;
  saved: string;
}

const DIR = join(DATA_DIR, 'scripts');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

function check(name: string): void {
  if (!NAME_RE.test(name)) throw new Error('Script name must be 1-60 chars: lowercase letters, digits, "-" or "_".');
}

export async function saveScript(s: Omit<SavedScript, 'saved'>): Promise<void> {
  check(s.name);
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, s.name + '.json'), JSON.stringify({ ...s, saved: new Date().toISOString() }, null, 2));
}

export async function loadScript(name: string): Promise<SavedScript> {
  check(name);
  try {
    return JSON.parse(await readFile(join(DIR, name + '.json'), 'utf8')) as SavedScript;
  } catch {
    throw new Error(`No saved script named "${name}". Use ps_list_scripts.`);
  }
}

export async function listScripts(): Promise<Pick<SavedScript, 'name' | 'description' | 'saved'>[]> {
  try {
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      const s = JSON.parse(await readFile(join(DIR, f), 'utf8')) as SavedScript;
      out.push({ name: s.name, description: s.description, saved: s.saved });
    }
    return out;
  } catch {
    return [];
  }
}

export async function deleteScript(name: string): Promise<void> {
  check(name);
  await unlink(join(DIR, name + '.json')).catch(() => {
    throw new Error(`No saved script named "${name}".`);
  });
}
