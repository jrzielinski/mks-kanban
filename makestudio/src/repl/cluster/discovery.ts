import { swallow } from '../../utils/log';
/**
 * cluster/discovery.ts — LAN peer discovery via UDP multicast.
 *
 * Each instance (a) broadcasts a JSON beacon every BEACON_INTERVAL_MS to a
 * fixed multicast group, and (b) listens on the same group for beacons from
 * other MakeStudio instances. A peer that doesn't send a beacon for 3 beacon
 * intervals is considered gone and evicted from the registry.
 *
 * The beacon contains only non-sensitive metadata (peerId, hostname, wsPort,
 * capabilities, version, timestamp). The cluster secret is NEVER broadcast —
 * it's used later during the WebSocket handshake to authenticate the peer.
 *
 * Custom multicast (not mDNS/bonjour). mDNS would be nicer for interop, but
 * we only need MakeStudio ↔ MakeStudio discovery and writing the mDNS packet
 * format correctly is non-trivial; a simple JSON-over-UDP beacon is 80 lines
 * and zero dependencies.
 */

import * as dgram from 'dgram';
import * as os from 'os';
import { loadClusterConfig } from './config';
import { getIdentity, fingerprint, verify, canonicalize, sign } from './identity';
import {
  startSwim,
  stopSwim,
  getSwimPort,
  onBeaconSeen,
  getMemberState,
  onStateChange,
  SwimState,
} from './swim';
import { getServerLoad } from './server-load';
import { getProbeCallback } from './probe-registry';

// Discovery doesn't import auto-sync directly — that creates a static
// import cycle (discovery → auto-sync → client → discovery) since auto-sync
// reaches client.pullMemoryFromPeer and client reaches listPeers from here.
// Instead, auto-sync subscribes to start/stop via these hooks at module
// load time, and discovery just emits when its lifecycle changes.
type LifecycleListener = () => void;
const startListeners: LifecycleListener[] = [];
const stopListeners: LifecycleListener[] = [];

export function onDiscoveryStart(fn: LifecycleListener): void {
  startListeners.push(fn);
}

export function onDiscoveryStop(fn: LifecycleListener): void {
  stopListeners.push(fn);
}

function emitDiscoveryStart(): void {
  for (const fn of startListeners) {
    try { fn(); } catch (err) { swallow(err); }
  }
}

function emitDiscoveryStop(): void {
  for (const fn of stopListeners) {
    try { fn(); } catch (err) { swallow(err); }
  }
}

const BEACON_INTERVAL_MS = 5_000;
// 60s instead of 15s: the unicast LAN scanner only re-visits every 30s, so a
// 15s stale window caused spurious "peer left" → "peer joined" flapping
// between scans. Multicast beacons (when they work) still fire every 5s, so
// multicast peers refresh well within this window. 60s also gives load-hint
// (10s cadence on open WS connections) ample margin if one is missed.
const STALE_MS = 60_000;
const BEACON_TTL = 1; // LAN only — don't cross router

/**
 * Fixed pool of candidate multicast ports. All peers know this pool.
 * On startup, the LISTENER tries each in order until one binds — so if
 * a host process is squatting on 42042, we transparently land on 42043,
 * etc. The SENDER broadcasts to EVERY port in the pool, regardless of
 * which one we bound to. That way a peer listening on 42042 and a peer
 * listening on 42044 still find each other: both sides receive packets
 * destined for any port in the pool.
 *
 * Default moved from 42424 to 42042 because OrbStack's multicast DNS
 * responder binds UDP 42424 on macOS, forcing every dev laptop running
 * it into port fallback. 42042 has no known assignment.
 */
const PORT_POOL = [42042, 42043, 42044, 42045, 42046, 42047, 42048, 42049, 42050, 42051];

export interface PeerInfo {
  peerId: string;
  pubkey: string;        // hex Ed25519 pubkey — root of this peer's identity
  hostname: string;
  wsPort: number;
  caps: string[];       // ['read-only'] initially; Bash adds later if trusted
  version: string;
  address: string;       // source IP from the last beacon — needed to open WS
  /** SWIM liveness verdict. `alive` is the steady state; `suspect` means
   *  we didn't get a direct ack last probe and are waiting on indirect;
   *  `faulty` means both failed and the peer is considered down. Peers
   *  whose beacon never arrived are absent from this map entirely. */
  state: SwimState;
  loadHint?: {           // Fase 5 advertises this; Fase 1 leaves undefined
    runningWorkers: number;
    maxWorkers: number;
    cpuCount: number;
  };
  lastSeen: number;
}

