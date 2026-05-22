import type { ProviderResponse, StreamChunk } from '../providers';
import { OpenAICompatProvider } from './direct-openai';
import { AnthropicDirectProvider } from './direct-anthropic';
import { CatalogEntry, DirectCallParams, ModelTier } from './types';
import { getCatalogEntry, pickAvailableTier } from './catalog';
import { hasProviderKey } from '../../../config/credentials';

export interface DirectProvider {
  provider: string;
  model: string;
  send(params: DirectCallParams): Promise<ProviderResponse>;
  stream(params: DirectCallParams): AsyncGenerator<StreamChunk, void, unknown>;
}

export function buildDirectProvider(entry: CatalogEntry): DirectProvider {
  if (entry.provider === 'anthropic') return new AnthropicDirectProvider(entry);
  return new OpenAICompatProvider(entry);
}

export interface TierSelection {
  tier: ModelTier;
  entry: CatalogEntry;
  provider: DirectProvider;
}

export function selectProviderForTier(preferred: ModelTier): TierSelection | null {
  const tier = pickAvailableTier(preferred);
  if (!tier) return null;
  const entry = getCatalogEntry(tier);
  // Pass baseURL so we recognize tier-specific keys when two configs
  // share a provider name (e.g. openai → deepseek+openai composites).
  if (!hasProviderKey(entry.provider, entry.baseURL)) return null;
  return { tier, entry, provider: buildDirectProvider(entry) };
}
