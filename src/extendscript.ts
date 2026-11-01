import { execFile } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$code = [IO.File]::ReadAllText($env:PSS_JSX, [Text.Encoding]::UTF8)
$app = New-Object -ComObject Photoshop.Application
$r = $app.DoJavaScript($code)
if ($null -ne $r) { [Console]::Out.Write([string]$r) }
`;

/** Runs ExtendScript (legacy JSX) in Photoshop through its COM automation interface. Windows only. */
export async function runExtendScript(code: string, args: unknown, timeoutMs: number): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(
      'ps_run_extendscript is implemented for Windows (COM). On this OS use ps_run_uxp or ps_batch_play.'
    );
  }
  const dir = join(tmpdir(), 'photoshop-supreme');
  await mkdir(dir, { recursive: true });
  const file = join(dir, randomUUID() + '.jsx');
  const prefix = args === undefined ? '' : `var args = ${JSON.stringify(args)};\n`;
  await writeFile(file, '\uFEFF' + prefix + code, 'utf8');
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { env: { ...process.env, PSS_JSX: file }, timeout: timeoutMs, windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message).toString().trim();
            reject(new Error('ExtendScript failed: ' + msg.slice(0, 2000)));
          } else resolve(stdout.toString());
        }
      );
    });
  } finally {
    unlink(file).catch(() => undefined);
  }
}
