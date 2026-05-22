import { swallow } from './log';
/**
 * cleanup-registry.ts
 *
 * Global registry for cleanup functions that run during graceful shutdown.
 * Ported from Claude Code's src/utils/cleanupRegistry.ts — kept tiny and
 * separate from the shutdown driver so modules can register without pulling
 * in terminal/Ink deps.
 *
 * Use cases in MakeStudio:
 *   - Closing LSP servers (child processes)
 *   - Disconnecting MCP clients
 *   - Flushing events.jsonl buffer
 *   - Clearing polling intervals
 */

type CleanupFn = () => void | Promise<void>;

const cleanupFunctions = new Set<CleanupFn>();

/**
 * Register a cleanup function. Returns an unregister callback — call it if
 * the resource is released early so the cleanup list doesn't accumulate
 * already-freed handles.
 */
export function registerCleanup(cleanupFn: CleanupFn): () => void {
  cleanupFunctions.add(cleanupFn);
  return () => cleanupFunctions.delete(cleanupFn);
}

/**
 * Run all registered cleanup functions with a budget. Functions that throw
 * or reject are logged to stderr but don't block sibling cleanups. Returns
 * when every cleanup resolves or the overall budget elapses — whichever is
 * sooner. Budget default: 2s (Claude Code uses 2s for the main pool and
 * 500ms for analytics; we collapse them since we have no analytics flush).
 */
export async function runCleanupFunctions(budgetMs: number = 2000): Promise<void> {
  const fns = Array.from(cleanupFunctions);
  if (fns.length === 0) return;

  const work = Promise.all(
    fns.map(async (fn) => {
      try { await fn(); } catch (e: any) {
        try { process.stderr.write(`[cleanup] ${e?.message || e}\n`); } catch (err) { swallow(err); }
      }
    }),
  );

  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, budgetMs);
      t.unref?.(); // don't let the budget timer keep the process alive
    }),
  ]);
}

/** Test-only: wipe registry between tests. */
export function __resetCleanupRegistryForTests(): void {
  cleanupFunctions.clear();
}
