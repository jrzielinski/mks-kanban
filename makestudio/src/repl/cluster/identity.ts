import { swallow } from '../../utils/log';
/**
 * cluster/identity.ts — Ed25519 self-certifying identity for cluster peers.
 *
 * Each peer has a keypair stored at ~/.makestudio/cluster-identity.json. The
 * public key is the root of trust: peerId is derived as a deterministic
 * fingerprint of the pubkey, so a peer cannot advertise an arbitrary peerId
 * under a different pubkey. Every beacon and handshake carries both the
 * pubkey and a signature, and receivers verify:
 *
 *   1. peerId === fingerprint(pubkey)     (self-certifying identity)
 *   2. sig is valid over the payload      (proof of private key possession)
 *
 * This replaces the old shared-secret HMAC scheme that required copying
 * cluster.json across machines. Now every peer generates its own keypair;
 * trust is granted explicitly via `/cluster trust` once the operator has
 * confirmed the pubkey out-of-band.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  KeyObject,
} from 'crypto';

const IDENTITY_FILE = path.join(os.homedir(), '.makestudio', 'cluster-identity.json');
const FINGERPRINT_LENGTH = 10; // hex chars — peerId = "m-" + fingerprint

export interface Identity {
  peerId: string;
  pubkeyHex: string;
  pubkey: KeyObject;
  privkey: KeyObject;
}

interface StoredIdentity {
  version: 1;
  privkeyPem: string;
  pubkeyPem: string;
}

let cached: Identity | null = null;

/**
 * Deterministic peerId derived from the raw 32-byte Ed25519 public key.
 * Same key → same peerId, forever. Different key → different peerId.
 */
export function fingerprint(pubkeyHex: string): string {
  return 'm-' + createHash('sha256').update(Buffer.from(pubkeyHex, 'hex')).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

function loadFromDisk(): Identity | null {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) return null;
    const stored: StoredIdentity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    if (stored.version !== 1) return null;
    const privkey = createPrivateKey(stored.privkeyPem);
    const pubkey = createPublicKey(stored.pubkeyPem);
    const pubkeyHex = rawPublicKey(pubkey).toString('hex');
    return { peerId: fingerprint(pubkeyHex), pubkeyHex, pubkey, privkey };
  } catch {
    return null;
  }
}

function saveToDisk(id: Identity): void {
  const stored: StoredIdentity = {
    version: 1,
    privkeyPem: id.privkey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pubkeyPem: id.pubkey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(stored, null, 2));
  // Private key on disk — restrict to owner. Best-effort (Windows tolerates failure).
  try { fs.chmodSync(IDENTITY_FILE, 0o600); } catch (err) { swallow(err); }
}

/**
 * Extract the raw 32-byte Ed25519 public key from a KeyObject. Node's SPKI
 * wrapper prepends 12 bytes of DER header before the raw key material.
 */
function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' });
  return der.slice(der.length - 32);
}

/**
 * Returns the peer's long-lived identity, generating and persisting it on
 * first call. Subsequent calls in-process return the cached value.
 */
export function getIdentity(): Identity {
  if (cached) return cached;

  const existing = loadFromDisk();
  if (existing) {
    cached = existing;
    return cached;
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubkeyHex = rawPublicKey(publicKey).toString('hex');
  const id: Identity = {
    peerId: fingerprint(pubkeyHex),
    pubkeyHex,
    pubkey: publicKey,
    privkey: privateKey,
  };
  saveToDisk(id);
  cached = id;
  return cached;
}

/**
 * Sign arbitrary bytes with our private key. Returns hex-encoded signature.
 */
export function sign(data: Buffer | string): string {
  const id = getIdentity();
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return cryptoSign(null, buf, id.privkey).toString('hex');
}

/**
 * Verify a signature against a public key (hex-encoded raw pubkey). Returns
 * false for any failure (bad key format, bad signature, mismatch).
 */
export function verify(data: Buffer | string, sigHex: string, pubkeyHex: string): boolean {
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const sigBuf = Buffer.from(sigHex, 'hex');
    // Reconstruct SPKI from the raw 32-byte key. Node needs the DER wrapper,
    // but for Ed25519 the wrapper is constant — prepend the fixed header.
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), // Ed25519 SPKI prefix
      Buffer.from(pubkeyHex, 'hex'),
    ]);
    const pubkey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(null, buf, pubkey, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Canonical serialization for signing beacon/handshake payloads: JSON with
 * sorted keys so both sides compute the exact same byte string regardless
 * of property insertion order in their respective code paths.
 */
export function canonicalize(obj: Record<string, any>): string {
  const keys = Object.keys(obj).sort();
  const ordered: Record<string, any> = {};
  for (const k of keys) ordered[k] = obj[k];
  return JSON.stringify(ordered);
}

/**
 * Test-only hook: wipe cached identity so a fresh keypair is generated on
 * the next getIdentity() call. Never used in production code.
 */
export function __resetIdentityForTests(): void {
  cached = null;
}
