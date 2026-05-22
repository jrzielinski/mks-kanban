import { swallow } from '../../utils/log';
/**
 * cluster/server.ts — WebSocket server that accepts inbound peer connections
 * and services their requests (spawn-worker, scratch-read, scratch-write).
 *
 * Authentication: client sends `hello` with an HMAC of (peerId, timestamp)
 * signed with the shared secret. Server verifies before processing anything
 * else. Unauthenticated sockets are closed immediately.
 *
 * Trust: by default only read-only subagent types are allowed. Fase 4's
 * trust config (~/.makestudio/cluster-trust.json) can widen this per peer.
 */

// ws v7 exports the WebSocket class as module.exports and the server as
// `.Server`; ws v8 adds named exports WebSocket + WebSocketServer. The
// @types/ws installed here is v8-flavoured, which creates type friction
// when the runtime is v7. Using `any` for the socket types is a
// deliberate pragmatic choice — we gain nothing from strict typing here
// and a dep bump is out of scope for this session.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wsModule: any = require('ws');
const WebSocketServer: any = wsModule.WebSocketServer || wsModule.Server;
type WsSocket = any;
type WsServer = any;
import * as os from 'os';
import { loadClusterConfig } from './config';
import { getIdentity } from './identity';
import { verifyHello } from './auth';
import { ProtocolMessage } from './protocol';
import { isReadOnlySubagentType } from './trust';
import { setServerLoadProvider } from './server-load';

let server: WsServer | null = null;
let serverListening = false;

/**
 * Authenticated inbound sockets, keyed by the REMOTE peer's id. Populated
 * when a hello is accepted; drained on close. Used for reverse dispatch:
 * when our own coordinator wants to spawn-worker on a peer but the local
 * macOS Local Network Privacy guard blocks outbound connect(), we send
 * spawn-worker back THROUGH the inbound socket the peer opened to us.
 *
 * The peer's client.ts needs to handle spawn-worker on its client-side sock
 * (see `attachInboundRequestHandlers` in client.ts).
 */
const inboundByPeerId = new Map<string, {
  sock: WsSocket;
  pending: Map<string, { resolve: (m: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
  /** Set by the coordinator (client.spawnWorkerOnPeer) when we're about to
   *  send a spawn-worker via this inbound sock. Subsequent tool-call messages
   *  that arrive on this sock (from the remote worker's executeTool proxy)
   *  run against this ctx, so the worker's Read/Glob hit the coordinator's
   *  real filesystem. */
  originCtx?: any;
}>();

/** Internal — exposed for client.ts to stash originCtx on the inbound entry
 *  before sending a spawn-worker. Not intended for external callers. */
export function __getInboundEntry(peerId: string): { originCtx?: any } | undefined {
  return inboundByPeerId.get(peerId);
}

/** Is there a reverse-dispatch path available to this peer? */
export function hasInboundSock(peerId: string): boolean {
  const e = inboundByPeerId.get(peerId);
  return !!e && (e.sock as any).readyState === 1;
}

/** Send a spawn-worker (or any request expecting a correlated reply) over
 *  the inbound sock from `peerId`. The peer's client handles it and replies
 *  on the same socket. */
export function sendRequestViaInbound<T = any>(peerId: string, msg: any, timeoutMs = 15 * 60 * 1000): Promise<T> {
  const entry = inboundByPeerId.get(peerId);
  if (!entry) return Promise.reject(new Error(`no inbound sock for peer ${peerId}`));
  const requestId: string = msg.requestId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(requestId);
      reject(new Error(`inbound request ${requestId} to ${peerId} timed out`));
    }, timeoutMs);
    timer.unref?.();
    entry.pending.set(requestId, { resolve, reject, timer });
    try { entry.sock.send(JSON.stringify(msg)); }
    catch (err: any) {
      clearTimeout(timer);
      entry.pending.delete(requestId);
      reject(err);
    }
  });
}
// Track running remote worker requests so we can surface a load hint and
// gracefully refuse new ones if the server is overloaded.
const activeRequests = new Map<string, { peerId: string; startedAt: number; abortCtl?: AbortController }>();

// Cap concurrent remote workers on the server side. Prevents a malicious (or
// compromised-secret) peer from flooding spawn-worker and exhausting memory/CPU.
// Matches the advertised `maxWorkers: 4` in the load hint.
const MAX_CONCURRENT = 4;

