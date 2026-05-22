/**
 * costs.ts — pricing tables + cost estimation helpers.
 *
 * USD per 1M tokens, in/out. The single source of truth for `/cost` slash
 * command, the Phase 10 UsagePage, and the Phase 11 ProvidersPage. Earlier
 * the same numbers lived inline in repl/commands.ts; centralizing here so
 * a price update lands in one place and downstream callers stay in sync.
 *
 * Adding a new model: append a key here. The matcher uses fuzzy substring
 * (model.toLowerCase().includes(key.toLowerCase())) so "claude-sonnet-4-6"
 * resolves to "claude-sonnet-4" automatically — but if you need different
 * pricing for a sub-variant, prefer the longer key first in the loop.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

/**
 * USD per 1M tokens. Values current as of 2026-04 — keep updated when
 * providers shift pricing. Sub-variants (claude-sonnet-4-6) match via the
 * fuzzy resolver in `pricingForModel`.
 */
export const PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { in: 2.50, out: 10.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4.1': { in: 3.00, out: 12.00 },
  'claude-sonnet-4': { in: 3.00, out: 15.00 },
  'claude-opus-4': { in: 15.00, out: 75.00 },
  'claude-haiku-4': { in: 0.80, out: 4.00 },
  'llama-4-scout-17b': { in: 0.11, out: 0.34 },
  'llama-3.3-70b': { in: 0.59, out: 0.79 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40 },
  'gemini-2.5-pro': { in: 2.50, out: 10.00 },
};

/**
 * Resolve a model identifier to its pricing entry. Substring match is
 * case-insensitive; longer keys are tried first so a `claude-haiku-4`
 * call doesn't get billed as `claude-opus-4` because of a partial match
 * on a shorter key. Returns null when nothing matches.
 */
export function pricingForModel(model: string): ModelPricing | null {
  const m = model.toLowerCase();
  const keys = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.includes(key.toLowerCase())) return PRICING[key];
  }
  return null;
}

/**
 * Estimate USD cost given a model + token counts. Returns 0 when the
 * model is unknown — caller distinguishes "free" vs "unknown" via
 * `pricingForModel(model) === null` if it cares.
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = pricingForModel(model);
  if (!p) return 0;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}

/**
 * Tries hard to never throw — used in aggregate paths where a single bad
 * row shouldn't tank the rollup. Equivalent to estimateCost but coerces
 * non-numeric inputs to 0.
 */
export function tryEstimateCost(
  model: unknown,
  promptTokens: unknown,
  completionTokens: unknown,
): number {
  const m = typeof model === 'string' ? model : '';
  const i = typeof promptTokens === 'number' && Number.isFinite(promptTokens) ? promptTokens : 0;
  const o = typeof completionTokens === 'number' && Number.isFinite(completionTokens) ? completionTokens : 0;
  return estimateCost(m, i, o);
}

/**
 * Sum of estimated cost across a list of model breakdowns. Used by the
 * usage aggregator to fill UsageStats.totalCostUSD.
 */
export function totalCost(
  models: Array<{ model: string; tokensIn: number; tokensOut: number }>,
): number {
  let sum = 0;
  for (const m of models) sum += estimateCost(m.model, m.tokensIn, m.tokensOut);
  return sum;
}

/** Input-side price only — used for cache savings estimates. */
export function inputPrice(model: string): number {
  return pricingForModel(model)?.in ?? 0;
}
