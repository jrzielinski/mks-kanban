import { swallow } from '../../utils/log';
/**
 * cluster/swim.ts — SWIM-lite failure detection and membership gossip.
 *
 * Why SWIM: the original discovery used "if I haven't heard a beacon from
 * peer X in 15s, drop it." That's O(N) bandwidth at every peer (each beacon
 * every 5s) and detection latency is stuck at 3×beacon_interval. SWIM
 * decouples detection from beaconing: a single random probe per tick plus
 * indirect probes and gossip gives sub-3s failure detection independent of
 * cluster size, with bandwidth roughly constant per node.
 *
 * Simplifications relative to the full paper (acceptable for our scale):
 *   - NO incarnation numbers. A peer that dies and comes back has the same
 *     Ed25519 identity; the next beacon they send flips their state back to
 *     alive with a fresher `stateChangedAt`, so stale "faulty" gossip about
 *     them is rejected by timestamp-LWW on the receiver side.
 *   - K_INDIRECT = 1 (one indirect probe on direct timeout). Paper suggests
 *     3-5 for reliability; on a LAN with a handful of peers, one is fine.
 *   - Gossip piggyback capped at 3 updates per packet to stay well under
 *     MTU. For clusters of up to ~20 peers, convergence is still <10s.
 *   - Direct-probe target is picked uniformly at random from alive peers.
 *     Full SWIM randomizes more carefully (round-robin through a shuffled
 *     list) to guarantee every peer is probed within N ticks. We get
 *     there in expectation rather than in the worst case.
 *
 * Transport: we piggyback on the existing UDP socket that discovery.ts
 * uses for multicast beacons. A dgram socket bound to the multicast port
 * with `reuseAddr` receives BOTH multicast and unicast, so we can target a
 * peer with `socket.send(buf, peer.address, multicastPort)`. No new port.
 */

import * as dgram from 'dgram';
import { randomBytes } from 'crypto';
import { getIdentity } from './identity';

// ── Tunables ─────────────────────────────────────────────────────────────
const T_PROBE_MS = 1500;       // One probe per tick.
const T_DIRECT_MS = 700;       // Wait for direct ack before falling back.
const T_INDIRECT_MS = 2000;    // Wait for any indirect ack before giving up.
const T_SUSPECT_MS = 8000;     // Suspect → faulty after this.
const T_FAULTY_GC_MS = 60_000; // Drop faulty peer from membership after this.
const K_INDIRECT = 1;          // Number of indirect probes on direct-ping timeout.
const GOSSIP_SAMPLE = 3;       // Max membership updates attached per packet.

// ── Types ────────────────────────────────────────────────────────────────
export type SwimState = 'alive' | 'suspect' | 'faulty';

export interface SwimMember {
  peerId: string;
  address: string;
  port: number;
  state: SwimState;
  stateChangedAt: number; // ms epoch — drives LWW on gossip merges
  lastAckAt: number;      // last successful ping-ack
}

interface PingPayload {
  type: 'swim-ping';
  id: string;
  from: string;
  updates: GossipUpdate[];
}

interface AckPayload {
  type: 'swim-ack';
  id: string;
  from: string;
  updates: GossipUpdate[];
}

/** Ping-req: "please ping <target> on my behalf and tell me if they ack." */
interface PingReqPayload {
  type: 'swim-ping-req';
  id: string;              // correlation id the requester will use to match the indirect-ack
  from: string;            // requester peerId
  targetPeerId: string;
  targetAddress: string;
  targetPort: number;
  updates: GossipUpdate[];
}

/** Indirect-ack: intermediate relaying target's ack back to the requester. */
interface IndirectAckPayload {
  type: 'swim-indirect-ack';
  id: string;
  from: string;
  targetPeerId: string;
  updates: GossipUpdate[];
}

type SwimMessage = PingPayload | AckPayload | PingReqPayload | IndirectAckPayload;

