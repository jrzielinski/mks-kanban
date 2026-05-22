import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { swallow } from '../utils/log';
const CONFIG_DIR = path.join(os.homedir(), '.makestudio');
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.enc');

/** Any provider name is valid — the system is agnostic. */
export type DirectProviderName = string;

/**
 * Returns all providers currently known (session + env vars + credentials.enc).
 * Dynamic — reflects what the backend has configured at runtime.
 * Use this instead of any hardcoded list.
 */
export function listKnownProviders(): DirectProviderName[] {
  const seen = new Set<string>();
  // Session keys injected from backend at startup. Strip any
  // "|baseURL" suffix used to disambiguate providers that share a
  // name — listKnownProviders() returns provider names only.
  for (const k of sessionKeys.keys()) {
    const provider = k.split('|', 1)[0];
    if (provider) seen.add(provider);
  }
  // Well-known env var names (user may have set these manually).
  const knownEnvProviders = ['openai', 'anthropic', 'groq', 'cerebras', 'deepseek', 'sambanova', 'together', 'mistral', 'cohere'];
  for (const p of knownEnvProviders) {
    if (ENV_KEYS[p]?.some((k) => process.env[k])) seen.add(p);
  }
  // Persisted credentials.enc keys.
  try {
    const store = readStore();
    for (const p of Object.keys(store.keys)) if (store.keys[p]) seen.add(p);
  } catch (err) { swallow(err); }
  return [...seen];
}

/** @deprecated Use listKnownProviders() — dynamic, not hardcoded. */
export const SUPPORTED_DIRECT_PROVIDERS: DirectProviderName[] = [];

interface EncryptedBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

interface CredentialStore {
  keys: Partial<Record<DirectProviderName, string>>;
  updatedAt: number;
}

function deriveKey(): Buffer {
  const salt = 'makestudio.v1.cred.salt';
  const material = `${os.hostname()}|${os.userInfo().username}|${salt}`;
  return crypto.createHash('sha256').update(material).digest();
}

