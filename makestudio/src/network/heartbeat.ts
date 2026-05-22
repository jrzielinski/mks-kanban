import { getApiClient } from './api-client';
import { drainPending, recordUsage } from '../repl/ai/usage-tracker';
import { getCatalog, setCatalog } from '../repl/ai/providers/catalog';
import type { ModelCatalog } from '../repl/ai/providers/types';
import { loadConfig } from '../config/config';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const REQUEST_TIMEOUT_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface HeartbeatResponse {
  license?: {
    valid: boolean;
    reason?: string;
    plan?: string;
    seats?: { used: number; total: number };
    tasks?: { used: number; limit: number };
  };
  catalog?: Partial<ModelCatalog>;
  pollIntervalMs?: number;
}

// Last successful heartbeat — exposed via getLastHeartbeat() so the
// Phase 11 UI (AccountPage / Doctor / Tray) can show license status
// without polling the backend separately.
let lastResponse: HeartbeatResponse | null = null;
let lastResponseAt: number | null = null;
let lastIntervalMs = HEARTBEAT_INTERVAL_MS;

export function getLastHeartbeat(): {
  response: HeartbeatResponse | null;
  at: number | null;
  nextAt: number | null;
} {
  const nextAt = lastResponseAt != null ? lastResponseAt + lastIntervalMs : null;
  return { response: lastResponse, at: lastResponseAt, nextAt };
}

async function sendOnce(): Promise<HeartbeatResponse | null> {
  const samples = drainPending();
  const config = loadConfig();
  try {
    const api = getApiClient();
    const res = await api.post(
      '/cli-agent/heartbeat',
      {
        ts: Date.now(),
        usage: samples,
        sessionId: config?.sessionId,
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    return (res.data || {}) as HeartbeatResponse;
  } catch {
    // Re-queue samples on failure so we don't lose counts. Prepend so order
    // is preserved if multiple heartbeats queue up.
    // (Bounded by memory — pending stays small between flushes.)
    if (samples.length) {
      for (const s of samples) {
        recordUsage({
          provider: s.provider,
          model: s.model,
          tier: s.tier,
          usage: {
            promptTokens: s.promptTokens,
            completionTokens: s.completionTokens,
            cacheReads: s.cacheReads,
            cacheWrites: s.cacheWrites,
          },
        });
      }
    }
    return null;
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const resp = await sendOnce();
    if (resp) {
      lastResponse = resp;
      lastResponseAt = Date.now();
      if (typeof resp.pollIntervalMs === 'number' && resp.pollIntervalMs > 0) {
        lastIntervalMs = resp.pollIntervalMs;
      }
    }
    if (resp?.catalog) {
      // Backend can push catalog updates inline without a separate fetch.
      const current = getCatalog();
      const next: ModelCatalog = { ...current };
      for (const tier of ['fast', 'default', 'image'] as const) {
        const e = resp.catalog[tier];
        if (e?.provider && e?.model) {
          next[tier] = { provider: e.provider, model: e.model, baseURL: e.baseURL, maxOutputTokens: e.maxOutputTokens };
        }
      }
      setCatalog(next);
    }
    if (resp?.license && !resp.license.valid) {
      // Surface license problems but do not kill the REPL — caller decides.
      // eslint-disable-next-line no-console
      console.warn(`[license] ${resp.license.reason || 'invalid'}`);
    }
  } finally {
    running = false;
  }
}

export function startHeartbeat(): void {
  if (timer) return;
  // fire immediately then on interval
  tick().catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  if ((timer as any).unref) (timer as any).unref();
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
