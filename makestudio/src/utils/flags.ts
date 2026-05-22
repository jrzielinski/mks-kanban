/**
 * flags.ts — runtime feature flags (Fase 5.5).
 *
 * Flags live in `~/.makestudio/flags.json`:
 *   {
 *     "microCompact": true,
 *     "fastModel": true,
 *     "cacheBoundary": true,
 *     "newHooks": true,
 *     "sessionMemory": true
 *   }
 *
 * Usage in code:
 *   import { isFlagEnabled } from '../../utils/flags'
 *   if (isFlagEnabled('microCompact', true)) { ... }
 *
 * Default value (second arg) lets new code ship enabled but gives the user
 * a kill-switch. Any flag not in the file uses the default.
 *
 * File is re-read every call — flip a flag without restart (hot reload).
 * Small perf cost (JSON.parse on every check), but the path is ~100 bytes
 * and this is not on the hot path.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const FLAGS_FILE = path.join(os.homedir(), '.makestudio', 'flags.json');

// Small in-memory cache with mtime-based invalidation — avoids parsing on
// every single check while still picking up edits within seconds.
let cached: { mtime: number; data: Record<string, boolean> } | null = null;

function loadFlags(): Record<string, boolean> {
  try {
    const stat = fs.statSync(FLAGS_FILE);
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    const raw = fs.readFileSync(FLAGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const data: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') data[k] = v;
    }
    cached = { mtime: stat.mtimeMs, data };
    return data;
  } catch {
    return cached?.data || {};
  }
}

export function isFlagEnabled(name: string, defaultValue: boolean = false): boolean {
  const flags = loadFlags();
  return name in flags ? flags[name] : defaultValue;
}

export function allFlags(): Record<string, boolean> {
  return { ...loadFlags() };
}

export function flagsFilePath(): string { return FLAGS_FILE; }
