import { swallow } from '../../utils/log';
/**
 * cluster/client.ts — WebSocket client used by the coordinator to dispatch
 * work onto a remote peer.
 *
 * One connection per (peerId, session) — we lazily open when the first
 * request fires, and cache the socket so follow-up calls reuse it. A closed
 * socket triggers re-open on next use.
 */

// ws v7 returns WebSocket as module.exports; ws v8 adds a named export.
// Runtime-resolve the class; `any` typing sidesteps @types/ws v8 friction
// with v7 runtime (see cluster/server.ts for the same rationale).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wsModule: any = require('ws');
const WebSocket: any = wsModule.WebSocket || wsModule;
type WsSocket = any;
import { randomBytes } from 'crypto';
import { getIdentity } from './identity';
import { buildHelloSig } from './auth';
import { listPeers, PeerInfo } from './discovery';
import { setProbeCallback } from './probe-registry';
import {
  ProtocolMessage,
  SpawnResultMessage,
  ScratchReadResultMessage,
  ScratchWriteResultMessage,
  MemoryDigestResultMessage,
  MemoryPullResultMessage,
  PeerGossipResultMessage,
  PeerGossipAddress,
} from './protocol';

interface PendingRequest {
  resolve: (msg: ProtocolMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  sock: WsSocket;
  pending: Map<string, PendingRequest>;
  serverPeerId: string;
  ready: Promise<void>;
  /** The coordinator's ReplContext. Set by spawnWorkerOnPeer and consumed by
   *  the inbound tool-call handler so the remote worker's Read/Glob/etc
   *  runs against the coordinator's FS+project. */
  originCtx?: any;
  /** PeerId of the server we connected to — used to look up trust config. */
  remotePeerId?: string;
}

const connections = new Map<string, Connection>();
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 15min — matches subagent timeout budget

// Count of reverse-dispatched spawns this machine is currently serving for
// remote coordinators. Surfaced on the StatusLine as "cluster: ... N serving"
// so the user sees their machine is being used as a worker by peers.
let servingCount = 0;
export function getClusterServingCount(): number { return servingCount; }

function resolvePeer(peerId: string): PeerInfo | null {
  return listPeers().find((p) => p.peerId === peerId) || null;
}

function newRequestId(): string {
  return 'req-' + randomBytes(6).toString('hex');
}

/**
 * Run a spawn-worker request that arrived on our CLIENT-side socket (i.e.
 * the sock we opened to a peer during LAN scan). This is the reverse-
 * dispatch path: a coordinator whose OS blocks outbound LAN (macOS 15) can
 * still delegate by pushing spawn-worker through the connection WE opened.
 *
 * We process it the same way server.ts would — same dispatch subagent loop,
 * same trust checks — and ship the result back on this socket.
 */
async function handleInboundSpawnRequest(
  sock: WsSocket,
  msg: { requestId: string; task: string; subagentType?: string; model?: string; wantsBash?: boolean },
  requesterPeerId: string,
): Promise<void> {
  // Visibility: surface that this machine is working on behalf of a peer.
  // Transient toast at start/end + the servingCount feeds the StatusLine.
  let requesterHost = requesterPeerId;
  try {
    const peer = listPeers().find((p) => p.peerId === requesterPeerId);
    if (peer?.hostname) requesterHost = peer.hostname;
  } catch (err) { swallow(err); }
  servingCount += 1;
  try {
    const { setTransientStatus } = require('../tui/bridge');
    setTransientStatus?.(`cluster: ← ${msg.subagentType || 'spawn'} from ${requesterHost}`, 5000);
  } catch (err) { swallow(err); }

  const reply = (r: { ok: boolean; result?: string; tokens?: any; error?: string }) => {
    try {
      if ((sock as any).readyState === 1) {
        sock.send(JSON.stringify({ type: 'spawn-result', requestId: msg.requestId, ...r }));
      }
    } catch (err) { swallow(err); }
    // Announce completion + release the counter.
    servingCount = Math.max(0, servingCount - 1);
    try {
      const { setTransientStatus } = require('../tui/bridge');
      setTransientStatus?.(
        `cluster: ${r.ok ? '✓' : '✗'} ${msg.subagentType || 'spawn'} for ${requesterHost}${r.error ? ': ' + r.error.slice(0, 40) : ''}`,
        5000,
      );
    } catch (err) { swallow(err); }
  };

  try {
    const { getPeerTrust } = require('./trust');
    const { isReadOnlySubagentType } = require('./trust');
    const trust = getPeerTrust(requesterPeerId, process.cwd());
    const subagentType = msg.subagentType || 'general-purpose';
    const readOnly = await isReadOnlySubagentType(subagentType);
    if (!readOnly && !trust.allowBash) {
      return reply({ ok: false, error: `peer "${requesterPeerId}" not trusted for write/Bash subagent "${subagentType}" in ${process.cwd()}` });
    }
    if (msg.wantsBash && !trust.allowBash) {
      return reply({ ok: false, error: `peer "${requesterPeerId}" is read-only here; Bash requires /cluster trust ${requesterPeerId} --allow-bash` });
    }

    const { ReplContext } = require('../context');
    const { executeDispatchAgent } = require('../ai/subagent-dispatch');
    const ctx = new ReplContext();
    await ctx.initialize();
    ctx.autoApprove = true;
    // Same reverse trick as server.ts: route this worker's tool-calls back
    // through THIS socket so Read/Glob etc runs on the coordinator's FS.
    (ctx as any).__clusterProxySock = sock;

    const resultJson: string = await executeDispatchAgent(ctx, {
      task: msg.task,
      subagent_type: msg.subagentType,
      model: msg.model,
    });
    let parsed: any;
    try { parsed = JSON.parse(resultJson); } catch { parsed = { summary: resultJson }; }
    reply({
      ok: !parsed.error,
      result: parsed.summary || resultJson,
      tokens: parsed.tokens || { prompt: 0, completion: 0, total: 0 },
      error: parsed.error,
    });
  } catch (err: any) {
    reply({ ok: false, error: err?.message || String(err) });
  }
}

/**
 * Runs a tool-call request from a remote worker against the origin's local
 * ctx + executeTool. This is the OTHER side of the tool proxy — the remote's
 * `Read('src/foo.ts')` lands here on the coordinator that has src/foo.ts.
 *
 * Enforces the proxy policy (canProxyToolCall) so a compromised worker can't
 * exfiltrate random files or run arbitrary Bash. Replies with a
 * tool-call-result on the same socket; never throws — all errors end up in
 * the .error field of the reply.
 */
async function handleInboundToolCall(
  sock: WsSocket,
  msg: { requestId: string; toolName: string; toolInput: unknown },
  remotePeerId: string,
): Promise<void> {
  const reply = (r: { ok: boolean; result?: string; error?: string }) => {
    try {
      if ((sock as any).readyState === 1) {
        sock.send(JSON.stringify({ type: 'tool-call-result', requestId: msg.requestId, ...r }));
      }
    } catch (err) { swallow(err); }
  };

  // Look up the origin ctx for this connection.
  const conn = Array.from(connections.values()).find((c) => c.sock === sock);
  if (!conn || !conn.originCtx) {
    return reply({ ok: false, error: 'origin ctx missing — tool-call arrived on a connection not opened for spawn-worker' });
  }

  // Trust check. Scope to origin cwd so "X is trusted for bash in repo A" works.
  try {
    const { getPeerTrust } = require('./trust');
    const { canProxyToolCall } = require('./tool-proxy-policy');
    const trust = getPeerTrust(remotePeerId, conn.originCtx.cwd || process.cwd());
    const verdict = canProxyToolCall(msg.toolName, trust);
    if (!verdict.allowed) {
      return reply({ ok: false, error: `proxy denied: ${verdict.reason}` });
    }
  } catch (err: any) {
    return reply({ ok: false, error: `proxy policy check failed: ${err?.message || err}` });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { executeTool } = eval('require')('../ai/tools');
    const result: string = await executeTool(msg.toolName, msg.toolInput || {}, conn.originCtx);
    reply({ ok: true, result });
  } catch (err: any) {
    reply({ ok: false, error: err?.message || String(err) });
  }
}

async function connect(peer: PeerInfo): Promise<Connection> {
  const existing = connections.get(peer.peerId);
  if (existing && (existing.sock as any).readyState === 1) return existing;
  if (existing) connections.delete(peer.peerId); // stale — reopen

  const url = `ws://${peer.address}:${peer.wsPort}`;
  const sock = new WebSocket(url);

  const pending = new Map<string, PendingRequest>();
  const ready = new Promise<void>((resolve, reject) => {
    const handshakeTimer = setTimeout(() => {
      try { sock.close(); } catch (err) { swallow(err); }
      reject(new Error(`handshake timeout talking to ${peer.peerId} at ${url}`));
    }, 10_000);
    handshakeTimer.unref?.();

    sock.once('open', () => {
      const id = getIdentity();
      const timestamp = Date.now();
      const version: string = require('../../../package.json').version;
      const sig = buildHelloSig({ peerId: id.peerId, pubkey: id.pubkeyHex, timestamp, version });
      // Include our full signed card so the server can register us with
      // wsPort + caps + hostname — otherwise the server-side record sits at
      // wsPort=0 and any outbound spawn_worker against us fails.
      let clientInfo: any = undefined;
      try {
        const { buildSelfCard } = require('./peer-card');
        clientInfo = buildSelfCard();
      } catch (err) { swallow(err); }
      const hello: ProtocolMessage = {
        type: 'hello',
        peerId: id.peerId,
        pubkey: id.pubkeyHex,
        version,
        timestamp,
        sig,
        clientInfo,
      };
      try { sock.send(JSON.stringify(hello)); } catch (err: any) { reject(err); }
    });

    sock.on('message', (raw: Buffer) => {
      let msg: ProtocolMessage;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }

      if (msg.type === 'hello-ack') {
        clearTimeout(handshakeTimer);
        if (msg.ok) {
          // Verify + register the server's own signed card. This is what
          // turns an IP discovered via LAN-scan into a full peer record —
          // no multicast beacon needed.
          if (msg.serverInfo) {
            try {
              const { verifyPeerCard } = require('./peer-card');
              const verdict = verifyPeerCard(msg.serverInfo);
              if (verdict.ok) {
                const { registerPeerFromCard } = require('./discovery');
                const res = registerPeerFromCard?.(verdict.card, peer.address);
                // Only toast on first registration (or first full card) —
                // otherwise every 30s scan repeats the line and spams the TUI.
                // The StatusLine's `cluster: N peers` summary is the steady-
                // state signal; the toast is the "something changed" signal.
                // First-registration toast is handled by registerPeerFromCard
                // via setTransientStatus — no extra output needed here.
                void res;
              } else {
                try {
                  const { setTransientStatus } = require('../tui/bridge');
                  setTransientStatus?.(`cluster: ✗ ${peer.address} — ${verdict.reason}`, 4000);
                } catch (err) { swallow(err); }
              }
            } catch (err: any) {
              try {
                const { setTransientStatus } = require('../tui/bridge');
                setTransientStatus?.(`cluster: ✗ verify ${peer.address} — ${err?.message || err}`, 4000);
              } catch (err) { swallow(err); }
            }
          } else {
            // Server accepted us but returned no card — older build or bug.
            try {
              const { setTransientStatus } = require('../tui/bridge');
              setTransientStatus?.(`cluster: ? ${peer.address} no serverInfo (stale build?)`, 4000);
            } catch (err) { swallow(err); }
          }
          resolve();
        }
        else {
          try {
            const { setTransientStatus } = require('../tui/bridge');
            setTransientStatus?.(`cluster: ✗ ${peer.address} rejected — ${msg.reason}`, 4000);
          } catch (err) { swallow(err); }
          reject(new Error(`peer ${peer.peerId} rejected handshake: ${msg.reason}`));
        }
        return;
      }

      // Correlate to a pending request by requestId when present.
      const requestId = (msg as any).requestId as string | undefined;
      if (requestId && pending.has(requestId)) {
        const p = pending.get(requestId)!;
        clearTimeout(p.timer);
        pending.delete(requestId);
        p.resolve(msg);
        return;
      }

      // Unsolicited (load-hint) — update the peer registry.
      if (msg.type === 'load-hint') {
        try {
          const { recordPeerLoad } = require('./discovery');
          recordPeerLoad?.(peer.peerId, {
            runningWorkers: msg.runningWorkers,
            maxWorkers: msg.maxWorkers,
            cpuCount: msg.cpuCount,
          });
        } catch (err) { swallow(err); }
      }

      // Tool-call proxy: the remote worker is asking us (the origin) to run
      // a tool on our real filesystem. Gate by proxy policy + trust, run
      // executeTool locally with the coordinator's ctx, ship back the result.
      if (msg.type === 'tool-call') {
        void handleInboundToolCall(sock, msg as any, peer.peerId);
      }

      // Reverse dispatch: the other side (which we called "server" when we
      // opened the socket) is asking US to run a spawn-worker. This path is
      // critical on macOS Sequoia where Local Network Privacy blocks the
      // coordinator from connecting TO us, so the coordinator sends the
      // spawn-worker down the SAME socket we opened to it.
      if (msg.type === 'spawn-worker') {
        void handleInboundSpawnRequest(sock, msg as any, peer.peerId);
      }
    });

    sock.on('error', (err: any) => {
      clearTimeout(handshakeTimer);
      reject(err);
    });

    sock.on('close', () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`connection to ${peer.peerId} closed`));
      }
      pending.clear();
      connections.delete(peer.peerId);
    });
  });

  const conn: Connection = { sock, pending, serverPeerId: peer.peerId, ready };
  connections.set(peer.peerId, conn);
  await ready;
  return conn;
}