interface GossipUpdate {
  peerId: string;
  state: SwimState;
  at: number;
}

// ── Internal state ───────────────────────────────────────────────────────
interface SwimRuntime {
  socket: dgram.Socket;
  selfId: string;
  /** Ephemeral UDP port this peer listens on for SWIM unicast. Advertised
   *  in beacons so other peers know where to direct their pings. */
  port: number;
  membership: Map<string, SwimMember>;
  probeTimer: NodeJS.Timeout | null;
  faultyGcTimer: NodeJS.Timeout | null;
  suspectTimers: Map<string, NodeJS.Timeout>;
  directPending: Map<string, { targetId: string; timer: NodeJS.Timeout }>;
  indirectRequesting: Map<string, { targetId: string; timer: NodeJS.Timeout; relays: number }>;
  /** Relay: I forwarded a ping on behalf of a requester. Keyed by the
   *  NEW id I picked when forwarding (`relayedId`). When the target acks
   *  with that id, I translate back to the requester's `correlationId`
   *  and send `swim-indirect-ack` to them. */
  indirectRelaying: Map<string, {
    correlationId: string;
    targetPeerId: string;
    requesterAddress: string;
    requesterPort: number;
  }>;
  stats: {
    directProbesSent: number;
    directAcksReceived: number;
    indirectProbesSent: number;
    indirectAcksReceived: number;
    gossipApplied: number;
    markedFaulty: number;
  };
  /** Listeners fired when a peer transitions state — used by the TUI layer
   *  to surface "peer went faulty" messages. */
  stateListeners: Array<(m: SwimMember, prev: SwimState) => void>;
}

let rt: SwimRuntime | null = null;

// ── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Start SWIM. Binds its own UDP socket on an ephemeral port so two peers
 * on the same host don't contend for unicast packets delivered to the
 * shared multicast port. Resolves with the bound port so discovery can
 * advertise it in the signed beacon.
 */
export async function startSwim(): Promise<number> {
  if (rt) return rt.port;
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const port = socket.address().port;
  rt = {
    socket,
    selfId: getIdentity().peerId,
    port,
    membership: new Map(),
    probeTimer: null,
    faultyGcTimer: null,
    suspectTimers: new Map(),
    directPending: new Map(),
    indirectRequesting: new Map(),
    indirectRelaying: new Map(),
    stats: {
      directProbesSent: 0,
      directAcksReceived: 0,
      indirectProbesSent: 0,
      indirectAcksReceived: 0,
      gossipApplied: 0,
      markedFaulty: 0,
    },
    stateListeners: [],
  };
  socket.on('message', (raw: Buffer, rinfo: dgram.RemoteInfo) => {
    let parsed: any;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (parsed && typeof parsed.type === 'string' && parsed.type.startsWith('swim-')) {
      handleSwimMessage(parsed, rinfo);
    }
  });
  rt.probeTimer = setInterval(probeTick, T_PROBE_MS);
  rt.probeTimer.unref?.();
  rt.faultyGcTimer = setInterval(faultyGcTick, T_FAULTY_GC_MS / 2);
  rt.faultyGcTimer.unref?.();
  return port;
}

export function stopSwim(): void {
  if (!rt) return;
  if (rt.probeTimer) clearInterval(rt.probeTimer);
  if (rt.faultyGcTimer) clearInterval(rt.faultyGcTimer);
  for (const t of rt.suspectTimers.values()) clearTimeout(t);
  for (const p of rt.directPending.values()) clearTimeout(p.timer);
  for (const p of rt.indirectRequesting.values()) clearTimeout(p.timer);
  try { rt.socket.close(); } catch (err) { swallow(err); }
  rt = null;
}

export function isSwimRunning(): boolean {
  return rt !== null;
}

export function getSwimPort(): number | null {
  return rt ? rt.port : null;
}

// ── Membership public API ────────────────────────────────────────────────