// Per-request spawn timeout — after this the server aborts executeDispatchAgent
// and releases the activeRequests slot. Client has its own 15min timeout; we
// match it so neither side holds resources past the same deadline.
const SPAWN_TIMEOUT_MS = 15 * 60 * 1000;

function safeSend(sock: WsSocket, msg: ProtocolMessage): void {
  try {
    // WebSocket.OPEN is a runtime constant on the ws module; the runtime
    // const resolves to either the v7 default export (class itself has
    // OPEN as a static) or the v8 class. Both expose `OPEN = 1`.
    if ((sock as any).readyState === 1) sock.send(JSON.stringify(msg));
  } catch (err) { swallow(err); }
}

async function handleSpawn(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'spawn-worker' }>,
  peerId: string,
): Promise<void> {
  // Enforce trust: by default, reject anything that needs Bash/Edit/Write.
  // Scope trust to the server's launch cwd — "when I'm working in repo Y,
  // peer X is trusted to run bash" is the intended semantic. A peer might
  // be trusted to touch my personal project but not a client repo.
  const subagentType = msg.subagentType || 'general-purpose';
  const wantsBash = Boolean(msg.wantsBash);
  const readOnly = await isReadOnlySubagentType(subagentType);

  const { getPeerTrust } = require('./trust');
  const trust = getPeerTrust(peerId, process.cwd());

  if (!readOnly && !trust.allowBash) {
    safeSend(sock, {
      type: 'spawn-result',
      requestId: msg.requestId,
      ok: false,
      error: `peer "${peerId}" not trusted for write/Bash-capable subagent type "${subagentType}" in ${process.cwd()}. Grant with: /cluster trust ${peerId} --scope ${process.cwd()} --allow-bash`,
    });
    return;
  }
  if (wantsBash && !trust.allowBash) {
    safeSend(sock, {
      type: 'spawn-result',
      requestId: msg.requestId,
      ok: false,
      error: `peer "${peerId}" is read-only here; Bash requires /cluster trust ${peerId} --scope ${process.cwd()} --allow-bash`,
    });
    return;
  }

  // Back-pressure: reject if we're already running MAX_CONCURRENT spawns.
  // The client's load-hint listener sees the count so a well-behaved cluster
  // picks a lighter peer on its own; this guard is the server-side enforcer
  // for misbehaving clients or compromised secrets.
  if (activeRequests.size >= MAX_CONCURRENT) {
    safeSend(sock, {
      type: 'spawn-result',
      requestId: msg.requestId,
      ok: false,
      error: `peer capacity exceeded (${activeRequests.size}/${MAX_CONCURRENT} workers busy). Retry after the current batch finishes.`,
    });
    return;
  }

  const abortCtl = new AbortController();
  activeRequests.set(msg.requestId, { peerId, startedAt: Date.now(), abortCtl });
  const timer = setTimeout(() => {
    abortCtl.abort(new Error(`spawn timed out after ${SPAWN_TIMEOUT_MS / 1000}s`));
  }, SPAWN_TIMEOUT_MS);
  timer.unref?.();

  try {
    // Run through our in-process dispatch_agent with a neutral ctx. The
    // remote peer's ctx carries its own project info, not the client's —
    // intentional. If the client wants project-grounded Read, they should
    // request it via scratch proxy.
    const { ReplContext } = require('../context');
    const { executeDispatchAgent } = require('../ai/subagent-dispatch');
    const ctx = new ReplContext();
    await ctx.initialize();
    ctx.autoApprove = true; // remote workers can't prompt
    // Expose the abort signal so the subagent loop can bail on timeout.
    (ctx as any).currentAbortController = abortCtl;
    // Stash the inbound socket so executeTool inside the dispatch loop can
    // proxy filesystem / LSP / git tool-calls back to the origin (the peer
    // that opened THIS connection for spawn-worker). Without this, a remote
    // `explore` worker would Read paths that don't exist on our FS.
    (ctx as any).__clusterProxySock = sock;

    // Race executeDispatchAgent against the timeout so a stuck provider can't
    // pin the activeRequests slot past SPAWN_TIMEOUT_MS.
    const resultJson: string = await new Promise((resolve, reject) => {
      executeDispatchAgent(ctx, {
        task: msg.task,
        subagent_type: msg.subagentType,
        model: msg.model,
      }).then(resolve, reject);
      abortCtl.signal.addEventListener('abort', () => {
        reject(abortCtl.signal.reason instanceof Error ? abortCtl.signal.reason : new Error(String(abortCtl.signal.reason || 'aborted')));
      }, { once: true });
    });
    let parsed: any;
    try { parsed = JSON.parse(resultJson); } catch { parsed = { summary: resultJson }; }

    safeSend(sock, {
      type: 'spawn-result',
      requestId: msg.requestId,
      ok: !parsed.error,
      result: parsed.summary || resultJson,
      tokens: parsed.tokens || { prompt: 0, completion: 0, total: 0 },
      error: parsed.error,
    });
  } catch (err: any) {
    safeSend(sock, {
      type: 'spawn-result',
      requestId: msg.requestId,
      ok: false,
      error: err?.message || String(err),
    });
  } finally {
    clearTimeout(timer);
    activeRequests.delete(msg.requestId);
  }
}

