/**
 * parallel-prefetch.ts — fan-out the I/O of read-only tools while
 * keeping the rest of the dispatcher sequential.
 *
 * The model frequently emits multiple Read/Glob/Grep tool_uses in a
 * single response — for example, "let me check three config files":
 * Read("a.json"), Read("b.json"), Read("c.json"). The current
 * sequential dispatcher waits for `a.json`'s read to land before
 * starting `b.json`'s. On a slow disk or large files that's seconds
 * of wall-clock time the user spends waiting on serialised I/O.
 *
 * This module's `maybePrefetchReadOnly` runs ALL read-only tools'
 * core executeTool() calls concurrently and stashes the resulting
 * strings on `ctx.__prefetchCache` keyed by tool_use id. The
 * dispatcher then picks the result up instead of running the tool
 * again. Permission checks, hooks, dedup, history mutation, and
 * chatMessages.push() all remain sequential.
 *
 * SAFETY:
 *   - Only tools we KNOW are idempotent and side-effect-free are
 *     prefetched (allowlist below). Mutating tools (Edit/Write/Bash/
 *     MultiEdit) NEVER prefetch.
 *   - We do NOT skip permission checks. If a Read is denied by
 *     policy, the prefetch result is discarded by the dispatcher.
 *   - Prefetch errors are CACHED THROWS — the dispatcher re-throws
 *     them at the right moment so error surfaces unchanged.
 *
 * Off by default. Enable via settings.parallelReadOnlyExec or env
 * MAKESTUDIO_PARALLEL_READ=1.
 */

import { ReplContext } from '../context';
import { executeTool } from './tools';

const READ_ONLY_TOOLS = new Set([
  'Read', 'read_file',
  'Glob', 'Grep',
  'WebFetch', 'web_fetch',
  'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
  'lsp_workspace_symbol',
]);

let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const env = (process.env.MAKESTUDIO_PARALLEL_READ || '').toLowerCase().trim();
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    const s = loadSettings() as any;
    cachedEnabled = !!s?.parallelReadOnlyExec;
    return cachedEnabled;
  } catch { cachedEnabled = false; return false; }
}

export function resetParallelPrefetchCache(): void { cachedEnabled = null; }

export interface PrefetchEntry {
  /** Successful result string from executeTool. */
  result?: string;
  /** Error thrown by executeTool, to re-throw on dispatch. */
  error?: any;
}

export type PrefetchCache = Map<string, PrefetchEntry>;

function ensureCache(ctx: any): PrefetchCache {
  if (!ctx.__prefetchCache) ctx.__prefetchCache = new Map();
  return ctx.__prefetchCache as PrefetchCache;
}

/**
 * Prefetch the read-only subset of `toolUses` in parallel.
 *
 * Returns the list of tool_use ids whose results were prefetched
 * (caller can use this for telemetry or status updates).
 */
export async function maybePrefetchReadOnly(
  toolUses: Array<{ id: string; name: string; input: any }>,
  ctx: ReplContext,
): Promise<string[]> {
  if (!isEnabled()) return [];
  if (!Array.isArray(toolUses) || toolUses.length < 2) return [];

  const cache = ensureCache(ctx);
  const prefetchable = toolUses.filter((t) => {
    if (!t || !t.id) return false;
    if (cache.has(t.id)) return false; // already cached from a prior loop
    if (!READ_ONLY_TOOLS.has(t.name)) return false;
    if (t.name.includes('.')) return false; // MCP-prefixed → unknown semantics
    return true;
  });
  if (prefetchable.length < 2) return [];

  // Capture id list before launching so we can return it deterministically.
  const ids = prefetchable.map((t) => t.id);

  await Promise.all(prefetchable.map(async (t) => {
    try {
      const result = await executeTool(t.name, t.input, ctx);
      cache.set(t.id, { result });
    } catch (err) {
      // Cache the throw so the dispatcher's error path runs naturally
      // (with hook firing, denial-correction injection, etc.).
      cache.set(t.id, { error: err });
    }
  }));

  return ids;
}

/**
 * Look up a prefetched result for a tool_use. Returns the entry and
 * removes it from the cache so a second lookup misses (each tool_use
 * is one-shot).
 */
export function consumePrefetched(ctx: any, toolUseId: string): PrefetchEntry | null {
  const cache: PrefetchCache | undefined = ctx?.__prefetchCache;
  if (!cache) return null;
  const entry = cache.get(toolUseId);
  if (!entry) return null;
  cache.delete(toolUseId);
  return entry;
}

/** For tests / explicit reset. */
export function clearPrefetchCache(ctx: any): void {
  if (ctx?.__prefetchCache) (ctx.__prefetchCache as PrefetchCache).clear();
}