interface Discovery {
  sender: dgram.Socket | null;
  listener: dgram.Socket | null;
  beaconTimer: NodeJS.Timeout | null;
  prunerTimer: NodeJS.Timeout | null;
  peers: Map<string, PeerInfo>;
  selfId: string;
}

let state: Discovery | null = null;

// Telemetry. Surfaced by /cluster debug so we can tell whether "no peers"
// means (a) nothing arrived, (b) arrived but failed auth, or (c) arrived
// and got stored but something else is dropping them from /cluster list.
interface DiscoveryStats {
  packetsReceived: number;
  packetsParsed: number;
  rejectedNotJson: number;
  rejectedWrongType: number;
  rejectedNoEnvelope: number;
  rejectedMissingFields: number;
  rejectedSelfEcho: number;
  rejectedBadFingerprint: number;
  rejectedBadSignature: number;
  rejectedPubkeyMismatch: number;
  peersAccepted: number;
  lastRejection: { reason: string; from: string; at: number } | null;
  lastAccepted: { peerId: string; from: string; at: number } | null;
  /** Interface IPs where we successfully joined the multicast group. */
  membershipsJoined: string[];
  /** Interface IPs where addMembership threw (usually OK — bridges, VMs). */
  membershipsFailed: Array<{ iface: string; error: string }>;
  /** Non-null when bind() or the overall setup threw (EADDRINUSE, lacks
   *  multicast permission, etc.). Keeps the diagnostic visible in
   *  /cluster debug instead of being silently swallowed by the caller. */
  bindError: string | null;
  /** Which port from PORT_POOL we actually ended up listening on. */
  listeningOnPort: number | null;
  /** Per-port bind attempts, with per-port error if applicable. */
  portAttempts: Array<{ port: number; ok: boolean; error?: string }>;
}
const stats: DiscoveryStats = {
  packetsReceived: 0, packetsParsed: 0,
  rejectedNotJson: 0, rejectedWrongType: 0, rejectedNoEnvelope: 0,
  rejectedMissingFields: 0, rejectedSelfEcho: 0,
  rejectedBadFingerprint: 0, rejectedBadSignature: 0, rejectedPubkeyMismatch: 0,
  peersAccepted: 0, lastRejection: null, lastAccepted: null,
  membershipsJoined: [], membershipsFailed: [], bindError: null,
  listeningOnPort: null, portAttempts: [],
};

export function getDiscoveryStats(): DiscoveryStats { return { ...stats }; }

export function isDiscoveryRunning(): boolean {
  return state !== null;
}

