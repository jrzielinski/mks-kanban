/**
 * cluster/snapshot.ts — composição read-only do estado do cluster pra UI.
 *
 * Combina identity + discovery + swim + trust + auto-sync num único snapshot
 * serializável (DTO). Sem efeitos colaterais. Pode ser chamado a qualquer
 * momento — operações de membership ficam atrás dos seus respectivos modules.
 */

import { getIdentity } from './identity';
import { loadClusterConfig } from './config';
import { listPeers, getDiscoveryStats } from './discovery';
import { listMembership, getMemberState, getSwimStats, isSwimRunning, SwimState } from './swim';
import { listPeerTrust, getPeerTrust } from './trust';
import { isAutoSyncRunning, getLastSyncTimes, getMostRecentSyncAt } from './auto-sync';

export interface ClusterSnapshotPeer {
  peerId: string;
  pubkey?: string;
  hostname?: string;
  address?: string;
  wsPort?: number;
  swimState: 'alive' | 'suspect' | 'faulty' | 'unknown';
  caps?: string[];
  version?: string;
  loadHint?: number;
  lastSeen: string;       // ISO
  trusted: boolean;
  latencyMs?: number;
  lastSyncAt?: string;    // ISO ou ausente
}

export interface ClusterSnapshot {
  selfPeerId: string;
  selfPubkey?: string;
  enabled: boolean;
  listenPort: number;
  multicastGroup: string;
  multicastPort: number;
  swimRunning: boolean;
  autoSyncRunning: boolean;
  peers: ClusterSnapshotPeer[];
  trust: Array<{
    peerId: string;
    global: { allowBash: boolean; allowWrite: boolean };
    scopes: Array<{ path: string; allowBash: boolean; allowWrite: boolean }>;
  }>;
  discoveryStats: ReturnType<typeof getDiscoveryStats>;
  swimStats: { alive: number; suspect: number; faulty: number; pings: number; indirectPings: number } | null;
  lastSyncAt?: string;
}

export function getClusterSnapshot(): ClusterSnapshot {
  const ident = getIdentity();
  const cfg = loadClusterConfig();
  const peers = listPeers();
  const lastSyncMap = getLastSyncTimes();
  const trust = listPeerTrust();

  const out: ClusterSnapshot = {
    selfPeerId: ident.peerId,
    selfPubkey: ident.pubkeyHex,
    enabled: cfg.enabled,
    listenPort: cfg.listenPort,
    multicastGroup: cfg.multicastGroup,
    multicastPort: cfg.multicastPort,
    swimRunning: isSwimRunning(),
    autoSyncRunning: isAutoSyncRunning(),
    peers: peers.map((p): ClusterSnapshotPeer => {
      const swimMember = getMemberState(p.peerId);
      const peerTrust = getPeerTrust(p.peerId);
      // loadHint is an object {runningWorkers, maxWorkers, cpuCount} — expose as ratio 0..1
      const loadHintNum = p.loadHint
        ? p.loadHint.runningWorkers / Math.max(p.loadHint.cpuCount, 1)
        : undefined;
      return {
        peerId: p.peerId,
        pubkey: p.pubkey,
        hostname: p.hostname,
        address: p.address,
        wsPort: p.wsPort,
        swimState: swimMember ?? 'unknown',
        caps: p.caps,
        version: p.version,
        loadHint: loadHintNum,
        lastSeen: typeof p.lastSeen === 'number'
          ? new Date(p.lastSeen).toISOString()
          : new Date(0).toISOString(),
        trusted: Boolean(peerTrust?.allowBash || peerTrust?.allowWrite),
        lastSyncAt: lastSyncMap[p.peerId]
          ? new Date(lastSyncMap[p.peerId]).toISOString()
          : undefined,
      };
    }),
    trust: trust.map((t) => ({
      peerId: t.peerId,
      global: {
        allowBash: Boolean(t.global?.allowBash),
        allowWrite: Boolean(t.global?.allowWrite),
      },
      scopes: (t.scopes ?? []).map((s) => ({
        path: s.path,
        allowBash: Boolean(s.allowBash),
        allowWrite: Boolean(s.allowWrite),
      })),
    })),
    discoveryStats: getDiscoveryStats(),
    swimStats: (() => {
      if (!isSwimRunning()) return null;
      const members = listMembership();
      const rawStats = getSwimStats();
      const countByState = (state: SwimState) => members.filter((m) => m.state === state).length;
      return {
        alive: countByState('alive'),
        suspect: countByState('suspect'),
        faulty: countByState('faulty'),
        pings: rawStats?.directProbesSent ?? 0,
        indirectPings: rawStats?.indirectProbesSent ?? 0,
      };
    })(),
    lastSyncAt: getMostRecentSyncAt() ?? undefined,
  };
  return out;
}