async function handleScratchRead(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'scratch-read' }>,
): Promise<void> {
  try {
    const { readScratchpad } = require('./scratch-proxy');
    const content = await readScratchpad(msg.sessionId, msg.key);
    safeSend(sock, { type: 'scratch-read-result', requestId: msg.requestId, ok: true, content });
  } catch (err: any) {
    safeSend(sock, { type: 'scratch-read-result', requestId: msg.requestId, ok: false, error: err?.message || String(err) });
  }
}

async function handleScratchWrite(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'scratch-write' }>,
): Promise<void> {
  try {
    const { writeScratchpad } = require('./scratch-proxy');
    const bytes = await writeScratchpad(msg.sessionId, msg.key, msg.content);
    safeSend(sock, { type: 'scratch-write-result', requestId: msg.requestId, ok: true, bytes });
  } catch (err: any) {
    safeSend(sock, { type: 'scratch-write-result', requestId: msg.requestId, ok: false, error: err?.message || String(err) });
  }
}

/** Respond with a name + vclock summary of every memory topic (live and
 *  tombstoned). No auth gate beyond the handshake — memory content is
 *  treated as shared-by-default among trusted peers, same as scratchpad. */
async function handleMemoryDigest(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'memory-digest' }>,
): Promise<void> {
  try {
    const { loadAllTopicsIncludingTombstones } = require('../memory');
    const { formatVClock } = require('./crdt');
    const topics: any[] = loadAllTopicsIncludingTombstones();
    const entries = topics.map((t) => ({
      name: t.name,
      vclock: formatVClock(t.vclock),
      deletedAt: t.deletedAt,
    }));
    safeSend(sock, { type: 'memory-digest-result', requestId: msg.requestId, ok: true, entries });
  } catch (err: any) {
    safeSend(sock, { type: 'memory-digest-result', requestId: msg.requestId, ok: false, error: err?.message || String(err) });
  }
}

/** Return full topic payloads for the requested names. Silently skips any
 *  name not present locally — the requester just gets fewer entries, which
 *  they can handle as "the remote dropped this topic since the digest." */
async function handleMemoryPull(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'memory-pull' }>,
): Promise<void> {
  try {
    const { loadAllTopicsIncludingTombstones } = require('../memory');
    const { formatVClock } = require('./crdt');
    const all: any[] = loadAllTopicsIncludingTombstones();
    const wanted = new Set(msg.names);
    const topics = all
      .filter((t) => wanted.has(t.name))
      .map((t) => ({
        name: t.name,
        tags: t.tags,
        body: t.body,
        vclock: formatVClock(t.vclock),
        origin: t.origin,
        updatedAt: t.updatedAt,
        deletedAt: t.deletedAt,
      }));
    safeSend(sock, { type: 'memory-pull-result', requestId: msg.requestId, ok: true, topics });
  } catch (err: any) {
    safeSend(sock, { type: 'memory-pull-result', requestId: msg.requestId, ok: false, error: err?.message || String(err) });
  }
}

function sendLoadHint(sock: WebSocket): void {
  safeSend(sock, {
    type: 'load-hint',
    runningWorkers: activeRequests.size,
    maxWorkers: 4,
    cpuCount: os.cpus().length,
  });
}

