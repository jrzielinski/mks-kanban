/**
 * Axios interceptors for offline support — Phase 6.
 *
 * - Response interceptor (success): caches GET /kanban/* responses in localStorage.
 * - Response interceptor (error): on network failure, returns cached data for GETs
 *   and enqueues the mutation for non-GETs.
 *
 * Call setupOfflineInterceptors(api) once, before any requests are made.
 */

import type { AxiosInstance, AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { enqueue } from './offlineQueue';

const CACHE_PREFIX = 'kanban-cache:';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 h

interface CacheEntry {
  data: unknown;
  ts: number;
}

function cacheKey(url: string, params?: unknown): string {
  const suffix = params ? `:${JSON.stringify(params)}` : '';
  return `${CACHE_PREFIX}${url}${suffix}`;
}

function saveCache(key: string, data: unknown): void {
  try {
    const entry: CacheEntry = { data, ts: Date.now() };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage quota — silently skip
  }
}

function readCache(key: string): unknown | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

const WRITE_METHODS = new Set(['post', 'patch', 'put', 'delete']);

export function setupOfflineInterceptors(api: AxiosInstance): void {
  // ── Cache successful GET /kanban/* responses ───────────────────────────
  api.interceptors.response.use(
    (response) => {
      const method = (response.config.method || '').toLowerCase();
      const url = response.config.url || '';
      if (method === 'get' && url.includes('/kanban')) {
        saveCache(cacheKey(url, response.config.params), response.data);
      }
      return response;
    },
    (error: AxiosError) => {
      const config = error.config;
      // Not a network error or no config — pass through
      if (!config || error.response) return Promise.reject(error);

      const method = (config.method || 'get').toLowerCase();
      const url = config.url || '';

      // GET offline: serve from cache
      if (method === 'get' && url.includes('/kanban')) {
        const cached = readCache(cacheKey(url, config.params));
        if (cached !== null) {
          return Promise.resolve({
            data: cached,
            status: 200,
            statusText: 'OK (offline cache)',
            headers: {},
            config,
          });
        }
      }

      // Non-GET offline: enqueue for later replay
      if (WRITE_METHODS.has(method) && url.includes('/kanban')) {
        let body: unknown;
        try {
          body = config.data ? JSON.parse(config.data as string) : undefined;
        } catch {
          body = config.data;
        }
        enqueue({ method: config.method!, url, data: body });
        toast('Você está offline. A ação será sincronizada ao reconectar.', {
          icon: '📶',
          duration: 5000,
        });
      }

      return Promise.reject(error);
    },
  );
}
