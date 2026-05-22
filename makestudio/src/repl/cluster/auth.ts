/**
 * cluster/auth.ts — Ed25519 signature-based handshake.
 *
 * Every peer has its own keypair in ~/.makestudio/cluster-identity.json. On
 * WS connect the client sends `hello` with:
 *
 *   - peerId      (self-identifier; MUST equal fingerprint(pubkey))
 *   - pubkey      (hex-encoded raw Ed25519 public key, 64 chars)
 *   - timestamp   (ms since epoch; must be within REPLAY_WINDOW_MS)
 *   - version     (informational)
 *   - sig         (signature over canonical JSON of the above fields)
 *
 * The server verifies, in order:
 *   1. timestamp within replay window
 *   2. peerId matches fingerprint of the advertised pubkey
 *   3. sig validates under the advertised pubkey
 *
 * If all three pass, the peer is authenticated AS that peerId. Trust
 * (what they can do) is a separate decision — see trust.ts.
 *
 * Replaces the previous shared-HMAC scheme. No cluster secret to copy
 * across machines anymore; each peer advertises its own pubkey and trust
 * is granted out-of-band via `/cluster trust <peerId>`.
 */

import { fingerprint, verify, canonicalize, sign } from './identity';

const REPLAY_WINDOW_MS = 60_000;

export interface HelloPayload {
  peerId: string;
  pubkey: string;
  timestamp: number;
  version: string;
}

/**
 * Produce the signed portion of a hello message. Keeps canonical ordering
 * centralized so sender and receiver agree byte-for-byte on what was signed.
 */
export function buildHelloSig(payload: HelloPayload): string {
  return sign(canonicalize(payload));
}

export function verifyHello(
  payload: HelloPayload,
  sigHex: string,
): { ok: true } | { ok: false; reason: string } {
  const drift = Math.abs(Date.now() - payload.timestamp);
  if (drift > REPLAY_WINDOW_MS) {
    return { ok: false, reason: `timestamp drift ${Math.round(drift / 1000)}s exceeds replay window` };
  }
  // pubkey must be 32 bytes hex (raw Ed25519 public key)
  if (!/^[0-9a-fA-F]{64}$/.test(payload.pubkey)) {
    return { ok: false, reason: 'malformed pubkey (expected 64 hex chars)' };
  }
  const expectedPeerId = fingerprint(payload.pubkey);
  if (expectedPeerId !== payload.peerId) {
    return { ok: false, reason: `peerId ${payload.peerId} does not match pubkey fingerprint ${expectedPeerId} (impersonation attempt)` };
  }
  if (!verify(canonicalize(payload), sigHex, payload.pubkey)) {
    return { ok: false, reason: 'signature invalid for advertised pubkey' };
  }
  return { ok: true };
}
