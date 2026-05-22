/**
 * cluster/crdt.ts — vector clocks + last-writer-wins registers.
 *
 * Used to make persistent state (starting with memory topics) safe to
 * replicate across peers. Each write increments the author's slot in the
 * topic's vector clock; a receiving peer merges by:
 *
 *   - If incoming VClock strictly dominates local   → take incoming.
 *   - If local strictly dominates incoming          → keep local.
 *   - If equal                                      → no-op.
 *   - If concurrent (neither dominates)             → CONFLICT. Both
 *     versions are kept; resolution is surfaced to the user via a
 *     deterministic tiebreaker (origin peerId lexicographic) so the
 *     system can pick *a* winner while flagging the concurrent other.
 *
 * No Yjs/Automerge dependency. Last-writer-wins covers the memory use
 * case (one topic = one opaque body blob). Fine-grained CRDTs (RGA,
 * OR-Set) would matter for collaborative text editing; we don't do that.
 */

export type VClock = Record<string, number>;

export type VClockRel = 'equal' | 'before' | 'after' | 'concurrent';

export interface LWWEntry<T> {
  value: T;
  vclock: VClock;
  /** PeerId of the writer that produced this version. Drives deterministic
   *  tiebreaking when two clocks are concurrent. */
  origin: string;
  /** Milliseconds since epoch at write time. Informational; comparison is
   *  clock-based, not timestamp-based, because wall-clock skew between
   *  peers can flip LWW with no good reason. */
  updatedAt: number;
}

// ── VClock primitives ────────────────────────────────────────────────────

export function emptyVClock(): VClock {
  return {};
}

/** Increment the writer's slot. Never mutates the input. */
export function bump(vclock: VClock, peerId: string): VClock {
  return { ...vclock, [peerId]: (vclock[peerId] ?? 0) + 1 };
}

/** Entry-wise max merge (used when adopting a remote entry that dominates
 *  ours, so the resulting clock covers both histories). */
export function maxMerge(a: VClock, b: VClock): VClock {
  const out: VClock = { ...a };
  for (const [peer, n] of Object.entries(b)) {
    if ((out[peer] ?? 0) < n) out[peer] = n;
  }
  return out;
}

/**
 * Relational comparison. Two clocks are "before" / "after" if one is
 * pointwise ≤ the other AND strictly less in at least one slot.
 * Otherwise: equal (same values everywhere) or concurrent.
 */
export function compare(a: VClock, b: VClock): VClockRel {
  let aLessThanB = false;
  let bLessThanA = false;
  const peers = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const peer of peers) {
    const av = a[peer] ?? 0;
    const bv = b[peer] ?? 0;
    if (av < bv) aLessThanB = true;
    else if (av > bv) bLessThanA = true;
  }
  if (!aLessThanB && !bLessThanA) return 'equal';
  if (aLessThanB && !bLessThanA) return 'before';
  if (bLessThanA && !aLessThanB) return 'after';
  return 'concurrent';
}

// ── LWW merge ────────────────────────────────────────────────────────────

export type MergeResult<T> =
  | { outcome: 'kept-local' | 'kept-remote' | 'equal'; winner: LWWEntry<T> }
  | { outcome: 'conflict'; winner: LWWEntry<T>; loser: LWWEntry<T> };

/**
 * Merge two LWW entries for the same logical key. Deterministic: the same
 * (local, remote) pair always produces the same winner across peers, so
 * a network that eventually delivers the same gossip to everyone converges
 * to the same state without coordination.
 *
 * Concurrent resolution: higher origin peerId lexicographically wins.
 * That's arbitrary but consistent — what matters is that every peer
 * agrees on the winner.
 */
export function merge<T>(local: LWWEntry<T>, remote: LWWEntry<T>): MergeResult<T> {
  const rel = compare(local.vclock, remote.vclock);
  if (rel === 'equal') return { outcome: 'equal', winner: local };
  if (rel === 'before') return { outcome: 'kept-remote', winner: remote };
  if (rel === 'after') return { outcome: 'kept-local', winner: local };
  // Concurrent
  const winner = local.origin >= remote.origin ? local : remote;
  const loser  = winner === local ? remote : local;
  return { outcome: 'conflict', winner, loser };
}

// ── Serialization helpers ────────────────────────────────────────────────

/**
 * Parse a compact "peerId:counter,peerId:counter" representation (used to
 * keep the vclock readable in topic frontmatter without blowing up into a
 * nested YAML block).
 */
export function parseVClockString(s: string | undefined | null): VClock {
  if (!s) return {};
  const out: VClock = {};
  for (const part of s.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.lastIndexOf(':');
    if (i < 0) continue;
    const peer = t.slice(0, i).trim();
    const n = parseInt(t.slice(i + 1).trim(), 10);
    if (peer && Number.isFinite(n)) out[peer] = n;
  }
  return out;
}

export function formatVClock(vclock: VClock): string {
  return Object.entries(vclock)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([peer, n]) => `${peer}:${n}`)
    .join(',');
}