export function listPeers(): PeerInfo[] {
  if (!state) return [];
  const now = Date.now();
  // Prune inline for freshness. SWIM is the authoritative liveness
  // signal when running — a peer in suspect or faulty state must stay
  // in state.peers so listPeers() can surface that verdict. Only drop
  // peers that SWIM has fully GC'd (getMemberState → null) AND whose
  // last beacon is past the staleness window, OR peers that were
  // somehow never registered in SWIM to begin with (shouldn't happen
  // in practice, but the safety net is cheap).
  for (const [id, p] of state.peers.entries()) {
    const age = now - p.lastSeen;
    if (age <= STALE_MS) continue;
    if (getMemberState(id) !== null) continue; // SWIM still owns its lifecycle
    state.peers.delete(id);
  }
  // Merge in the live SWIM verdict. A missing SWIM entry (swim not running
  // or peer GC'd after being faulty) defaults to 'alive' so we don't
  // mis-report healthy peers during a SWIM outage.
  return Array.from(state.peers.values())
    .map((p) => ({ ...p, state: getMemberState(p.peerId) ?? 'alive' }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function buildBeacon(): Buffer {
  const cfg = loadClusterConfig();
  const id = getIdentity();
  const { version } = require('../../../package.json');
  // Include live load hint so remote coordinators can prefer less-busy peers
  // without a separate WS round-trip. getServerLoad returns null when the
  // server hasn't started — we just omit the hint in that case.
  let loadHint: PeerInfo['loadHint'] | undefined;
  const load = getServerLoad();
  if (load) {
    loadHint = {
      runningWorkers: load.running,
      maxWorkers: 4,
      cpuCount: load.cpuCount,
    };
  }

  // Signed portion — receiver recomputes canonical form and verifies.
  // `loadHint` is outside the signed payload: it changes frequently and
  // lying about it only affects load-balancing decisions (not security).
  const signed = {
    peerId: id.peerId,
    pubkey: id.pubkeyHex,
    hostname: os.hostname(),
    wsPort: cfg.listenPort,
    swimPort: getSwimPort() ?? 0,
    caps: ['read-only'], // widened to 'bash','write' once a peer trusts us
    version,
    ts: Date.now(),
  };
  const sig = sign(canonicalize(signed));

  const envelope = {
    type: 'makestudio-peer',
    signed,
    sig,
    loadHint,
  };
  return Buffer.from(JSON.stringify(envelope));
}

/**
 * Called by the WS client when it receives a verified serverInfo card in
 * hello-ack. Adds the peer to the registry if not already present, or
 * refreshes metadata if it is. Mirrors the multicast-beacon handler path but
 * is driven by unicast LAN discovery instead.
 *
 * Safe to call before startDiscovery has run (it's a no-op — the cluster
 * isn't active, we have nowhere to store the peer) so callers don't need to
 * guard.
 */
export function registerPeerFromCard(
  card: import('./protocol').PeerInfoCard,
  observedAddress?: string,
): { isNew: boolean } {
  if (!state) return { isNew: false };
  if (card.peerId === state.selfId) return { isNew: false };

  const existing = state.peers.get(card.peerId);
  if (existing && existing.pubkey !== card.pubkey) {
    stats.rejectedPubkeyMismatch += 1;
    stats.lastRejection = { reason: `pubkey-mismatch via hello`, from: observedAddress || card.hostname, at: Date.now() };
    return { isNew: false };
  }
  // A "real" record has wsPort > 0 (full card). A partial record from
  // registerPeerFromHello has wsPort === 0. Treat replacing a partial with
  // a full card as a NEW registration so the user still gets the "peer
  // joined" toast — but refreshing an already-full record is a no-op
  // notification-wise.
  const wasPartial = !existing || !existing.wsPort;
  state.peers.set(card.peerId, {
    peerId: card.peerId,
    pubkey: card.pubkey,
    hostname: card.hostname,
    wsPort: card.wsPort,
    caps: card.caps,
    version: card.version,
    address: observedAddress || existing?.address || card.hostname,
    state: 'alive',
    loadHint: card.loadHint,
    lastSeen: Date.now(),
  });
  if (wasPartial) {
    stats.peersAccepted += 1;
    stats.lastAccepted = { peerId: card.peerId, from: observedAddress || card.hostname, at: Date.now() };
    // Use the self-expiring transient status slot instead of a persistent
    // toast — peer-join/leave is housekeeping, the permanent signal is the
    // StatusLine's "cluster: N peers" count. Keeps the message log clean.
    try {
      const { setTransientStatus } = require('../tui/bridge');
      setTransientStatus?.(`cluster: + ${card.hostname}`, 4000);
    } catch (err) { swallow(err); }
  }
  return { isNew: wasPartial };
}

/**
 * Called by the server-side onConnection handler the moment a client's hello
 * is accepted. We don't have the client's full card yet (that arrives via a
 * future gossip reply) but we know their identity is verified, so we stash a
 * partial record so listPeers / pickBestPeer see them right away.
 */
export function registerPeerFromHello(peerId: string, pubkey: string, observedAddress?: string): { isNew: boolean } {
  if (!state || peerId === state.selfId) return { isNew: false };
  const existing = state.peers.get(peerId);
  if (existing) {
    existing.lastSeen = Date.now();
    if (observedAddress) existing.address = observedAddress;
    return { isNew: false };
  }
  state.peers.set(peerId, {
    peerId,
    pubkey,
    hostname: observedAddress || peerId,
    wsPort: 0, // unknown until they send a card
    caps: [],
    version: 'unknown',
    address: observedAddress || '0.0.0.0',
    state: 'alive',
    lastSeen: Date.now(),
  });
  stats.peersAccepted += 1;
  stats.lastAccepted = { peerId, from: observedAddress || peerId, at: Date.now() };
  return { isNew: true };
}

/**
 * Return the addresses of every known peer. The server peer-gossip handler
 * ships these so the requester can directly re-probe each one — fetching a
 * fresh signed card straight from the source, no cross-peer signature
 * forwarding needed.
 */
export function getPeerAddresses(): import('./protocol').PeerGossipAddress[] {
  if (!state) return [];
  const now = Date.now();
  const addrs: import('./protocol').PeerGossipAddress[] = [];
  for (const p of state.peers.values()) {
    if (!p.wsPort) continue; // we don't know how to reach them yet
    if (now - p.lastSeen > 10 * 60 * 1000) continue; // 10min stale cutoff
    addrs.push({ address: p.address, wsPort: p.wsPort, peerId: p.peerId });
  }
  return addrs;
}

/**
 * Pick the best peer for a read-only worker, considering advertised load.
 * Returns null when no peers are known or none look healthy.
 *
 * Heuristic: lowest runningWorkers / cpuCount ratio wins. Peers without a
 * loadHint are treated as 0/cpuCount (optimistic — better than excluding
 * first-boot peers before they broadcast their first load hint).
 */
export function pickBestPeer(): PeerInfo | null {
  if (!state || state.peers.size === 0) return null;
  const peers = listPeers();
  if (peers.length === 0) return null;

  const scored = peers.map((p) => {
    const running = p.loadHint?.runningWorkers ?? 0;
    const cpus = p.loadHint?.cpuCount ?? 4;
    return { peer: p, score: running / Math.max(1, cpus) };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0].peer;
}

export async function startDiscovery(): Promise<void> {
  if (state) return; // idempotent
  const cfg = loadClusterConfig();
  if (!cfg.enabled) return; // opt-in — user hasn't flipped the flag

  // Reset stats that depend on this start attempt.
  stats.bindError = null;
  stats.listeningOnPort = null;
  stats.portAttempts = [];
  stats.membershipsJoined = [];
  stats.membershipsFailed = [];

  // Sender socket — broadcasts our beacon. Separate socket so the sender's
  // ephemeral port doesn't collide with the listener binding.
  const sender = dgram.createSocket({ type: 'udp4' });

  // Build the try-in-order list. Start with cfg.multicastPort (preferred),
  // then every port in PORT_POOL that wasn't the preferred one.
  const prefer = cfg.multicastPort;
  const tryPorts = [prefer, ...PORT_POOL.filter((p) => p !== prefer)];

  // Attempt to bind one port. Resolves with the socket on success, null on
  // failure (also records the failure in stats.portAttempts).
  const tryBind = (port: number): Promise<dgram.Socket | null> => new Promise((resolve) => {
    const cand = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const onError = (err: any) => {
      stats.portAttempts.push({ port, ok: false, error: err?.message || String(err) });
      try { cand.close(); } catch (err) { swallow(err); }
      resolve(null);
    };
    cand.once('error', onError);
    cand.bind(port, () => {
      cand.removeListener('error', onError);
      resolve(cand);
    });
  });

  // Walk the candidate ports until one binds. If all fail we still land
  // with `listener == null` and give up with a clear bindError.
  let listener: dgram.Socket | null = null;
  let boundPort = 0;
  for (const port of tryPorts) {
    const bound = await tryBind(port);
    if (bound) {
      listener = bound;
      boundPort = port;
      stats.portAttempts.push({ port, ok: true });
      break;
    }
  }

  if (!listener) {
    const tried = stats.portAttempts.map((a) => `${a.port}${a.ok ? '' : ` (${a.error})`}`).join(', ');
    stats.bindError = `all ports in pool failed: ${tried}. Ports may be blocked by firewall or already held by another process.`;
    try { sender.close(); } catch (err) { swallow(err); }
    throw new Error(stats.bindError);
  }

  // Join the multicast group on EVERY non-internal IPv4 interface. Node's
  // default (no iface arg) picks ONE kernel-selected interface, which
  // silently drops all multicast arriving on the others. Hosts with
  // multiple interfaces (Mac with en0+en5+bridge100, or Linux with
  // eth0+docker0+tailscale0) routinely trigger this. We try all, accept
  // partial success, and report the result via stats so /cluster debug
  // shows exactly where we joined.
  const joined: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      try {
        listener.addMembership(cfg.multicastGroup, a.address);
        joined.push(a.address);
        stats.membershipsJoined.push(`${a.address} (${name})`);
      } catch (err: any) {
        stats.membershipsFailed.push({ iface: `${a.address} (${name})`, error: err?.message || String(err) });
      }
    }
  }
  if (joined.length === 0) {
    try { listener.addMembership(cfg.multicastGroup); stats.membershipsJoined.push('0.0.0.0 (default)'); }
    catch (err: any) {
      stats.bindError = `bound port ${boundPort} but addMembership failed on every interface: ${err?.message || String(err)}`;
      try { listener.close(); } catch (err) { swallow(err); }
      try { sender.close(); } catch (err) { swallow(err); }
      throw err;
    }
  }
  stats.listeningOnPort = boundPort;

  // Bind + join succeeded — NOW claim ownership of the global state.
  state = {
    sender,
    listener,
    beaconTimer: null,
    prunerTimer: null,
    peers: new Map(),
    selfId: cfg.peerId,
  };

  listener.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (!state) return;
    stats.packetsReceived += 1;
    const note = (reason: string) => {
      stats.lastRejection = { reason, from: rinfo.address, at: Date.now() };
    };
    let parsed: any;
    try {
      parsed = JSON.parse(msg.toString('utf8'));
    } catch {
      stats.rejectedNotJson += 1; note('not-json');
      return;
    }
    stats.packetsParsed += 1;
    if (!parsed || typeof parsed !== 'object') { stats.rejectedNotJson += 1; note('not-object'); return; }

    // SWIM has its own UDP socket on an ephemeral port so peers on the
    // same host don't contend for unicast packets delivered to the
    // shared multicast port. The beacon listener only handles beacons.
    if (parsed.type !== 'makestudio-peer') { stats.rejectedWrongType += 1; note(`wrong-type:${parsed.type}`); return; }

    // Envelope structure: { type, signed: {...}, sig, loadHint? }
    const signedPayload = parsed.signed;
    const sig = parsed.sig;
    if (!signedPayload || typeof sig !== 'string') {
      stats.rejectedNoEnvelope += 1; note('no-envelope (old unsigned format?)');
      return;
    }
    const { peerId, pubkey, wsPort, swimPort } = signedPayload;
    if (!peerId || !pubkey) { stats.rejectedMissingFields += 1; note('missing-peerId-or-pubkey'); return; }
    if (peerId === state.selfId) { stats.rejectedSelfEcho += 1; note('self-echo'); return; }

    // Self-certifying identity: peerId MUST equal fingerprint(pubkey).
    if (fingerprint(pubkey) !== peerId) {
      stats.rejectedBadFingerprint += 1; note(`bad-fingerprint peerId=${peerId}`);
      return;
    }
    // Signature proves possession of the corresponding private key.
    if (!verify(canonicalize(signedPayload), sig, pubkey)) {
      stats.rejectedBadSignature += 1; note(`bad-signature peerId=${peerId}`);
      return;
    }

    const existing = state.peers.get(peerId);
    // Pin pubkey on first sight: if a later beacon shows up with the same
    // peerId but a different pubkey, reject it. (Astronomically unlikely
    // for Ed25519 but guarded anyway.)
    if (existing && existing.pubkey !== pubkey) {
      stats.rejectedPubkeyMismatch += 1; note(`pubkey-mismatch peerId=${peerId}`);
      return;
    }

    state.peers.set(peerId, {
      peerId,
      pubkey,
      hostname: signedPayload.hostname || rinfo.address,
      wsPort: wsPort || 0,
      caps: Array.isArray(signedPayload.caps) ? signedPayload.caps : [],
      version: signedPayload.version || 'unknown',
      address: rinfo.address,
      state: 'alive', // overwritten by listPeers via getMemberState
      loadHint: parsed.loadHint,
      lastSeen: Date.now(),
    });
    stats.peersAccepted += 1;
    stats.lastAccepted = { peerId, from: rinfo.address, at: Date.now() };

    // Register/refresh in SWIM membership using the peer's own advertised
    // SWIM port. Skipping peers that advertise port 0 (pre-SWIM or broken)
    // avoids sending pings into the void.
    try {
      if (typeof swimPort === 'number' && swimPort > 0) {
        onBeaconSeen(peerId, rinfo.address, swimPort);
      }
    } catch (err) { swallow(err); }

    if (!existing) {
      try {
        const { setTransientStatus } = require('../tui/bridge');
        setTransientStatus?.(`cluster: + ${signedPayload.hostname}`, 4000);
      } catch (err) { swallow(err); }
    }
  });

  // Start SWIM BEFORE the first beacon so buildBeacon() can advertise the
  // SWIM port. SWIM binds its own ephemeral UDP port; two peers on the
  // same host thus receive their own unicast pings cleanly rather than
  // racing for packets delivered to the shared multicast port.
  await startSwim();

  // Memory auto-sync hooks into SWIM state transitions AND a periodic
  // tick. Must start AFTER startSwim so onStateChange has somewhere to
  // register. Eventual consistency layer — safe to skip in tests by
  // tolerating the ~30s first sync latency.
  emitDiscoveryStart();

  sender.bind(0, () => {
    try { sender.setMulticastTTL(BEACON_TTL); } catch (err) { swallow(err); }
    const send = () => {
      if (!state?.sender) return;
      const beacon = buildBeacon();
      // Broadcast on EVERY port in the pool, not just our bound port.
      // This lets two peers that ended up on different ports (e.g. peer A
      // bound 42424 normally, peer B fell back to 42425 because OrbStack
      // holds 42424) still discover each other — each side's listener is
      // pinned to one port, but the sender reaches all of them.
      for (const port of PORT_POOL) {
        try {
          state.sender.send(beacon, 0, beacon.length, port, cfg.multicastGroup);
        } catch (err) { swallow(err); }
      }
    };
    send(); // fire once immediately so peers see us without waiting 5s
    state!.beaconTimer = setInterval(send, BEACON_INTERVAL_MS);
    state!.beaconTimer.unref?.();
  });

  // Surface state transitions (alive ↔ suspect ↔ faulty) to the TUI. This
  // is what makes SWIM tangible to the user — "peer m-abc went faulty"
  // shows up in the log without having to poll /cluster list.
  onStateChange((m, prev) => {
    try {
      const hostname = state?.peers.get(m.peerId)?.hostname ?? '';
      const who = hostname || m.peerId;
      // SWIM state transitions as transient — permanent log was noisy during
      // normal operation (alive → suspect → alive blips from a 1.5s probe
      // timeout are routine on busy hosts).
      const { setTransientStatus } = require('../tui/bridge');
      setTransientStatus?.(`cluster: ${who} ${prev} → ${m.state}`, 4000);
    } catch (err) { swallow(err); }
  });

  // Periodic pruner — safety net for peers SWIM has already GC'd. While
  // a peer is still tracked by SWIM (alive/suspect/faulty), SWIM owns
  // its lifecycle and we leave state.peers alone so listPeers() can
  // surface the correct state.
  state.prunerTimer = setInterval(() => {
    if (!state) return;
    const now = Date.now();
    for (const [id, p] of state.peers.entries()) {
      if (now - p.lastSeen <= STALE_MS) continue;
      if (getMemberState(id) !== null) continue;
      {
        state.peers.delete(id);
        try {
          const { setTransientStatus } = require('../tui/bridge');
          setTransientStatus?.(`cluster: − ${p.hostname}`, 4000);
        } catch (err) { swallow(err); }
      }
    }
  }, BEACON_INTERVAL_MS);
  state.prunerTimer.unref?.();

  // Unicast LAN-scan discovery. Runs alongside the multicast beacon as a
  // belt-and-suspenders: multicast works on friendly LANs (home ethernet),
  // but silently fails on most Wi-Fi (AP isolation), cloud VPCs, docker
  // bridges, multi-NIC hosts, etc. The scanner hits every ARP-known host
  // with a TCP probe on the cluster port and hands survivors off to the
  // WS handshake, which fetches + verifies a signed card. After a peer is
  // registered, we also ask them for THEIR gossip list and probe each
  // address directly — that closes the transitive-discovery loop.
  try {
    const { startScanner } = require('./lan-scanner');
    // probe/gossip live in client.ts; client registers them on the probe
    // registry at module load so discovery doesn't have to import client
    // back (which used to create the discovery → client → discovery cycle).
    const callbacks = getProbeCallback();
    if (!callbacks) {
      // Client module hasn't loaded yet — without it we have no way to
      // perform the probe. /cluster enable's slash handler eagerly imports
      // auto-sync which transitively loads client, so by the time
      // startDiscovery runs callbacks should be set. Skip scanner setup
      // gracefully when they aren't (tests, embedded use, etc.).
      throw new Error('probe callbacks not registered — load cluster/auto-sync (or cluster/client) before startDiscovery');
    }
    const { probe: probePeerByAddress, gossip: gossipFromPeer } = callbacks;
    const inFlight = new Set<string>(); // dedupe: don't probe the same IP concurrently
    // 15s scan cadence (down from 30s default). With STALE_MS=60s, that's 4
    // handshakes per staleness window — plenty of redundancy so a single
    // missed probe doesn't evict the peer.
    startScanner(cfg.listenPort, async (ip: string) => {
      // 15s — handler below is the actual callback body; interval is the 3rd arg
      if (inFlight.has(ip)) return;
      inFlight.add(ip);
      try {
        const probed = await probePeerByAddress(ip, cfg.listenPort);
        if (!probed) return;
        // Find the peerId we just registered (probePeerByAddress stored the
        // verified card via registerPeerFromCard inside the hello-ack handler).
        const peer = Array.from(state?.peers.values() || []).find((p) => p.address === ip);
        if (!peer) return;
        // Fetch the server's known-peer list and probe each — transitive
        // discovery. Short-circuit if we already know each address.
        const addrs: import('./protocol').PeerGossipAddress[] = await gossipFromPeer(peer.peerId);
        for (const a of addrs) {
          if (inFlight.has(a.address)) continue;
          if (Array.from(state?.peers.values() || []).some((p) => p.address === a.address)) continue;
          inFlight.add(a.address);
          probePeerByAddress(a.address, a.wsPort).finally(() => inFlight.delete(a.address));
        }
      } finally {
        inFlight.delete(ip);
      }
    }, 15_000);
  } catch (err: any) {
    // LAN cluster discovery is opt-in (peer-to-peer agent feature). Failure
    // to start the scanner shouldn't spam the chat with a red error message
    // — it's noise for the 99% of users who don't use this feature. Log to
    // debug-log only; users running cluster commands will see the real
    // error when they call /cluster status.
    try {
      require('../debug-log').dbgWarn('cluster_lan_scanner_failed', {
        error: err?.message || String(err),
      });
    } catch (err) { swallow(err); }
  }
}

/**
 * Update the load hint for a peer (called from the WebSocket client when a
 * peer voluntarily reports its `load-hint`). Idempotent — a missing peer is
 * silently ignored (the beacon will register them on next tick).
 */
export function recordPeerLoad(peerId: string, hint: NonNullable<PeerInfo['loadHint']>): void {
  if (!state) return;
  const p = state.peers.get(peerId);
  if (p) {
    p.loadHint = hint;
    p.lastSeen = Date.now();
  }
}

export function stopDiscovery(): void {
  if (!state) return;
  emitDiscoveryStop();
  try { stopSwim(); } catch (err) { swallow(err); }
  try { require('./lan-scanner').stopScanner?.(); } catch (err) { swallow(err); }
  try { if (state.beaconTimer) clearInterval(state.beaconTimer); } catch (err) { swallow(err); }
  try { if (state.prunerTimer) clearInterval(state.prunerTimer); } catch (err) { swallow(err); }
  try { state.listener?.close(); } catch (err) { swallow(err); }
  try { state.sender?.close(); } catch (err) { swallow(err); }
  state = null;
}
