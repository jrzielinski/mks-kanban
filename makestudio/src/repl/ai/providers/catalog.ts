import { getApiClient } from '../../../network/api-client';
import { CatalogEntry, DEFAULT_CATALOG, ModelCatalog, ModelTier } from './types';
import { hasProviderKey } from '../../../config/credentials';

let inMemoryCatalog: ModelCatalog = { ...DEFAULT_CATALOG };
let lastFetchedAt = 0;
let loaded = false;

// Tiers explicitly overridden by `/repl-chat/info` at login (which respects
// `apiConfig.role`). These take precedence over `/cli-catalog/models` (which
// uses provider-rank heuristics and ignores role). Without this guard, a
// later `fetchCatalog()` call clobbers the per-role config the operator set
// on the backend.
const overriddenTiers = new Set<ModelTier>();

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1h

export function getCatalog(): ModelCatalog {
  return inMemoryCatalog;
}

export function getCatalogEntry(tier: ModelTier): CatalogEntry {
  return inMemoryCatalog[tier];
}

export function setCatalog(next: ModelCatalog): void {
  inMemoryCatalog = next;
  lastFetchedAt = Date.now();
  loaded = true;
}

export function overrideEntry(tier: ModelTier, entry: CatalogEntry): void {
  inMemoryCatalog = { ...inMemoryCatalog, [tier]: entry };
  // Mark so a later fetchCatalog() doesn't clobber it.
  overriddenTiers.add(tier);
}

/**
 * Drop the override flag for a tier so the next fetchCatalog() can update it
 * from the server again. Used by the Phase 11 ProvidersPage when the user
 * clicks "reset to server catalog" on a previously customised tier.
 */
export function clearOverride(tier: ModelTier): void {
  overriddenTiers.delete(tier);
}

export function isOverridden(tier: ModelTier): boolean {
  return overriddenTiers.has(tier);
}

function mergeIntoCatalog(remote: Partial<ModelCatalog>): ModelCatalog {
  const out: ModelCatalog = { ...inMemoryCatalog };
  for (const tier of ['fast', 'default', 'image'] as ModelTier[]) {
    // Skip tiers explicitly set by /repl-chat/info — that endpoint
    // respects apiConfig.role on the backend, while /cli-catalog/models
    // uses a provider-rank heuristic that ignores role. The operator's
    // explicit role assignment must win.
    if (overriddenTiers.has(tier)) continue;
    const entry = remote[tier];
    if (entry && entry.provider && entry.model) {
      out[tier] = {
        provider: entry.provider,
        model: entry.model,
        baseURL: entry.baseURL,
        maxOutputTokens: entry.maxOutputTokens,
      };
    }
  }
  return out;
}

export async function fetchCatalog(opts: { force?: boolean } = {}): Promise<ModelCatalog> {
  if (!opts.force && loaded && Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) {
    return inMemoryCatalog;
  }
  try {
    const api = getApiClient();
    const res = await api.get('/cli-catalog/models', { timeout: 10_000 });
    const data = res.data || {};
    const next = mergeIntoCatalog(data);
    setCatalog(next);
    return next;
  } catch {
    if (!loaded) {
      // first load failed — keep defaults but mark as loaded so we don't spam
      loaded = true;
      lastFetchedAt = Date.now();
    }
    return inMemoryCatalog;
  }
}

export function tierAvailable(tier: ModelTier): boolean {
  const entry = inMemoryCatalog[tier];
  // If the entry has a baseURL it routes through the backend proxy — always available.
  // Local key check only applies when calling the provider directly (no proxy).
  if (entry.baseURL) return true;
  return hasProviderKey(entry.provider, entry.baseURL);
}

export function pickAvailableTier(preferred: ModelTier): ModelTier | null {
  const order: ModelTier[] = [preferred, 'default', 'fast', 'image'];
  for (const t of order) {
    if (tierAvailable(t)) return t;
  }
  return null;
}
