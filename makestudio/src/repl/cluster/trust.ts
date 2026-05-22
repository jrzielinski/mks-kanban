import { swallow } from '../../utils/log';
/**
 * cluster/trust.ts — per-peer capability grants, optionally scoped by path.
 *
 * ~/.makestudio/cluster-trust.json (v2):
 *   {
 *     "version": 2,
 *     "peers": {
 *       "m-abc123": {
 *         "pubkey": "<hex>",
 *         "global": { "allowBash": false, "allowWrite": false },
 *         "scopes": {
 *           "/home/me/develop/repo": { "allowBash": true, "allowWrite": true }
 *         }
 *       }
 *     }
 *   }
 *
 * Default for an unknown peer: read-only everywhere. Trust is GRANTED
 * explicitly via `/cluster trust <peerId> [--scope <path>] --allow-bash`
 * — never implicit.
 *
 * Resolution: getPeerTrust(peerId, cwd?) returns the most specific scope
 * that contains `cwd` (longest-prefix match), falling back to `global`.
 * `cwd` omitted → global only.
 *
 * Migration from v1: v1 used random-string peerIds (hash of hostname+home),
 * which are no longer produced once Ed25519 identity lands. v1 entries
 * can't be silently upgraded because we don't know the peer's pubkey. On
 * first load of a v1 file we back it up, emit a warning, and start fresh.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PeerTrust {
  allowBash: boolean;
  allowWrite: boolean;
}

export interface PeerTrustEntry {
  pubkey?: string;           // pinned on first /cluster trust; verified on connect
  global: PeerTrust;
  scopes: Record<string, PeerTrust>;
}

interface TrustFileV2 {
  version: 2;
  peers: Record<string, PeerTrustEntry>;
}

const TRUST_FILE = path.join(os.homedir(), '.makestudio', 'cluster-trust.json');
const DEFAULT_TRUST: PeerTrust = { allowBash: false, allowWrite: false };

function emptyFile(): TrustFileV2 {
  return { version: 2, peers: {} };
}

function loadTrustFile(): TrustFileV2 {
  try {
    if (!fs.existsSync(TRUST_FILE)) return emptyFile();
    const raw = fs.readFileSync(TRUST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.version === 2 && parsed.peers && typeof parsed.peers === 'object') {
        return parsed;
      }
      // v1 (or anything older/malformed) — back up and start fresh. The
      // peerId shape changed with Ed25519 identity, so old entries are
      // guaranteed to be useless.
      if (parsed.peers && typeof parsed.peers === 'object') {
        const backup = TRUST_FILE + '.v1.bak';
        try {
          fs.writeFileSync(backup, raw);
          fs.chmodSync(backup, 0o600);
        } catch (err) { swallow(err); }
        try {
          // eslint-disable-next-line no-console
          console.error(
            `[cluster] old trust file detected at ${TRUST_FILE}; backed up to ${backup}. ` +
            `Peer IDs changed format (now derived from Ed25519 pubkey). Re-grant trust with /cluster trust.`,
          );
        } catch (err) { swallow(err); }
      }
    }
  } catch (err) { swallow(err); }
  return emptyFile();
}

function saveTrustFile(data: TrustFileV2): void {
  try {
    fs.mkdirSync(path.dirname(TRUST_FILE), { recursive: true });
    fs.writeFileSync(TRUST_FILE, JSON.stringify(data, null, 2));
    try { fs.chmodSync(TRUST_FILE, 0o600); } catch (err) { swallow(err); }
  } catch (err) { swallow(err); }
}

function defaultEntry(): PeerTrustEntry {
  return { global: { ...DEFAULT_TRUST }, scopes: {} };
}

/**
 * Longest-prefix match: if `cwd` is under multiple scopes, the most specific
 * wins. Normalizes trailing slashes. Uses path.resolve so relative inputs
 * don't produce surprising matches.
 */
function bestScope(entry: PeerTrustEntry, cwd: string): PeerTrust | null {
  const normalizedCwd = path.resolve(cwd);
  const matches: Array<{ scope: string; trust: PeerTrust }> = [];
  for (const [scope, trust] of Object.entries(entry.scopes)) {
    const normalizedScope = path.resolve(scope);
    if (normalizedCwd === normalizedScope || normalizedCwd.startsWith(normalizedScope + path.sep)) {
      matches.push({ scope: normalizedScope, trust });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.scope.length - a.scope.length);
  return matches[0].trust;
}

/**
 * Resolve the effective trust for a peer in a specific working directory.
 * A scope-level `true` wins over a global `false`, and vice versa — each
 * capability is resolved independently with the scope taking precedence
 * when set, otherwise falling back to global.
 */
export function getPeerTrust(peerId: string, cwd?: string): PeerTrust {
  const data = loadTrustFile();
  const entry = data.peers[peerId];
  if (!entry) return { ...DEFAULT_TRUST };
  if (!cwd) return { ...entry.global };
  const scope = bestScope(entry, cwd);
  if (!scope) return { ...entry.global };
  return {
    allowBash: scope.allowBash,
    allowWrite: scope.allowWrite,
  };
}

export interface SetPeerTrustOptions {
  trust: Partial<PeerTrust>;
  scope?: string;    // absolute path — omitted → update global
  pubkey?: string;   // pin pubkey when known (first trust grant)
}

export function setPeerTrust(peerId: string, opts: SetPeerTrustOptions): PeerTrust {
  const data = loadTrustFile();
  const entry = data.peers[peerId] || defaultEntry();
  if (opts.pubkey && !entry.pubkey) entry.pubkey = opts.pubkey;

  if (opts.scope) {
    const scopePath = path.resolve(opts.scope);
    const current = entry.scopes[scopePath] || { ...DEFAULT_TRUST };
    const next: PeerTrust = { ...current, ...opts.trust };
    entry.scopes[scopePath] = next;
    data.peers[peerId] = entry;
    saveTrustFile(data);
    return next;
  }

  const next: PeerTrust = { ...entry.global, ...opts.trust };
  entry.global = next;
  data.peers[peerId] = entry;
  saveTrustFile(data);
  return next;
}

/**
 * Remove trust for a peer (whole entry) or a single scope.
 * Returns true when something was removed.
 */
export function revokePeerTrust(peerId: string, scope?: string): boolean {
  const data = loadTrustFile();
  const entry = data.peers[peerId];
  if (!entry) return false;
  if (scope) {
    const scopePath = path.resolve(scope);
    if (!(scopePath in entry.scopes)) return false;
    delete entry.scopes[scopePath];
    saveTrustFile(data);
    return true;
  }
  delete data.peers[peerId];
  saveTrustFile(data);
  return true;
}

export interface PeerTrustListing {
  peerId: string;
  pubkey?: string;
  global: PeerTrust;
  scopes: Array<{ path: string } & PeerTrust>;
}

export function listPeerTrust(): PeerTrustListing[] {
  const data = loadTrustFile();
  return Object.entries(data.peers).map(([peerId, e]) => ({
    peerId,
    pubkey: e.pubkey,
    global: e.global,
    scopes: Object.entries(e.scopes).map(([p, t]) => ({ path: p, ...t })),
  }));
}

/**
 * Returns true when a subagent type is read-only — its whitelist contains
 * no Write/Edit/MultiEdit/Bash/shell_run/NotebookEdit. Cheap proxy so the
 * server doesn't need to materialise the full config for every spawn.
 */
export async function isReadOnlySubagentType(subagentType: string): Promise<boolean> {
  if (!subagentType || subagentType === 'general-purpose' || subagentType === 'explore' || subagentType === 'plan') {
    return true;
  }
  return false;
}
