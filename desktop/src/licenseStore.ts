/**
 * Offline machine-bound licensing for MKS Kanban.
 *
 * Flow:
 *   1 First launch → generate a machine fingerprint + key-pair.
 *   2 User pastes a license JWT obtained from the Makestudio store.
 *   3 We verify the JWT signature, bind it to this machine + check expiry.
 *   4 The renderer reads `isValid` + `daysLeft` from the bridge.
 *
 * The public key for verification is compiled into this file.
 */
import { app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/* ── Ed25519 key-pair baked at build time (placeholder) ────────────────
   In production this is replaced during CI with the real Makestudio key.
   The PRIVATE key lives ONLY on the Makestudio store server.
*/
const BUILTIN_PUBKEY = 'MCowBQYDK2VwAyEA6FHA8M6JFHHV9d5H9z+TqHmRjA6XHJcXldHxbYAMzGQ=';

export interface LicensePayload {
  sub: string;            // machine fingerprint
  exp: number;            // Unix seconds — expiry
  iat: number;            // issued at
  plan: 'free' | 'pro' | 'enterprise';
  features: string[];     // ["agent", "offline", "collaboration"]
}

export interface LicenseState {
  isValid: boolean;
  plan: 'free' | 'pro' | 'enterprise';
  features: string[];
  daysLeft: number;
  machineId: string;
  error?: string;
}

/* ── Machine fingerprint ─────────────────────────────────────────────── */

function machineFingerprint(): string {
  const parts: string[] = [];

  try {
    const os = require('os');
    parts.push(os.hostname());
    parts.push(os.platform());
    parts.push(os.arch());

    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces!) as any[]) {
      if (iface) {
        for (const addr of iface) {
          if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
            parts.push(addr.mac);
            break;
          }
        }
      }
      if (parts.length > 3) break;
    }
  } catch { /* ignore */ }

  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return hash;
}

/* ── License file I/O ────────────────────────────────────────────────── */

function licenseFilePath(): string {
  return path.join(app.getPath('userData'), 'kanban-license.json');
}

interface StoredLicense {
  jwt: string;
  machineId: string;
  cachedAt: number; // Unix seconds when last verified
}

function readStored(): StoredLicense | null {
  try {
    const file = licenseFilePath();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw) as StoredLicense;
    return data;
  } catch {
    return null;
  }
}

function writeStored(jwt: string, machineId: string): void {
  const data: StoredLicense = { jwt, machineId, cachedAt: Math.floor(Date.now() / 1000) };
  const json = JSON.stringify(data);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8');
  fs.writeFileSync(licenseFilePath(), buf, { mode: 0o600 });
}

function deleteStored(): void {
  try {
    const file = licenseFilePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* ignore */ }
}

/* ── JWT verification (stateless) ────────────────────────────────────────
   Minimal — no library dependency. Works with Ed25519 JWTs.
   Falls back to RS256 if Ed25519 is unsupported.
*/

function base64UrlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function verifyJwt(jwt: string, pubkeyBase64: string): LicensePayload | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf-8'));
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));

    // Verify signature
    const data = `${headerB64}.${payloadB64}`;
    const sig = base64UrlDecode(sigB64);
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(pubkeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    const ok = crypto.verify(
      header.alg === 'EdDSA' ? null : 'sha256',
      Buffer.from(data, 'utf-8'),
      pubKey,
      sig,
    );
    if (!ok) return null;

    // Validate payload structure
    if (!payload.sub || !payload.exp || !payload.iat) return null;

    return {
      sub: payload.sub,
      exp: payload.exp,
      iat: payload.iat,
      plan: payload.plan || 'free',
      features: payload.features || [],
    };
  } catch {
    return null;
  }
}

/* ── Public API ──────────────────────────────────────────────────────── */

let _cachedState: LicenseState | null = null;

function computeState(license: StoredLicense | null): LicenseState {
  const machineId = machineFingerprint();

  if (!license) {
    return {
      isValid: false,
      plan: 'free',
      features: [],
      daysLeft: 0,
      machineId,
      error: 'No license installed',
    };
  }

  // Machine binding
  if (license.machineId !== machineId) {
    return {
      isValid: false,
      plan: 'free',
      features: [],
      daysLeft: 0,
      machineId,
      error: 'License bound to different machine',
    };
  }

  const payload = verifyJwt(license.jwt, BUILTIN_PUBKEY);
  if (!payload) {
    return {
      isValid: false,
      plan: 'free',
      features: [],
      daysLeft: 0,
      machineId,
      error: 'License signature invalid',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return {
      isValid: false,
      plan: 'free',
      features: [],
      daysLeft: 0,
      machineId,
      error: 'License expired',
    };
  }

  const daysLeft = Math.floor((payload.exp - now) / 86400);

  return {
    isValid: true,
    plan: payload.plan,
    features: payload.features,
    daysLeft,
    machineId,
  };
}

export function getLicenseState(): LicenseState {
  if (_cachedState) return _cachedState;

  const stored = readStored();
  _cachedState = computeState(stored);
  return _cachedState;
}

export function installLicense(jwt: string): LicenseState {
  const machineId = machineFingerprint();

  // Validate before persisting
  const payload = verifyJwt(jwt, BUILTIN_PUBKEY);
  if (!payload) {
    const err: LicenseState = {
      isValid: false,
      plan: 'free',
      features: [],
      daysLeft: 0,
      machineId,
      error: 'License signature invalid — check the key',
    };
    _cachedState = err;
    return err;
  }

  // Expired at install time?
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    const err: LicenseState = {
      isValid: false,
      plan: 'free',
      features: [],
      daysLeft: 0,
      machineId,
      error: 'This license expired on ' + new Date(payload.exp * 1000).toISOString(),
    };
    _cachedState = err;
    return err;
  }

  writeStored(jwt, machineId);
  _cachedState = null; // invalidate cache
  return getLicenseState();
}

export function clearLicense(): void {
  deleteStored();
  _cachedState = null;
}

export function getMachineId(): string {
  return machineFingerprint();
}

// Re-read on resume (e.g. after sleep — re-check expiry)
export function refreshLicenseState(): LicenseState {
  _cachedState = null;
  return getLicenseState();
}
