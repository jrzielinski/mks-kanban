/**
 * cluster/protocol.ts — JSON-line message types exchanged between peers
 * over the authenticated WebSocket channel.
 *
 * Every frame is a single JSON object with a `type` discriminator. We keep
 * this small and explicit — drift between peer versions would corrupt the
 * session pool / scratchpad if shapes changed silently.
 */

/** Upgraded once, by the client immediately after the WS opens.
 *
 *  Authentication is self-certifying: `pubkey` is the peer's Ed25519 public
 *  key (hex, 64 chars), `peerId` must equal the fingerprint of that pubkey,
 *  and `sig` is an Ed25519 signature over the canonical JSON of
 *  `{peerId, pubkey, timestamp, version}`. Server verifies all three before
 *  accepting the hello. Replay window: 60s on `timestamp`. */
export interface HelloMessage {
  type: 'hello';
  peerId: string;
  pubkey: string;
  version: string;
  timestamp: number;
  sig: string;
  /** Optional full self-card. When present the server can register the client
   *  as a peer with complete metadata (wsPort, caps, hostname, loadHint) —
   *  critical for outbound spawn_worker calls that need to know how to dial
   *  back. When absent (older clients) the server falls back to a partial
   *  record with peerId + pubkey only. */
  clientInfo?: PeerInfoCard;
}

/** Signed metadata a peer publishes about itself. Same fields the multicast
 *  beacon used to carry, just delivered via the WS handshake so unicast
 *  discovery (LAN scan) gives us everything we need to register without a
 *  separate beacon. `sig` covers the canonical JSON of the non-sig fields. */
export interface PeerInfoCard {
  peerId: string;
  pubkey: string;
  hostname: string;
  wsPort: number;
  caps: string[];
  version: string;
  loadHint?: { runningWorkers: number; maxWorkers: number; cpuCount: number };
  timestamp: number;
  sig: string;
}

/** Server's response: accept or reject. When `ok`, `serverInfo` carries the
 *  server's own PeerInfoCard so the client can register the server as a peer
 *  in the same round-trip (no multicast beacon needed). */
export interface HelloAckMessage {
  type: 'hello-ack';
  ok: boolean;
  reason?: string;
  serverPeerId?: string;
  serverInfo?: PeerInfoCard;
}

/** Pull the server's known-peer ADDRESSES. Used after a successful handshake
 *  so a newly-joined peer converges on everybody the existing peers already
 *  know (transitive discovery — "A knows B and C, D talks to A, D now knows
 *  B+C's addresses and dials them directly, which re-handshakes and fetches
 *  fresh cards from the source"). We ship addresses not cards because
 *  re-signing cards we received from others isn't possible without their
 *  private keys — forwarding the originals works but adds non-trivial
 *  verification complexity. Direct re-probe keeps the trust chain simple:
 *  every card we register is signed by the peer we're talking to. */
export interface PeerGossipMessage {
  type: 'peer-gossip';
  requestId: string;
}

export interface PeerGossipAddress {
  address: string;  // IPv4 string
  wsPort: number;
  peerId: string;   // hint only — the real peerId is confirmed by the fresh hello-ack
}

export interface PeerGossipResultMessage {
  type: 'peer-gossip-result';
  requestId: string;
  ok: boolean;
  peers?: PeerGossipAddress[];
  error?: string;
}

/** Request a remote subagent spawn. Mirrors dispatch_agent inputs but is
 *  executed on the server peer — results stream back as `spawn-result`. */
export interface SpawnWorkerMessage {
  type: 'spawn-worker';
  requestId: string;
  task: string;
  subagentType?: string;
  tools?: string[];
  maxIters?: number;
  model?: string;
  system?: string;
  /** Signals which tool families the client expects the server to honour.
   *  Server-side trust config enforces the actual allow/deny. */
  wantsBash?: boolean;
}

