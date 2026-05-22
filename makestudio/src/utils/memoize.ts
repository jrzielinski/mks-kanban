/**
 * memoize.ts
 *
 * TTL-based memoization with stale-while-refresh + in-flight dedup.
 * Ported from Claude Code's src/utils/memoize.ts. Two exports:
 *
 *   memoizeWithTTL(f, ttlMs)       — sync f, returns cached value; refreshes
 *                                    in background when stale.
 *   memoizeWithTTLAsync(f, ttlMs)  — async f, deduplicates concurrent
 *                                    cold-miss callers onto a single in-flight
 *                                    promise. Stale-while-refresh same as sync.
 *
 * The async variant is the one that matters for MakeStudio — without in-flight
 * dedup, N concurrent callers of an async provider lookup spawn N backend
 * round-trips. E.g. `fetchProviderInfo` during REPL boot could be called
 * simultaneously by the banner, context builder, and away-summary heartbeat.
 *
 * Identity-guard: cache.clear() during an await should NOT be overwritten by
 * a stale result that landed after the clear. Every .then/.catch checks
 * `cache.get(key) === original-cached-entry` before writing.
 */

type CacheEntry<T> = { value: T; timestamp: number; refreshing: boolean };

type Memoized<A extends unknown[], R> = ((...args: A) => R) & {
  cache: { clear: () => void };
};
type MemoizedAsync<A extends unknown[], R> = ((...args: A) => Promise<R>) & {
  cache: { clear: () => void };
};

function keyOf(args: unknown[]): string {
  try { return JSON.stringify(args); } catch { return String(args); }
}

export function memoizeWithTTL<A extends unknown[], R>(
  f: (...args: A) => R,
  ttlMs: number = 5 * 60 * 1000,
): Memoized<A, R> {
  const cache = new Map<string, CacheEntry<R>>();

  const fn = ((...args: A): R => {
    const k = keyOf(args);
    const hit = cache.get(k);
    const now = Date.now();

    if (!hit) {
      const v = f(...args);
      cache.set(k, { value: v, timestamp: now, refreshing: false });
      return v;
    }

    if (now - hit.timestamp > ttlMs && !hit.refreshing) {
      hit.refreshing = true;
      const stale = hit;
      Promise.resolve().then(() => {
        try {
          const nv = f(...args);
          if (cache.get(k) === stale) {
            cache.set(k, { value: nv, timestamp: Date.now(), refreshing: false });
          }
        } catch {
          if (cache.get(k) === stale) cache.delete(k);
        }
      });
      return hit.value;
    }

    return hit.value;
  }) as Memoized<A, R>;

  fn.cache = { clear: () => cache.clear() };
  return fn;
}

export function memoizeWithTTLAsync<A extends unknown[], R>(
  f: (...args: A) => Promise<R>,
  ttlMs: number = 5 * 60 * 1000,
): MemoizedAsync<A, R> {
  const cache = new Map<string, CacheEntry<R>>();
  // In-flight dedup: a cold-miss promise is stored here before the await
  // so concurrent callers share the same promise. Claude Code comment:
  // "Without this, N concurrent callers each invoke f() independently —
  // for AWS SSO login that means N concurrent `aws sso login` spawns."
  const inFlight = new Map<string, Promise<R>>();

  const fn = (async (...args: A): Promise<R> => {
    const k = keyOf(args);
    const hit = cache.get(k);
    const now = Date.now();

    if (!hit) {
      const pending = inFlight.get(k);
      if (pending) return pending;
      const p = f(...args);
      inFlight.set(k, p);
      try {
        const r = await p;
        // Identity-guard: cache.clear() during await wipes inFlight; if
        // our promise is no longer there, a clear() happened and we should
        // discard this result to honour the clear intent.
        if (inFlight.get(k) === p) {
          cache.set(k, { value: r, timestamp: now, refreshing: false });
        }
        return r;
      } finally {
        if (inFlight.get(k) === p) inFlight.delete(k);
      }
    }

    if (now - hit.timestamp > ttlMs && !hit.refreshing) {
      hit.refreshing = true;
      const stale = hit;
      f(...args)
        .then((nv) => {
          if (cache.get(k) === stale) {
            cache.set(k, { value: nv, timestamp: Date.now(), refreshing: false });
          }
        })
        .catch(() => {
          if (cache.get(k) === stale) cache.delete(k);
        });
      return hit.value;
    }

    return hit.value;
  }) as MemoizedAsync<A, R>;

  fn.cache = {
    clear: () => {
      cache.clear();
      // Important: clear inFlight too. Otherwise the next cold-miss caller
      // receives the pre-clear in-flight promise, defeating the clear intent.
      inFlight.clear();
    },
  };
  return fn;
}