/**
 * Return cards for every peer the server currently knows about. The requester
 * uses this to bootstrap — e.g. "I just unicast-scanned the LAN and found you;
 * now tell me who else is in the cluster so I can dial them too." Self is
 * excluded (requester already has us via hello-ack).
 */
async function handlePeerGossip(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'peer-gossip' }>,
): Promise<void> {
  try {
    const { getPeerAddresses } = require('./discovery');
    const peers = getPeerAddresses?.() ?? [];
    safeSend(sock, { type: 'peer-gossip-result', requestId: msg.requestId, ok: true, peers });
  } catch (err: any) {
    safeSend(sock, { type: 'peer-gossip-result', requestId: msg.requestId, ok: false, error: err?.message || String(err) });
  }
}

/** Server-side tool-call handler. Fires when a remote worker (running a
 *  reverse-dispatched spawn-worker sent via the inbound sock) proxies
 *  Read/Grep/etc back to us. Uses the originCtx we stashed on the inbound
 *  entry right before pushing spawn-worker, so executeTool runs in the
 *  coordinator's project/cwd. */
async function handleInboundToolCallOnServer(
  sock: WsSocket,
  msg: Extract<ProtocolMessage, { type: 'tool-call' }>,
  peerId: string,
): Promise<void> {
  const reply = (r: { ok: boolean; result?: string; error?: string }) => {
    try {
      if ((sock as any).readyState === 1) {
        sock.send(JSON.stringify({ type: 'tool-call-result', requestId: msg.requestId, ...r }));
      }
    } catch (err) { swallow(err); }
  };
  const entry = inboundByPeerId.get(peerId);
  if (!entry?.originCtx) {
    return reply({ ok: false, error: 'no origin ctx stashed for this peer — spawn-worker must set it first' });
  }
  try {
    const { getPeerTrust } = require('./trust');
    const { canProxyToolCall } = require('./tool-proxy-policy');
    const trust = getPeerTrust(peerId, entry.originCtx.cwd || process.cwd());
    const verdict = canProxyToolCall(msg.toolName, trust);
    if (!verdict.allowed) return reply({ ok: false, error: `proxy denied: ${verdict.reason}` });
  } catch (err: any) {
    return reply({ ok: false, error: `proxy policy check failed: ${err?.message || err}` });
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { executeTool } = eval('require')('../ai/tools');
    const result: string = await executeTool(msg.toolName, msg.toolInput || {}, entry.originCtx);
    reply({ ok: true, result });
  } catch (err: any) {
    reply({ ok: false, error: err?.message || String(err) });
  }
}