/** Completed result of a spawn-worker. */
export interface SpawnResultMessage {
  type: 'spawn-result';
  requestId: string;
  ok: boolean;
  result?: string;
  tokens?: { prompt: number; completion: number; total: number };
  error?: string;
}

/** Fase 3 — proxy a scratchpad read back to the origin peer. */
export interface ScratchReadMessage {
  type: 'scratch-read';
  requestId: string;
  sessionId: string;
  key: string;
}

export interface ScratchReadResultMessage {
  type: 'scratch-read-result';
  requestId: string;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface ScratchWriteMessage {
  type: 'scratch-write';
  requestId: string;
  sessionId: string;
  key: string;
  content: string;
}

export interface ScratchWriteResultMessage {
  type: 'scratch-write-result';
  requestId: string;
  ok: boolean;
  bytes?: number;
  error?: string;
}

/** Fase 5 — voluntary load update so coordinators can balance. */
export interface LoadHintMessage {
  type: 'load-hint';
  runningWorkers: number;
  maxWorkers: number;
  cpuCount: number;
}

// ── Memory CRDT sync ────────────────────────────────────────────────────
//
// Pull-based: requester asks server for its memory digest (topic name +
// vclock for each live topic AND each tombstone), then requests the full
// body for any topic where the server's vclock isn't dominated by ours.
// Conflict resolution lives in memory.applyIncomingTopic (crdt.merge).

export interface MemoryDigestMessage {
  type: 'memory-digest';
  requestId: string;
}

export interface MemoryDigestEntry {
  name: string;
  vclock: string;      // compact "peerId:n,peerId:n" format
  deletedAt?: number;
}

export interface MemoryDigestResultMessage {
  type: 'memory-digest-result';
  requestId: string;
  ok: boolean;
  entries?: MemoryDigestEntry[];
  error?: string;
}

export interface MemoryPullMessage {
  type: 'memory-pull';
  requestId: string;
  names: string[];     // topics the requester wants full bodies for
}

export interface MemoryTopicPayload {
  name: string;
  tags: string[];
  body: string;
  vclock: string;
  origin: string;
  updatedAt: number;
  deletedAt?: number;
}

export interface MemoryPullResultMessage {
  type: 'memory-pull-result';
  requestId: string;
  ok: boolean;
  topics?: MemoryTopicPayload[];
  error?: string;
}

/** Tool-call proxy: the REMOTE worker asks the ORIGIN (coordinator that
 *  opened the connection) to run a tool on its local filesystem — the only
 *  FS that has the code we're exploring. Flow:
 *
 *    origin -- spawn-worker --> remote
 *    remote -- tool-call (Read foo.ts) --> origin
 *    origin executes Read locally
 *    origin -- tool-call-result --> remote
 *    remote continues the subagent loop with the file contents
 *
 *  Same connection that carried spawn-worker is reused. Requests are
 *  correlated by requestId. Only tools in PROXYABLE_TOOLS (read-only
 *  filesystem / LSP / git_*) are accepted; anything else is rejected
 *  origin-side so a compromised worker can't exfiltrate or destroy. */
export interface ToolCallMessage {
  type: 'tool-call';
  requestId: string;
  toolName: string;
  toolInput: unknown;
}

export interface ToolCallResultMessage {
  type: 'tool-call-result';
  requestId: string;
  ok: boolean;
  /** Raw result string — same shape executeTool returns locally. */
  result?: string;
  error?: string;
}

export type ProtocolMessage =
  | HelloMessage | HelloAckMessage
  | SpawnWorkerMessage | SpawnResultMessage
  | ScratchReadMessage | ScratchReadResultMessage
  | ScratchWriteMessage | ScratchWriteResultMessage
  | LoadHintMessage
  | MemoryDigestMessage | MemoryDigestResultMessage
  | MemoryPullMessage | MemoryPullResultMessage
  | PeerGossipMessage | PeerGossipResultMessage
  | ToolCallMessage | ToolCallResultMessage;