async function request<T extends ProtocolMessage>(peer: PeerInfo, msg: ProtocolMessage): Promise<T> {
  const conn = await connect(peer);
  const requestId = (msg as any).requestId as string;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(requestId);
      reject(new Error(`request ${requestId} to ${peer.peerId} timed out`));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    conn.pending.set(requestId, { resolve: resolve as any, reject, timer });
    try { conn.sock.send(JSON.stringify(msg)); }
    catch (err: any) {
      clearTimeout(timer);
      conn.pending.delete(requestId);
      reject(err);
    }
  });
}

export async function spawnWorkerOnPeer(peerId: string, opts: {
  task: string;
  subagentType?: string;
  model?: string;
  wantsBash?: boolean;
  /** Coordinator's ReplContext. Stashed on the connection so inbound
   *  tool-call messages from the worker can run against the origin's
   *  filesystem + project state (executeTool needs a ctx). */
  originCtx?: any;
}): Promise<{ ok: boolean; result?: string; tokens?: { prompt: number; completion: number; total: number }; error?: string }> {
  const peer = resolvePeer(peerId);
  if (!peer) throw new Error(`peer "${peerId}" not found in registry — is discovery running and the peer advertising?`);

  const requestId = newRequestId();
  const spawnMsg: any = {
    type: 'spawn-worker',
    requestId,
    task: opts.task,
    subagentType: opts.subagentType,
    model: opts.model,
    wantsBash: opts.wantsBash,
  };

  // REVERSE-DISPATCH FAST PATH. macOS 15+ Local Network Privacy blocks
  // outbound connect() from Node to LAN IPs even though ping/nc succeed. On
  // Macs that means we CAN'T open a fresh WS to a LAN peer — but the peer
  // probably already opened one to us via LAN scan, and the server cached
  // it. Push spawn-worker through that existing inbound socket instead.
  try {
    const { hasInboundSock, sendRequestViaInbound } = require('./server');
    if (hasInboundSock?.(peerId)) {
      // Stash originCtx on the inbound sock's entry so tool-call messages
      // from the remote worker can route back to the right ctx.
      try {
        const srv = require('./server');
        const entry = srv.__getInboundEntry?.(peerId);
        if (entry) entry.originCtx = opts.originCtx;
      } catch (err) { swallow(err); }
      const res = await sendRequestViaInbound(peerId, spawnMsg);
      return {
        ok: res.ok,
        result: res.result,
        tokens: res.tokens,
        error: res.error,
      };
    }
  } catch (err) { swallow(err); }

  // Ensure connection exists and attach origin ctx before sending spawn-worker
  // so any tool-call the worker fires can find the ctx on this connection.
  const conn = await connect(peer);
  conn.originCtx = opts.originCtx;
  conn.remotePeerId = peerId;

  const res = await request<SpawnResultMessage>(peer, spawnMsg);
  return {
    ok: res.ok,
    result: res.result,
    tokens: res.tokens,
    error: res.error,
  };
}

