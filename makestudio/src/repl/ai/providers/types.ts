import { DirectProviderName } from '../../../config/credentials';

export type ModelTier = 'fast' | 'default' | 'image';

export interface CatalogEntry {
  provider: DirectProviderName;
  model: string;
  baseURL?: string;
  maxOutputTokens?: number;
}

export type ModelCatalog = Record<ModelTier, CatalogEntry>;

export const DEFAULT_CATALOG: ModelCatalog = {
  fast: {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    maxOutputTokens: 8000,
  },
  default: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    maxOutputTokens: 8192,
  },
  image: {
    provider: 'openai',
    model: 'gpt-4o',
    baseURL: 'https://api.openai.com/v1',
    maxOutputTokens: 4096,
  },
};

export const PROVIDER_DEFAULT_BASE_URL: Record<DirectProviderName, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

export interface DirectCallParams {
  system: string;
  messages: any[];
  tools: any[];
  effort?: 'low' | 'medium' | 'high' | 'max';
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface DirectUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReads?: number;
  cacheWrites?: number;
}
