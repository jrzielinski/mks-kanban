import { swallow } from '../../utils/log';
/**
 * cluster/auto-sync.ts — background memory sync with known peers.
 *
 * Fires two triggers:
 *   1. Periodic tick (default every 30s) picks the least-recently-synced
 *      alive peer and runs a memory pull. Covers newly-discovered peers
 *      (within one tick) and general drift correction.
 *   2. SWIM transition listener catches peers going `suspect|faulty →
 *      alive` and syncs immediately. Revived peers carry state the
 *      network missed while they were partitioned, so low-latency
 *      reconciliation matters more than periodic polling.
 *
 * Concurrency: at most one pull is in flight at any time. Sync is an
 * optional, eventual operation — stacking them only creates thundering
 * herd risk without helping convergence.
 *
 * Silence on failure: a peer that ack'd a SWIM ping 500ms ago may have
 * dropped its WebSocket listener by the time we dial. Surfacing that as
 * an error in the TUI would be noisy — we swallow it, the next tick
 * will retry if they're still around.
 */

import { listMembership, onStateChange, SwimMember } from './swim';
import { pullMemoryFromPeer } from './client';
import { onDiscoveryStart, onDiscoveryStop } from './discovery';

/** Override with MAKESTUDIO_AUTOSYNC_INTERVAL_MS=<n> for tuning or tests.
 *  Default 30s feels right on a LAN — long enough that load is invisible,
 *  short enough that a typed /memory save on peer A is usually on peer B
 *  by the time anyone asks for it. */
const PERIODIC_INTERVAL_MS = Math.max(
  1000,
  parseInt(process.env.MAKESTUDIO_AUTOSYNC_INTERVAL_MS || '', 10) || 30_000,
);
/** Minimum gap between two auto-pulls against the same peer. Guards
 *  against a flappy peer repeatedly crossing the alive threshold.
 *  Clamped to 1/3 of the periodic interval so tighter intervals still
 *  feel useful — at 5s periodic, gap becomes ~1.6s, not 10s. */
const MIN_GAP_MS = Math.min(10_000, Math.floor(PERIODIC_INTERVAL_MS / 3));

interface AutoSyncRuntime {
  timer: NodeJS.Timeout | null;
  removeStateListener: (() => void) | null;
  /** PeerId → last successful-or-attempted sync epoch ms. */
  lastAttemptAt: Map<string, number>;
  inFlight: boolean;
}

let rt: AutoSyncRuntime | null = null;

export function startMemoryAutoSync(): void {
  if (rt) return;
  rt = {
    timer: null,
    removeStateListener: null,
    lastAttemptAt: new Map(),
    inFlight: false,
  };
  rt.timer = setInterval(periodicTick, PERIODIC_INTERVAL_MS);
  rt.timer.unref?.();
  rt.removeStateListener = onStateChange((member, prev) => {
    if (member.state === 'alive' && (prev === 'suspect' || prev === 'faulty')) {
      // Revival — sync ASAP (microtask) so the peer's changes land before
      // anyone else observes the memory delta via us.
      void attemptSync(member.peerId, 'revived');
    }
  });
}

export function stopMemoryAutoSync(): void {
  if (!rt) return;
  if (rt.timer) clearInterval(rt.timer);
  rt.removeStateListener?.();
  rt = null;
}

export function isAutoSyncRunning(): boolean {
  return rt !== null;
}

/**
 * Read-only snapshot dos últimos sync attempts. Usado pela ClusterPage
 * pra mostrar "última sincronização: há Xmin" por peer.
 */
export function getLastSyncTimes(): Record<string, number> {
  if (!rt) return {};
  return Object.fromEntries(rt.lastAttemptAt.entries());
}

/** Timestamp ISO do sync mais recente. null quando nada foi sincronizado. */
export function getMostRecentSyncAt(): string | null {
  if (!rt) return null;
  let max = 0;
  for (const v of rt.lastAttemptAt.values()) if (v > max) max = v;
  return max > 0 ? new Date(max).toISOString() : null;
}

