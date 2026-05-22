import { swallow } from '../../utils/log';
/**
 * Helpers for the post-stream handling: usage normalisation across
 * providers, max-tokens detection + auto-continuation, and partial-
 * message persistence on stream failure.
 */

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReads: number;
  cacheWrites: number;
}

/**
 * Normalise the provider's usage payload so callers can use a single
 * camelCase shape regardless of which provider streamed the response.
 *
 * Historical note (bug found 2026-04-23): this used to read only the raw
 * OpenAI/Anthropic shape (snake_case: prompt_tokens, completion_tokens).
 * After porting to direct providers, the providers normalise their output
 * to camelCase (promptTokens, completionTokens) — so every key missed and
 * events.jsonl recorded 48M real tokens as 0. We now accept BOTH shapes,
 * preferring the normalised one.
 */
export function normalizeUsage(lastUsage: any): NormalizedUsage {
  const cacheReads =
    lastUsage.cacheReads ??
    lastUsage.cache_read_input_tokens ??
    lastUsage.prompt_tokens_details?.cached_tokens ??
    0;
  const cacheWrites =
    lastUsage.cacheWrites ??
    lastUsage.cache_creation_input_tokens ??
    0;
  const completionTokens =
    lastUsage.completionTokens ??
    lastUsage.completion_tokens ??
    lastUsage.output_tokens ??
    0;
  // Anthropic's `input_tokens` only counts FRESH tokens (cache hits and
  // writes are reported in separate fields). OpenAI/DeepSeek already
  // include cached tokens inside `prompt_tokens`. If we just took
  // `input_tokens` for Anthropic, the StatusLine `↑` would show e.g.
  // 120k for a turn that actually moved 1.9M (most cached) — under-count
  // by 16×. Detect the Anthropic shape and sum the three fields so
  // promptTokens reflects the real input volume the model processed.
  const isAnthropicShape =
    lastUsage.input_tokens !== undefined
    && lastUsage.prompt_tokens === undefined
    && lastUsage.promptTokens === undefined;
  const promptTokens = isAnthropicShape
    ? (lastUsage.input_tokens || 0) + cacheReads + cacheWrites
    : (lastUsage.promptTokens ?? lastUsage.prompt_tokens ?? lastUsage.input_tokens ?? 0);
  const totalTokens =
    lastUsage.totalTokens ??
    lastUsage.total_tokens ??
    (promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens, cacheReads, cacheWrites };
}

/**
 * Max-tokens detection (Claude Code port: query.ts:1190-1260). When
 * the model's response hit the max_tokens ceiling, `finish_reason`
 * comes back as 'length' (OpenAI) / 'max_tokens' (Anthropic).
 *
 * Asymmetric handling (port of Claude Code claude.ts:2565-2639):
 *   - main turns: auto-inject a synthetic "continue" prompt so the
 *     model resumes. We cap at MAX_CONTINUATION_RETRIES per turn to
 *     prevent runaway loops if the model never completes.
 *   - compact/summary turns: abandon (handled separately in compactSimple
 *     where maxTurns=1 — no retry path exists there).
 *
 * Returns true if a continuation was queued (caller should set
 * `recoverAndRetry`).
 */
export function handleMaxTokensTruncation(args: {
  ctx: any;
  lastUsage: any;
  accumulatedText: string;
  chatMessages: any[];
  buildAssistantMessage: (text: string | null) => any;
  bridge: { addMessage: (m: any) => any };
}): boolean {
  const { ctx, lastUsage, accumulatedText, chatMessages, buildAssistantMessage, bridge } = args;
  const finishReason = (lastUsage?.finish_reason || lastUsage?.stop_reason || '').toString();
  const truncated = finishReason === 'length' || finishReason === 'max_tokens';
  if (!truncated) {
    // Reset the counter when a turn completes normally.
    (ctx as any).__maxTokenContinuations = 0;
    return false;
  }
  try {
    require('../../utils/events').recordEvent('max_tokens_hit', {
      model: ctx.providerInfo?.model,
      finish_reason: finishReason,
      completion_tokens: lastUsage.completion_tokens || lastUsage.output_tokens || 0,
      turn_kind: 'main',
    });
  } catch (err) { swallow(err); }
  const MAX_CONTINUATION_RETRIES = 2;
  const prevRetries = (ctx as any).__maxTokenContinuations || 0;
  if (prevRetries < MAX_CONTINUATION_RETRIES && accumulatedText.trim().length > 0) {
    (ctx as any).__maxTokenContinuations = prevRetries + 1;
    bridge.addMessage({
      role: 'info',
      text: `Response truncated — continuing (${prevRetries + 1}/${MAX_CONTINUATION_RETRIES})…`,
    });
    chatMessages.push(buildAssistantMessage(accumulatedText));
    chatMessages.push({
      role: 'user',
      content: 'You were truncated at max_tokens. Continue EXACTLY where you stopped. Do not repeat content already emitted. If the previous response ended mid-sentence or mid-code-block, resume mid-token.',
    });
    return true;
  }
  if (prevRetries >= MAX_CONTINUATION_RETRIES) (ctx as any).__maxTokenContinuations = 0;
  bridge.addMessage({
    role: 'warn',
    text: 'Response truncated — model hit max_tokens. Ask it to "continue where you stopped" or break the task into smaller pieces.',
  });
  return false;
}