function onConnection(sock: WsSocket): void {
  const selfId = getIdentity().peerId;
  let authenticatedPeerId: string | null = null;
  const loadTicker = setInterval(() => sendLoadHint(sock), 10_000);
  loadTicker.unref?.();

  sock.on('message', async (raw: Buffer) => {
    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      sock.close(1003, 'invalid json');
      return;
    }

    if (!authenticatedPeerId) {
      if (msg.type !== 'hello') {
        sock.close(1008, 'expected hello first');
        return;
      }
      const verdict = verifyHello(
        { peerId: msg.peerId, pubkey: msg.pubkey, timestamp: msg.timestamp, version: msg.version },
        msg.sig,
      );
      if (!verdict.ok) {
        safeSend(sock, { type: 'hello-ack', ok: false, reason: verdict.reason });
        sock.close(1008, 'auth failed');
        return;
      }
      authenticatedPeerId = msg.peerId;
      // Ship our own signed metadata in the hello-ack so the client can
      // register us as a peer without waiting on a separate beacon —
      // critical for the LAN-scan unicast discovery path.
      const { buildSelfCard } = require('./peer-card');
      safeSend(sock, {
        type: 'hello-ack',
        ok: true,
        serverPeerId: selfId,
        serverInfo: buildSelfCard(),
      });
      // Register the just-authenticated client as a peer. Prefer the full
      // signed card (msg.clientInfo) when present — gives us wsPort + caps +
      // hostname so outbound spawn_worker can dial back. Fall back to the
      // partial record (peerId + pubkey only) for older clients that don't
      // ship clientInfo yet.
      try {
        const remoteAddress = (sock as any)._socket?.remoteAddress;
        if (msg.clientInfo) {
          const { verifyPeerCard } = require('./peer-card');
          const { registerPeerFromCard } = require('./discovery');
          const verdict = verifyPeerCard(msg.clientInfo);
          if (verdict.ok) {
            registerPeerFromCard?.(verdict.card, remoteAddress);
          } else {
            // card failed verification — fall back to the partial record so
            // we at least know the peer is there (their signed hello already
            // proved identity).
            const { registerPeerFromHello } = require('./discovery');
            registerPeerFromHello?.(msg.peerId, msg.pubkey, remoteAddress);
          }
        } else {
          const { registerPeerFromHello } = require('./discovery');
          registerPeerFromHello?.(msg.peerId, msg.pubkey, remoteAddress);
        }
      } catch (err) { swallow(err); }
      // Cache this inbound sock for reverse-dispatch. Any request we (as
      // coordinator) need to send to this peer CAN go out through here
      // later, bypassing macOS's Local Network Privacy which blocks outbound
      // connect() from Node to LAN IPs. Drained on close below.
      inboundByPeerId.set(msg.peerId, { sock, pending: new Map() });
      sendLoadHint(sock);
      return;
    }

    // Result routing for reverse-dispatch: when we pushed a request to
    // this peer via sendRequestViaInbound, the reply comes back here.
    const requestId = (msg as any).requestId as string | undefined;
    if (requestId) {
      const entry = inboundByPeerId.get(authenticatedPeerId);
      const pending = entry?.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        entry!.pending.delete(requestId);
        pending.resolve(msg);
        return;
      }
    }

    switch (msg.type) {
      case 'spawn-worker': return handleSpawn(sock, msg, authenticatedPeerId);
      case 'scratch-read': return handleScratchRead(sock, msg);
      case 'scratch-write': return handleScratchWrite(sock, msg);
      case 'memory-digest': return handleMemoryDigest(sock, msg);
      case 'memory-pull': return handleMemoryPull(sock, msg);
      case 'peer-gossip': return handlePeerGossip(sock, msg);
      case 'tool-call': return handleInboundToolCallOnServer(sock, msg, authenticatedPeerId);
      default: /* ignore unknown types — forward-compat */
    }
  });

  sock.on('close', () => {
    clearInterval(loadTicker);
    if (authenticatedPeerId) {
      const entry = inboundByPeerId.get(authenticatedPeerId);
      if (entry && entry.sock === sock) {
        for (const p of entry.pending.values()) {
          clearTimeout(p.timer);
          try { p.reject(new Error(`inbound sock from ${authenticatedPeerId} closed`)); } catch (err) { swallow(err); }
        }
        inboundByPeerId.delete(authenticatedPeerId);
      }
    }
  });
  sock.on('error', () => { /* close event will fire next */ });
}

export async function startClusterServer(): Promise<void> {
  if (server && serverListening) return;
  const cfg = loadClusterConfig();
  if (!cfg.enabled) return;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
    const safeReject = (err: any) => {
      if (settled) return;
      settled = true;
      // Drop the stale WS instance — bind failed, we can't reuse it.
      try { server?.close(); } catch (err) { swallow(err); }
      server = null;
      serverListening = false;
      reject(err);
    };
    try {
      // Bind to 0.0.0.0 so other hosts on the LAN can reach us.
      server = new WebSocketServer({ port: cfg.listenPort, host: '0.0.0.0' });
      server.on('connection', onConnection);
      server.on('error', (err: any) => {
        try {
          const { getTuiBridge } = require('../tui/bridge');
          getTuiBridge?.()?.addMessage?.({
            role: 'error',
            text: `[cluster-server] ${err.message}`,
          });
        } catch (err) { swallow(err); }
        safeReject(err);
      });
      server.on('listening', () => {
        serverListening = true;
        setServerLoadProvider(() => ({ running: activeRequests.size, cpuCount: os.cpus().length }));
        safeResolve();
      });
    } catch (err) { safeReject(err); }
  });
}

export function stopClusterServer(): void {
  if (!server) return;
  try { server.close(); } catch (err) { swallow(err); }
  server = null;
  serverListening = false;
  activeRequests.clear();
  setServerLoadProvider(null);
}

export function isClusterServerRunning(): boolean {
  return server !== null && serverListening;
}