export async function scratchReadOnPeer(peerId: string, sessionId: string, key: string): Promise<string> {
  const peer = resolvePeer(peerId);
  if (!peer) throw new Error(`peer "${peerId}" not found`);
  const res = await request<ScratchReadResultMessage>(peer, {
    type: 'scratch-read',
    requestId: newRequestId(),
    sessionId,
    key,
  });
  if (!res.ok) throw new Error(res.error || 'remote scratch-read failed');
  return res.content || '';
}

export async function scratchWriteOnPeer(peerId: string, sessionId: string, key: string, content: string): Promise<number> {
  const peer = resolvePeer(peerId);
  if (!peer) throw new Error(`peer "${peerId}" not found`);
  const res = await request<ScratchWriteResultMessage>(peer, {
    type: 'scratch-write',
    requestId: newRequestId(),
    sessionId,
    key,
    content,
  });
  if (!res.ok) throw new Error(res.error || 'remote scratch-write failed');
  return res.bytes || 0;
}

/**
 * Pull the remote peer's memory. Two-phase:
 *   1. Fetch their digest (name + vclock of every topic, live or tombstoned).
 *   2. Filter to entries where our local vclock doesn't already dominate,
 *      request full payloads for those names, merge via applyIncomingTopic.
 *
 * Returns a summary of what happened per topic, for the /memory sync UI.
 */