function encryptBlob(plain: string): EncryptedBlob {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

function decryptBlob(blob: EncryptedBlob): string | null {
  try {
    const key = deriveKey();
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const data = Buffer.from(blob.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

function readStore(): CredentialStore {
  try {
    if (!fs.existsSync(CRED_FILE)) return { keys: {}, updatedAt: 0 };
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const blob = JSON.parse(raw) as EncryptedBlob;
    const plain = decryptBlob(blob);
    if (!plain) return { keys: {}, updatedAt: 0 };
    return JSON.parse(plain) as CredentialStore;
  } catch {
    return { keys: {}, updatedAt: 0 };
  }
}

function writeStore(store: CredentialStore): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const blob = encryptBlob(JSON.stringify(store));
  fs.writeFileSync(CRED_FILE, JSON.stringify(blob), { encoding: 'utf8', mode: 0o600 });
}

const ENV_KEYS: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  sambanova: ['SAMBANOVA_API_KEY'],
  together: ['TOGETHER_API_KEY', 'TOGETHER_AI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  cohere: ['COHERE_API_KEY'],
};

/**
 * In-memory session keys injected from the backend at startup. Not
 * persisted. The store can hold two kinds of entries:
 *   - "<provider>"               — single-config or legacy callers
 *   - "<provider>|<baseURL>"     — multi-config disambiguator
 *
 * Multi-config is needed when two ApiConfigs share `provider` (e.g.
 * both deepseek-v4-flash and gpt-4.1-mini are OpenAI-compatible →
 * provider='openai' for both) but have DIFFERENT api keys keyed by
 * their baseURL. Without the disambiguator, the second injectSessionKey
 * call clobbers the first → the wrong key gets sent to the wrong API.
 */
const sessionKeys: Map<string, string> = new Map();

function normalizeBaseURL(baseURL: string | null | undefined): string | null {
  if (!baseURL) return null;
  return baseURL.toLowerCase().replace(/\/+$/, '');
}

function compositeKey(provider: string, baseURL: string | null | undefined): string {
  const p = provider.toLowerCase();
  const b = normalizeBaseURL(baseURL);
  return b ? `${p}|${b}` : p;
}

/**
 * Injects a provider API key for the current session only. Pass
 * `baseURL` when multiple configs share the same provider name to
 * avoid collisions (e.g. two OpenAI-compat backends with different
 * keys). Without baseURL the key is stored under the provider name
 * alone (legacy behavior — last write wins on collision).
 *
 * Takes priority over credentials.enc and env vars. Nothing on disk.
 */
export function injectSessionKey(provider: string, key: string, baseURL?: string | null): void {
  sessionKeys.set(compositeKey(provider, baseURL), key);
}

/** @deprecated Use injectSessionKey — avoids provider-specific env var names */
export function injectProviderEnvKey(provider: string, key: string): void {
  injectSessionKey(provider, key);
}

export function setProviderKey(provider: DirectProviderName, key: string): void {
  const store = readStore();
  store.keys[provider.toLowerCase()] = key;
  store.updatedAt = Date.now();
  writeStore(store);
}

export function removeProviderKey(provider: DirectProviderName): void {
  const store = readStore();
  delete store.keys[provider.toLowerCase()];
  store.updatedAt = Date.now();
  writeStore(store);
}

/**
 * Look up the key for a provider. Pass `baseURL` to disambiguate when
 * the same provider name has multiple keys. Resolution order:
 *   1. session key matching (provider, baseURL) composite
 *   2. session key matching (provider) alone
 *   3. well-known env var (e.g. OPENAI_API_KEY)
 *   4. persisted credentials.enc
 */
export function getProviderKey(provider: DirectProviderName, baseURL?: string | null): string | null {
  const p = provider.toLowerCase();
  // Composite first — most specific. Only resolved when baseURL given.
  const baseN = normalizeBaseURL(baseURL);
  if (baseN) {
    const composite = sessionKeys.get(`${p}|${baseN}`);
    if (composite) return composite;
  }
  // Provider-only session key.
  const session = sessionKeys.get(p);
  if (session) return session;
  // Well-known env var names for manual override.
  for (const envName of ENV_KEYS[p] || []) {
    const v = process.env[envName];
    if (v && v.trim()) return v.trim();
  }
  // Persisted credentials.enc.
  const store = readStore();
  return store.keys[p] || null;
}

export function listConfiguredProviders(): DirectProviderName[] {
  const result: DirectProviderName[] = [];
  for (const p of listKnownProviders()) {
    if (getProviderKey(p)) result.push(p);
  }
  return result;
}

export function hasProviderKey(provider: DirectProviderName, baseURL?: string | null): boolean {
  return getProviderKey(provider, baseURL) !== null;
}

export function maskKey(key: string): string {
  if (!key) return '';
  // For very short keys, still expose first 2 + last 2 chars so the user
  // can verify they're looking at the right entry. Pure asterisks would
  // make every short key look identical.
  if (key.length <= 6) return key.length >= 2 ? `${key[0]}…${key[key.length - 1]}` : '*';
  if (key.length <= 12) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export type ProviderKeySource = 'session' | 'env' | 'store' | 'none';

/**
 * Same resolution order as getProviderKey, but returns where the key
 * came from. Used by the Phase 11 ProvidersPage so the UI can show a
 * badge ("session" vs "env" vs "store") next to each provider row.
 */
export function getProviderKeySource(
  provider: DirectProviderName,
  baseURL?: string | null,
): ProviderKeySource {
  const p = provider.toLowerCase();
  const baseN = normalizeBaseURL(baseURL);
  if (baseN && sessionKeys.has(`${p}|${baseN}`)) return 'session';
  if (sessionKeys.has(p)) return 'session';
  for (const envName of ENV_KEYS[p] || []) {
    const v = process.env[envName];
    if (v && v.trim()) return 'env';
  }
  const store = readStore();
  if (store.keys[p]) return 'store';
  return 'none';
}
