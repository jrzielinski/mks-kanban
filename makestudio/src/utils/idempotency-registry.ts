import { createHash } from 'crypto';

export interface IdempotencyEntry {
  result: string;
  timestamp: number;
}

/**
 * In-memory idempotency registry with bounded size and TTL.
 *
 * Generates a SHA-256 key from (toolName + JSON-stable serialized input).
 * When the same tool+input pair arrives within the TTL, the cached result
 * is returned instead of re-executing — preventing duplicate side effects
 * from retries, message replays, or race conditions.
 *
 * - maxEntries: LRU eviction when exceeded
 * - ttlMs: entries older than this are pruned on access/insert
 */
export class IdempotencyRegistry {
  private readonly map = new Map<string, IdempotencyEntry>();
  private readonly keyOrder: string[] = [];
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private cleanupCount = 0;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? 5000;
    this.ttlMs = opts?.ttlMs ?? 5 * 60 * 1000; // 5 min default
  }

  /** Build a deterministic key from (toolName, input). */
  static buildKey(toolName: string, input: Record<string, any>): string {
    const stable = JSON.stringify(input, Object.keys(input).sort());
    return createHash('sha256').update(`${toolName}\0${stable}`).digest('hex');
  }

  /** True only for tools with side effects — the ones worth caching. */
  static isSideEffectTool(name: string): boolean {
    switch (name) {
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'Bash':
      case 'shell_run':
      case 'ask_user_question': // multiple sends = annoyance
        return true;
      default:
        return false;
    }
  }

  /** Look up a cached result. Returns undefined if not found or expired. */
  get(key: string): string | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(key);
      const idx = this.keyOrder.indexOf(key);
      if (idx >= 0) this.keyOrder.splice(idx, 1);
      return undefined;
    }
    // Bump to end (LRU)
    const idx = this.keyOrder.indexOf(key);
    if (idx >= 0) {
      this.keyOrder.splice(idx, 1);
      this.keyOrder.push(key);
    }
    return entry.result;
  }

  /** Store a result under the given key. Evicts LRU if over capacity. */
  set(key: string, result: string): void {
    if (this.map.has(key)) {
      // Update in place — already counted in size.
      this.map.set(key, { result, timestamp: Date.now() });
      return;
    }
    // Periodic cleanup — scan every 50 inserts to avoid O(n) on every call.
    this.cleanupCount++;
    if (this.cleanupCount % 50 === 0) {
      this.pruneExpired();
    }
    // LRU eviction
    if (this.keyOrder.length >= this.maxEntries) {
      const oldest = this.keyOrder.shift();
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, { result, timestamp: Date.now() });
    this.keyOrder.push(key);
  }

  /** Remove all entries — for testing or session reset. */
  clear(): void {
    this.map.clear();
    this.keyOrder.length = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** Internal: remove expired entries to free space. */
  private pruneExpired(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [key, entry] of this.map) {
      if (now - entry.timestamp > this.ttlMs) {
        expired.push(key);
      }
    }
    for (const key of expired) {
      this.map.delete(key);
      const idx = this.keyOrder.indexOf(key);
      if (idx >= 0) this.keyOrder.splice(idx, 1);
    }
  }
}

/** Singleton shared across the REPL session. */
export const idempotencyRegistry = new IdempotencyRegistry();