/**
 * Called by discovery.ts when a beacon arrives. First sight = add as alive;
 * reappearance of a faulty peer = mark alive (they're obviously not faulty
 * if they can send beacons). Address and port are always refreshed because
 * a peer may have moved (DHCP lease renewed, etc.).
 */
export function onBeaconSeen(peerId: string, address: string, port: number): void {
  if (!rt || peerId === rt.selfId) return;
  const existing = rt.membership.get(peerId);
  const now = Date.now();
  if (!existing) {
    rt.membership.set(peerId, {
      peerId,
      address,
      port,
      state: 'alive',
      stateChangedAt: now,
      lastAckAt: now,
    });
    return;
  }
  existing.address = address;
  existing.port = port;
  if (existing.state !== 'alive') setState(existing, 'alive');
}

export function listMembership(): SwimMember[] {
  if (!rt) return [];
  return Array.from(rt.membership.values());
}

export function getMemberState(peerId: string): SwimState | null {
  if (!rt) return null;
  return rt.membership.get(peerId)?.state ?? null;
}

export function getSwimStats(): SwimRuntime['stats'] | null {
  return rt ? { ...rt.stats } : null;
}

export function onStateChange(fn: (m: SwimMember, prev: SwimState) => void): () => void {
  if (!rt) return () => {};
  rt.stateListeners.push(fn);
  return () => {
    if (!rt) return;
    const i = rt.stateListeners.indexOf(fn);
    if (i >= 0) rt.stateListeners.splice(i, 1);
  };
}

// ── Inbound message handling (called from discovery.ts dispatcher) ──────

export function handleSwimMessage(raw: any, rinfo: dgram.RemoteInfo): void {
  if (!rt || !raw || typeof raw !== 'object') return;
  const msg = raw as SwimMessage;
  switch (msg.type) {
    case 'swim-ping':         return onPing(msg, rinfo);
    case 'swim-ack':          return onAck(msg);
    case 'swim-ping-req':     return onPingReq(msg, rinfo);
    case 'swim-indirect-ack': return onIndirectAck(msg);
  }
}

// ── Probe loop ───────────────────────────────────────────────────────────

function probeTick(): void {
  if (!rt) return;
  const candidates = Array.from(rt.membership.values()).filter(
    (m) => m.peerId !== rt!.selfId && m.state !== 'faulty',
  );
  if (candidates.length === 0) return;
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  sendDirectPing(target);
}

function sendDirectPing(target: SwimMember): void {
  if (!rt) return;
  const id = 'p-' + randomBytes(6).toString('hex');
  const payload: PingPayload = {
    type: 'swim-ping',
    id,
    from: rt.selfId,
    updates: sampleGossip(),
  };
  rt.stats.directProbesSent++;
  send(payload, target.address, target.port);

  const timer = setTimeout(() => onDirectTimeout(target, id), T_DIRECT_MS);
  timer.unref?.();
  rt.directPending.set(id, { targetId: target.peerId, timer });
}

function onDirectTimeout(target: SwimMember, directId: string): void {
  if (!rt) return;
  rt.directPending.delete(directId);
  // If the target's state has already moved on (maybe a ping from them
  // arrived and we marked them alive), skip indirect probe.
  const current = rt.membership.get(target.peerId);
  if (!current || current.state === 'faulty') return;
  launchIndirectProbe(target);
}

function launchIndirectProbe(target: SwimMember): void {
  if (!rt) return;
  const relays = Array.from(rt.membership.values()).filter(
    (m) => m.peerId !== rt!.selfId && m.peerId !== target.peerId && m.state === 'alive',
  );
  if (relays.length === 0) {
    // No one else alive to ask. Go straight to suspect.
    markSuspect(target);
    return;
  }
  const picked = relays.slice(0, K_INDIRECT);
  const correlationId = 'ir-' + randomBytes(6).toString('hex');
  rt.stats.indirectProbesSent++;

  for (const relay of picked) {
    const payload: PingReqPayload = {
      type: 'swim-ping-req',
      id: correlationId,
      from: rt.selfId,
      targetPeerId: target.peerId,
      targetAddress: target.address,
      targetPort: target.port,
      updates: sampleGossip(),
    };
    send(payload, relay.address, relay.port);
  }

  const timer = setTimeout(() => onIndirectTimeout(target, correlationId), T_INDIRECT_MS);
  timer.unref?.();
  rt.indirectRequesting.set(correlationId, { targetId: target.peerId, timer, relays: picked.length });
}

