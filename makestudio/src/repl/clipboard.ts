/**
 * clipboard.ts
 *
 * Thin wrapper around the OS clipboard. Tries the platform-native binary
 * first (pbcopy on macOS, xclip/xsel on Linux, clip on Windows) and falls
 * back to OSC 52 (terminal escape) if none are found.
 */

import { spawn } from 'child_process';
import * as os from 'os';

export async function copyToClipboard(text: string): Promise<{ ok: boolean; via: string; error?: string }> {
  const platform = os.platform();
  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (platform === 'darwin') {
    candidates.push({ cmd: 'pbcopy', args: [] });
  } else if (platform === 'linux') {
    candidates.push({ cmd: 'wl-copy', args: [] });
    candidates.push({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
    candidates.push({ cmd: 'xsel', args: ['--clipboard', '--input'] });
  } else if (platform === 'win32') {
    candidates.push({ cmd: 'clip', args: [] });
  }

  for (const { cmd, args } of candidates) {
    const result = await tryCommand(cmd, args, text);
    if (result.ok) return { ok: true, via: cmd };
  }

  // OSC 52 fallback — works in most modern terminals (iTerm, kitty, Alacritty,
  // recent Terminal.app) over SSH too. Max ~8KB per sequence in most terminals.
  try {
    const truncated = text.length > 100_000 ? text.slice(0, 100_000) : text;
    const b64 = Buffer.from(truncated, 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    return { ok: true, via: 'osc52' };
  } catch (e: any) {
    return { ok: false, via: 'osc52', error: e.message };
  }
}

function tryCommand(cmd: string, args: string[], stdin: string): Promise<{ ok: boolean }> {
  return new Promise(resolve => {
    try {
      const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.on('error', () => resolve({ ok: false }));
      proc.on('exit', (code) => resolve({ ok: code === 0 }));
      proc.stdin.write(stdin);
      proc.stdin.end();
    } catch {
      resolve({ ok: false });
    }
  });
}