function periodicTick(): void {
  if (!rt) return;
  const alive = listMembership().filter((m) => m.state === 'alive');
  if (alive.length === 0) return;
  // Least-recently-synced first — never-synced peers (no entry in
  // lastAttemptAt) bubble to the top because `|| 0` ranks them oldest.
  const now = Date.now();
  const candidate = alive
    .filter((m) => now - (rt!.lastAttemptAt.get(m.peerId) ?? 0) >= MIN_GAP_MS)
    .sort((a, b) => (rt!.lastAttemptAt.get(a.peerId) ?? 0) - (rt!.lastAttemptAt.get(b.peerId) ?? 0))[0];
  if (!candidate) return;
  void attemptSync(candidate.peerId, 'periodic');
}

async function attemptSync(peerId: string, reason: 'periodic' | 'revived'): Promise<void> {
  if (!rt || rt.inFlight) return;
  const last = rt.lastAttemptAt.get(peerId);
  if (last && Date.now() - last < MIN_GAP_MS && reason === 'periodic') return;
  rt.inFlight = true;
  rt.lastAttemptAt.set(peerId, Date.now());
  try {
    const res = await pullMemoryFromPeer(peerId);
    if (process.env.MAKESTUDIO_DEBUG_AUTOSYNC) {
      // eslint-disable-next-line no-console
      console.log(`[autosync] ${reason} pull from ${peerId}: pulled=${res.pulled} skipped=${res.skipped}`);
    }
    if (res.pulled > 0 || res.applied.some((a: any) => a.outcome === 'conflict')) {
      surfaceToTui(peerId, reason, res);
    }
  } catch (err: any) {
    if (process.env.MAKESTUDIO_DEBUG_AUTOSYNC) {
      // eslint-disable-next-line no-console
      console.log(`[autosync] ${reason} pull from ${peerId} FAILED: ${err?.message || err}`);
    }
    /* Peer dropped between SWIM alive detection and WS dial — next tick
     * will retry. Intentionally silent in production to avoid log noise. */
  } finally {
    if (rt) rt.inFlight = false;
  }
}

/**
 * Pure: build the auto-sync summary line. Exposed for unit testing —
 * the TUI side is just bridge.setTransientStatus(formatted).
 */
export function formatAutoSyncSummary(
  peerId: string,
  reason: 'periodic' | 'revived',
  res: { pulled: number; applied: Array<{ outcome: string }>; skipped: number },
): { summary: string; conflicts: number } {
  const conflicts = res.applied.filter((a) => a.outcome === 'conflict').length;
  const label = reason === 'revived' ? 'auto-sync [revived]' : 'auto-sync';
  const summary = conflicts > 0
    ? `${label}: pulled ${res.pulled} from ${peerId}, ${conflicts} conflict(s) — /memory conflicts`
    : `${label}: pulled ${res.pulled} from ${peerId}`;
  return { summary, conflicts };
}

function surfaceToTui(
  peerId: string,
  reason: 'periodic' | 'revived',
  res: { pulled: number; applied: Array<{ outcome: string }>; skipped: number },
): void {
  const { summary, conflicts } = formatAutoSyncSummary(peerId, reason, res);
  try {
    // Housekeeping notification — goes to the StatusLine transient slot
    // ONLY. Was also pushing a permanent chat message when conflicts > 0
    // "so the user has to act" — but auto-sync ticks every ~30s and the
    // same unresolved conflict surfaces every tick, so the chat log fills
    // with `[cluster] auto-sync: pulled 4, 2 conflict(s)` repeated dozens
    // of times. Keep the transient — it's persistent enough at 8s on
    // conflicts — and let the user run /memory conflicts when ready.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bridge = require('../tui/bridge');
    bridge.setTransientStatus?.(summary, conflicts > 0 ? 8000 : 4000);
  } catch (err) { swallow(err); }
}

// Subscribe to discovery's lifecycle so /cluster enable wires us up
// without discovery having to know about auto-sync (that direction would
// re-introduce the discovery → auto-sync → client → discovery cycle).
onDiscoveryStart(startMemoryAutoSync);
onDiscoveryStop(stopMemoryAutoSync);

