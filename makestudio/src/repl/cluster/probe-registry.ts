/**
 * cluster/probe-registry.ts — neutral DI seam between discovery (which
 * runs the LAN scanner) and client (which owns the WS handshake +
 * gossip RPCs needed to probe a candidate IP).
 *
 * Without this, discovery.ts had to lazy-require './client' to get hold
 * of probePeerByAddress / gossipFromPeer, which created a static cycle
 * (discovery → client → … → discovery). Now client registers the two
 * functions at module load and discovery just reads them through the
 * registry — neither side imports the other.
 */

import type { PeerGossipAddress } from './protocol';

export type ProbeFn = (ip: string, port: number) => Promise<string | null>;
export type GossipFn = (peerId: string) => Promise<PeerGossipAddress[]>;

let probeFn: ProbeFn | null = null;
let gossipFn: GossipFn | null = null;

export function setProbeCallback(probe: ProbeFn | null, gossip: GossipFn | null): void {
  probeFn = probe;
  gossipFn = gossip;
}

export function getProbeCallback(): { probe: ProbeFn; gossip: GossipFn } | null {
  if (!probeFn || !gossipFn) return null;
  return { probe: probeFn, gossip: gossipFn };
}
