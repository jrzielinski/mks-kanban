import { swallow } from '../utils/log';
/**
 * scratchpad-cleanup.ts — TTL-based cleanup for ~/.makestudio/scratch/.
 *
 * dispatch_agents_parallel (par-*) and coordinator sessions (coord-*) write
 * to subdirectories of ~/.makestudio/scratch/. Nothing cleaned these up
 * automatically, so the disk accumulated every run forever.
 *
 * This runs once at CLI startup: it scans the scratch root, drops any dir
 * whose mtime is older than the TTL, and never throws (best-effort).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupScratchpads(ttlMs: number = DEFAULT_TTL_MS): { scanned: number; removed: number } {
  const root = path.join(os.homedir(), '.makestudio', 'scratch');
  let scanned = 0;
  let removed = 0;
  try {
    if (!fs.existsSync(root)) return { scanned: 0, removed: 0 };
    const entries = fs.readdirSync(root);
    const now = Date.now();
    for (const name of entries) {
      // Only touch dirs that look like automatic runs. User-named dirs (no
      // par-/coord-/dispatch- prefix) are left alone in case the user stashed
      // something in there manually.
      if (!/^(par|coord|dispatch)-/.test(name)) continue;
      scanned++;
      const full = path.join(root, name);
      try {
        const st = fs.statSync(full);
        if (!st.isDirectory()) continue;
        if (now - st.mtimeMs > ttlMs) {
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
        }
      } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }
  return { scanned, removed };
}