export async function pullMemoryFromPeer(peerId: string): Promise<{
  pulled: number;
  applied: Array<{ name: string; outcome: string; conflictPath?: string }>;
  skipped: number;
}> {
  const peer = resolvePeer(peerId);
  if (!peer) throw new Error(`peer "${peerId}" not found`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const memory = require('../memory');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { compare, parseVClockString } = require('./crdt');

  const digest = await request<MemoryDigestResultMessage>(peer, {
    type: 'memory-digest',
    requestId: newRequestId(),
  });
  if (!digest.ok) throw new Error(digest.error || 'remote memory-digest failed');

  const local = memory.loadAllTopicsIncludingTombstones() as any[];
  const localByName = new Map<string, any>(local.map((t) => [t.name, t]));

  // Only pull topics where our vclock does NOT already dominate the
  // remote's. "equal" and "after" (we dominate) are skipped — nothing new.
  const wantedNames: string[] = [];
  let skipped = 0;
  for (const entry of digest.entries || []) {
    const remoteClock = parseVClockString(entry.vclock);
    const localTopic = localByName.get(entry.name);
    if (!localTopic) {
      wantedNames.push(entry.name);
      continue;
    }
    const rel = compare(localTopic.vclock, remoteClock);
    if (rel === 'after' || rel === 'equal') {
      skipped++;
      continue;
    }
    // 'before' or 'concurrent' → pull the full payload.
    wantedNames.push(entry.name);
  }

  if (wantedNames.length === 0) {
    return { pulled: 0, applied: [], skipped };
  }

  const payload = await request<MemoryPullResultMessage>(peer, {
    type: 'memory-pull',
    requestId: newRequestId(),
    names: wantedNames,
  });
  if (!payload.ok) throw new Error(payload.error || 'remote memory-pull failed');

  const applied: Array<{ name: string; outcome: string; conflictPath?: string }> = [];
  for (const p of payload.topics || []) {
    const remoteTopic = {
      name: p.name,
      tags: p.tags || [],
      body: p.body || '',
      vclock: parseVClockString(p.vclock),
      origin: p.origin,
      updatedAt: p.updatedAt,
      deletedAt: p.deletedAt,
      // synthetic — not used by applyIncomingTopic, required by interface
      lastAccessedAt: new Date(p.updatedAt || Date.now()).toISOString(),
      accessCount: 0,
      path: '',
    };
    const res = memory.applyIncomingTopic(remoteTopic);
    applied.push({ name: p.name, outcome: res.outcome, conflictPath: res.conflictPath });
  }
  return { pulled: payload.topics?.length || 0, applied, skipped };
}

export function closeAllConnections(): void {
  for (const conn of connections.values()) {
    try { conn.sock.close(); } catch (err) { swallow(err); }
  }
  connections.clear();
}

// sendToolCallToOrigin lives in proxy-tool-call.ts to avoid the
// client ↔ subagent-dispatch import cycle. Re-exported here so existing
// callers (and the public surface of cluster/client) stay stable.
export { sendToolCallToOrigin } from './proxy-tool-call';

// ── LAN-scan discovery helpers ───────────────────────────────────────────
//
// When the LAN scanner finds an IP with the cluster port open, it doesn't
// yet know which peerId lives there. `probePeerByAddress` drives the full
// handshake so discovery.ts can stash a validated peer record, and then
// optionally pulls the gossip list so we converge on the rest of the cluster.

/**
 * Open a short-lived WS connection, perform the hello handshake, verify the
 * server's signed PeerInfoCard, and return its peerId. The registration into
 * discovery.state.peers happens inside the hello-ack handler (via
 * registerPeerFromCard) so callers only need to know whether it worked.
 *
 * Never throws — returns `null` on any failure so the caller (a parallel
 * scanner) can move on without try/catch boilerplate around every probe.
 */
export async function probePeerByAddress(ip: string, port: number): Promise<string | null> {
  // Fake a peer record so `connect` can find us an address+port. Once the
  // handshake completes, the real peerId + pubkey arrive via serverInfo and
  // the connect cache gets rekeyed below.
  const tempPeer: PeerInfo = {
    peerId: `probe:${ip}:${port}`,
    pubkey: '',
    hostname: ip,
    wsPort: port,
    caps: [],
    version: 'unknown',
    address: ip,
    state: 'alive',
    lastSeen: Date.now(),
  };
  try {
    const conn = await connect(tempPeer);
    // connect() stored us under the temp key; we don't have a reliable
    // serverPeerId inside Connection either (it's set to the peer arg,
    // not the real server id). We close the transient connection — the
    // real peer will get opened on demand via its real peerId later.
    try { conn.sock.close(); } catch (err) { swallow(err); }
    connections.delete(tempPeer.peerId);
    return ip; // success is the peerId being registered side-effectfully
  } catch {
    return null;
  }
}

/**
 * Ask a known peer for its list of other peers' addresses. Used to converge
 * after LAN scan finds a peer — e.g. scan finds A; A knows B, C, D (remote,
 * possibly on a different subnet we wouldn't sweep); A's gossip reply gives
 * us their IPs so we can probe each one directly and collect fresh cards.
 */
export async function gossipFromPeer(peerId: string): Promise<PeerGossipAddress[]> {
  const peer = resolvePeer(peerId);
  if (!peer) return [];
  try {
    const res = await request<PeerGossipResultMessage>(peer, {
      type: 'peer-gossip',
      requestId: newRequestId(),
    });
    return res.ok ? (res.peers || []) : [];
  } catch {
    return [];
  }
}

// Register the probe + gossip helpers with the neutral registry so
// discovery's LAN scanner can call them without importing client back —
// see cluster/probe-registry.ts. Module-load side effect: as long as
// client.ts is loaded before startDiscovery (auto-sync's static import
// brings it in via /cluster enable), the callbacks are ready.
setProbeCallback(probePeerByAddress, gossipFromPeer);