function onIndirectTimeout(target: SwimMember, correlationId: string): void {
  if (!rt) return;
  if (!rt.indirectRequesting.has(correlationId)) return; // acked in time
  rt.indirectRequesting.delete(correlationId);
  markSuspect(target);
}

function markSuspect(target: SwimMember): void {
  if (!rt) return;
  const member = rt.membership.get(target.peerId);
  if (!member || member.state === 'faulty' || member.state === 'suspect') return;
  setState(member, 'suspect');
  // Scheduled transition to faulty. If a beacon or successful ping arrives
  // meanwhile, markAlive will cancel this timer.
  const t = setTimeout(() => {
    if (!rt) return;
    const m = rt.membership.get(target.peerId);
    if (!m || m.state !== 'suspect') return;
    setState(m, 'faulty');
    rt.stats.markedFaulty++;
    rt.suspectTimers.delete(target.peerId);
  }, T_SUSPECT_MS);
  t.unref?.();
  rt.suspectTimers.set(target.peerId, t);
}

function markAlive(peerId: string): void {
  if (!rt) return;
  const member = rt.membership.get(peerId);
  if (!member) return;
  const susp = rt.suspectTimers.get(peerId);
  if (susp) {
    clearTimeout(susp);
    rt.suspectTimers.delete(peerId);
  }
  member.lastAckAt = Date.now();
  if (member.state !== 'alive') setState(member, 'alive');
}

function setState(member: SwimMember, next: SwimState): void {
  if (!rt) return;
  const prev = member.state;
  if (prev === next) return;
  member.state = next;
  member.stateChangedAt = Date.now();
  for (const fn of rt.stateListeners) {
    try { fn(member, prev); } catch (err) { swallow(err); }
  }
}

// ── Message handlers ─────────────────────────────────────────────────────

function onPing(msg: PingPayload, rinfo: dgram.RemoteInfo): void {
  if (!rt) return;
  applyGossip(msg.updates);
  // Refresh sender's address — DHCP or NAT may have moved them since the
  // last beacon. Port we reply to is our own multicast/listen port.
  const sender = rt.membership.get(msg.from);
  if (sender) sender.address = rinfo.address;

  // Reply with ack, piggybacking our own gossip.
  const ack: AckPayload = {
    type: 'swim-ack',
    id: msg.id,
    from: rt.selfId,
    updates: sampleGossip(),
  };
  send(ack, rinfo.address, rinfo.port);
  // Being pinged is itself proof they're alive — treat as evidence.
  if (sender) markAlive(msg.from);
}

function onAck(msg: AckPayload): void {
  if (!rt) return;
  applyGossip(msg.updates);

  // Path 1 — I sent this ping directly: clear pending + mark alive.
  const pending = rt.directPending.get(msg.id);
  if (pending) {
    clearTimeout(pending.timer);
    rt.directPending.delete(msg.id);
    rt.stats.directAcksReceived++;
    markAlive(pending.targetId);
  }

  // Path 2 — I forwarded this ping on someone's behalf: translate the ack
  // back to the original correlationId and deliver it as an indirect-ack
  // to the original requester. Also treat the target as alive in my own
  // membership view (they answered, after all).
  const relay = rt.indirectRelaying.get(msg.id);
  if (relay) {
    rt.indirectRelaying.delete(msg.id);
    markAlive(relay.targetPeerId);
    const indirectAck: IndirectAckPayload = {
      type: 'swim-indirect-ack',
      id: relay.correlationId,
      from: rt.selfId,
      targetPeerId: relay.targetPeerId,
      updates: sampleGossip(),
    };
    send(indirectAck, relay.requesterAddress, relay.requesterPort);
  }
}

