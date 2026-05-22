import type { DirectUsage } from './providers/types';

export interface UsageSample {
  provider: string;
  model: string;
  tier?: 'fast' | 'default' | 'image';
  promptTokens: number;
  completionTokens: number;
  cacheReads: number;
  cacheWrites: number;
  at: number;
}

let pending: UsageSample[] = [];

export function recordUsage(sample: {
  provider: string;
  model: string;
  tier?: 'fast' | 'default' | 'image';
  usage?: Partial<DirectUsage>;
}): void {
  if (!sample?.usage) return;
  const u = sample.usage;
  if (!u.promptTokens && !u.completionTokens) return;
  pending.push({
    provider: sample.provider,
    model: sample.model,
    tier: sample.tier,
    promptTokens: u.promptTokens || 0,
    completionTokens: u.completionTokens || 0,
    cacheReads: u.cacheReads || 0,
    cacheWrites: u.cacheWrites || 0,
    at: Date.now(),
  });
}

export function drainPending(): UsageSample[] {
  const out = pending;
  pending = [];
  return out;
}

export function peekPending(): UsageSample[] {
  return pending.slice();
}
