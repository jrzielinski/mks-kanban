/**
 * cluster/peer-card.ts — build & verify signed PeerInfoCard.
 *
 * The multicast beacon used to carry this metadata. With unicast LAN scan
 * discovery we need the same info delivered via the WS handshake (and
 * optionally via gossip responses), so signing/verification is centralised
 * here — identical rules apply regardless of transport.
 */

import * as os from 'os';
import { getIdentity, sign, verify, canonicalize, fingerprint } from './identity';
import { loadClusterConfig } from './config';
import { getServerLoad } from './server-load';
import type { PeerInfoCard } from './protocol';

const CARD_MAX_AGE_MS = 60_000; // reject cards older than 60s (replay protection)

/**
 * Snapshot our own metadata, sign it, return a card suitable to publish
 * via the WS handshake (hello-ack) or a gossip reply.
 */
export function buildSelfCard(): PeerInfoCard {
  const id = getIdentity();
  const cfg = loadClusterConfig();
  const { version } = require('../../../package.json');
  let loadHint: PeerInfoCard['loadHint'];
  const load = getServerLoad();
  if (load) {
    loadHint = {
      runningWorkers: load.running,
      maxWorkers: 4,
      cpuCount: load.cpuCount,
    };
  }

  const payload = {
    peerId: id.peerId,
    pubkey: id.pubkeyHex,
    hostname: os.hostname(),
    wsPort: cfg.listenPort,
    caps: ['read-only'] as string[],
    version,
    loadHint,
    timestamp: Date.now(),
  };
  const sig = sign(canonicalize(payload));
  return { ...payload, sig };
}

/**
 * Verify a card advertised by another peer. Checks in order:
 *   1. timestamp within replay window (60s)
 *   2. peerId matches fingerprint(pubkey) — impersonation guard
 *   3. signature validates under the advertised pubkey
 *
 * Returns the validated card on success, or a reason string on failure. The
 * caller decides whether to store the peer, log the rejection, or fail hard.
 */
export function verifyPeerCard(card: PeerInfoCard): { ok: true; card: PeerInfoCard } | { ok: false; reason: string } {
  if (!card || typeof card !== 'object') return { ok: false, reason: 'missing card' };
  const requiredFields: (keyof PeerInfoCard)[] = ['peerId', 'pubkey', 'hostname', 'wsPort', 'caps', 'version', 'timestamp', 'sig'];
  for (const field of requiredFields) {
    if (!(field in card)) return { ok: false, reason: `missing field ${String(field)}` };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(card.pubkey)) {
    return { ok: false, reason: 'malformed pubkey (expected 64 hex chars)' };
  }
  const drift = Math.abs(Date.now() - card.timestamp);
  if (drift > CARD_MAX_AGE_MS) {
    return { ok: false, reason: `card ${Math.round(drift / 1000)}s old (replay window ${CARD_MAX_AGE_MS / 1000}s)` };
  }
  const expected = fingerprint(card.pubkey);
  if (expected !== card.peerId) {
    return { ok: false, reason: `peerId ${card.peerId} does not match pubkey fingerprint ${expected}` };
  }
  // canonicalize must match the exact shape used in buildSelfCard — same key
  // order, same fields. No extra keys, no `sig` on the signed portion.
  const payload = {
    peerId: card.peerId,
    pubkey: card.pubkey,
    hostname: card.hostname,
    wsPort: card.wsPort,
    caps: card.caps,
    version: card.version,
    loadHint: card.loadHint,
    timestamp: card.timestamp,
  };
  if (!verify(canonicalize(payload), card.sig, card.pubkey)) {
    return { ok: false, reason: 'signature invalid for advertised pubkey' };
  }
  return { ok: true, card };
}