function onPingReq(msg: PingReqPayload, rinfo: dgram.RemoteInfo): void {
  if (!rt) return;
  applyGossip(msg.updates);

  // Forward the ping to the target with a NEW id. We remember the mapping
  // (relayedId → requester + correlationId + target) so that when the
  // target acks, we can translate back to an indirect-ack for the
  // requester using their original correlationId.
  const relayedId = 'pr-' + randomBytes(6).toString('hex');
  rt.indirectRelaying.set(relayedId, {
    correlationId: msg.id,
    targetPeerId: msg.targetPeerId,
    requesterAddress: rinfo.address,
    requesterPort: rinfo.port,
  });
  // Keep the relay entry bounded even if the target never acks.
  const gcTimer = setTimeout(() => rt?.indirectRelaying.delete(relayedId), T_DIRECT_MS * 2);
  gcTimer.unref?.();

  const ping: PingPayload = {
    type: 'swim-ping',
    id: relayedId,
    from: rt.selfId,
    updates: sampleGossip(),
  };
  send(ping, msg.targetAddress, msg.targetPort);
}

function onIndirectAck(msg: IndirectAckPayload): void {
  if (!rt) return;
  applyGossip(msg.updates);
  const pending = rt.indirectRequesting.get(msg.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  rt.indirectRequesting.delete(msg.id);
  rt.stats.indirectAcksReceived++;
  markAlive(pending.targetId);
}

// ── Outbound + gossip helpers ────────────────────────────────────────────

function send(payload: SwimMessage, address: string, port: number): void {
  if (!rt) return;
  try {
    const buf = Buffer.from(JSON.stringify(payload));
    rt.socket.send(buf, 0, buf.length, port, address);
  } catch (err) { swallow(err); }
}

/**
 * Pick up to GOSSIP_SAMPLE members whose state we want to propagate. Bias
 * toward recent state changes (they're the "news"). Excludes self.
 */
function sampleGossip(): GossipUpdate[] {
  if (!rt) return [];
  const all = Array.from(rt.membership.values())
    .filter((m) => m.peerId !== rt!.selfId)
    .sort((a, b) => b.stateChangedAt - a.stateChangedAt);
  return all.slice(0, GOSSIP_SAMPLE).map((m) => ({
    peerId: m.peerId,
    state: m.state,
    at: m.stateChangedAt,
  }));
}

function applyGossip(updates: GossipUpdate[] | undefined): void {
  if (!rt || !Array.isArray(updates)) return;
  for (const u of updates) {
    if (!u?.peerId || u.peerId === rt.selfId) continue;
    const existing = rt.membership.get(u.peerId);
    if (!existing) continue; // gossip about a peer we've never seen — skip until their beacon arrives
    if (u.at <= existing.stateChangedAt) continue; // stale — we have fresher data
    // Timestamp-LWW adoption. Two gossip messages with identical `at` are
    // tolerated because `state` is deterministic (peerId is stable, states
    // are an enum).
    const prev = existing.state;
    if (prev === u.state) continue;
    existing.state = u.state;
    existing.stateChangedAt = u.at;
    rt.stats.gossipApplied++;
    for (const fn of rt.stateListeners) {
      try { fn(existing, prev); } catch (err) { swallow(err); }
    }
  }
}

// ── Faulty GC ────────────────────────────────────────────────────────────

function faultyGcTick(): void {
  if (!rt) return;
  const now = Date.now();
  for (const [id, m] of rt.membership) {
    if (m.state === 'faulty' && now - m.stateChangedAt > T_FAULTY_GC_MS) {
      rt.membership.delete(id);
    }
  }
}
