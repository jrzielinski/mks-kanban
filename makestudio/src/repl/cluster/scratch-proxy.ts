/**
 * cluster/scratch-proxy.ts — server-side scratchpad I/O, called by the WS
 * server when a remote peer requests scratch-read / scratch-write.
 *
 * The scratchpad lives under ~/.makestudio/scratch/<sessionId>/ exactly like
 * the coordinator's own — only the entry point differs. Path traversal is
 * blocked via safeScratchpadKey mirror.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function scratchpadDir(sessionId: string): string {
  return path.join(os.homedir(), '.makestudio', 'scratch', sessionId);
}

/** Reject any key that escapes the session dir (../, absolute, etc.). */
function safeKey(sessionId: string, key: string): string {
  const base = scratchpadDir(sessionId);
  const full = path.resolve(base, key);
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new Error(`unsafe scratchpad key "${key}" (outside session dir)`);
  }
  return full;
}

export async function readScratchpad(sessionId: string, key: string): Promise<string> {
  const full = safeKey(sessionId, key);
  if (!fs.existsSync(full)) throw new Error(`scratchpad key "${key}" not found`);
  return fs.readFileSync(full, 'utf8');
}

export async function writeScratchpad(sessionId: string, key: string, content: string): Promise<number> {
  const full = safeKey(sessionId, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return Buffer.byteLength(content);
}
