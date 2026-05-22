import { swallow } from '../../utils/log';
/**
 * token-estimation.ts
 *
 * Token-budget math + warning helpers extracted from chat.ts.
 *
 * What lives here (all pure, except `checkTokenWarning` which calls the
 * TUI bridge — that side effect is unavoidable for the warning UX):
 *
 *   - estimateContextWindow(model)   per-model window table
 *   - compactThresholdTokens(model)  point at which auto-compact fires
 *   - estimateContextPct(ctx, sys)   current usage as % of window
 *   - estimateTokens(s)              shape-aware per-string token count
 *   - isAtBlockingLimit(ctx, sys)    "next turn would 413" predicate
 *   - checkTokenWarning(ctx, sys)    emit one toast per 80/90/95% crossing
 *
 * Constants exported for callers (autoCompact, microCompact, status line):
 *   MAX_OUTPUT_TOKENS_FOR_SUMMARY, AUTOCOMPACT_BUFFER_TOKENS,
 *   WARNING_THRESHOLD_BUFFER_TOKENS, MANUAL_COMPACT_BUFFER_TOKENS,
 *   COMPACT_MAX_CONSECUTIVE_FAILURES, BLOCKING_LIMIT_BUFFER_TOKENS,
 *   WARN_THRESHOLDS.
 */

// ── Compact threshold constants (Claude Code verbatim, autoCompact.ts:30-65)
//
// These come from the Claude Code post-mortem: threshold = contextWindow
// - MIN(maxOutputTokens, 20K) - AUTOCOMPACT_BUFFER. The 13K buffer is so
// that even if we overshoot a little (cache-break token delta, tool use
// blocks mid-stream), we don't hit the provider's hard limit.

/** P99.99 of real compact-summary output was ≈17.4K. 20K is the safety ceiling. */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/** Margin between "we'll compact" and "the provider rejects us". */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** UI-only: flash a warning in the status line when remaining budget ≤ 20K. */
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
/** When the user manually runs /compact, a tighter buffer is fine. */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/**
 * Circuit breaker: how many consecutive compact failures before auto-compact
 * disables itself for the rest of the session. Matches Claude Code's 3-strike
 * rule (see src/services/compact/autoCompact.ts). Prevents the 250k-calls/day
 * loop scenario from the Claude Code post-mortem.
 */
export const COMPACT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Blocking limit — how many tokens we reserve above the auto-compact
 * threshold before refusing to send another turn without compacting.
 * Port of Claude Code's MANUAL_COMPACT_BUFFER_TOKENS (3K). The goal is to
 * make /compact still have room to materialise its summary even at the
 * brink. Without this gate, a user whose auto-compact failed (circuit
 * breaker tripped) could keep sending turns that the provider 413's.
 */
export const BLOCKING_LIMIT_BUFFER_TOKENS = 3_000;

/** Token-warning gradient — one toast per crossing (80/90/95). */
export const WARN_THRESHOLDS = [80, 90, 95] as const;

/**
 * Context-window table — centralises per-model knowledge so the threshold
 * math is correct per provider. Entries match the real API windows; the
 * default falls back to GPT-4-level 128K for anything we don't recognise.
 */
export function estimateContextWindow(model: string): number {
  const m = (model || '').toLowerCase();
  if (m.includes('claude')) return 200_000;
  if (m.includes('gemini-1.5-pro') || m.includes('gemini-2.')) return 1_000_000;
  if (m.includes('gemini')) return 128_000;
  if (m.includes('gpt-4.1')) return 1_000_000;    // OpenAI long-context variant
  if (m.includes('gpt-4o') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 128_000;
  if (m.includes('llama-3.3') || m.includes('llama-4')) return 128_000;
  if (m.includes('llama3.1-8b')) return 128_000;
  if (m.includes('qwen-3-235b')) return 131_072;
  if (m.includes('qwen-3-32b')) return 131_072;
  if (m.includes('deepseek')) return 128_000;
  return 128_000;
}

/**
 * Claude-Code-style compact threshold. If remaining budget drops below the
 * buffer, compact. Keeps max_tokens reserved from the total window so the
 * summary itself has room to materialise.
 */
export function compactThresholdTokens(model: string): number {
  const ctx = estimateContextWindow(model);
  const reserve = Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, ctx * 0.1);
  return ctx - reserve - AUTOCOMPACT_BUFFER_TOKENS;
}

/**
 * Current context usage as a percentage of the model's window. Sums the
 * system prompt + every message body via the rough 4-chars-per-token
 * heuristic. Used to decide whether to auto-compact or to warn.
 */
export function estimateContextPct(ctx: any, systemPrompt: string): number {
  const systemTokens = Math.ceil(systemPrompt.length / 4);
  const msgTokens = (ctx.messages || []).reduce((s: number, m: any) => {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return s + Math.ceil(body.length / 4);
  }, 0);
  const total = systemTokens + msgTokens;
  const maxCtx = estimateContextWindow(ctx.providerInfo?.model || '');
  return (total / maxCtx) * 100;
}

/**
 * Heuristic tokens-per-char estimator. GPT-family tokenizers vary by content
 * shape: natural English text averages ~4 chars/token; dense code averages
 * ~3; JSON with many short string keys averages ~3.5; CJK / emoji can drop
 * below 1 char/token. We pick based on easy-to-spot signals so the estimate
 * is within ~20% of a real tokenizer without pulling tiktoken.
 */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  const len = s.length;
  // CJK / emoji / most non-ASCII: 1-2 chars per token.
  // eslint-disable-next-line no-control-regex
  const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
  if (nonAscii > len * 0.3) return Math.ceil(len / 1.5);
  // Looks like JSON (starts with {/[, many " : and ,)?
  const trimmed = s.trimStart();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && s.includes('":')) {
    return Math.ceil(len / 3.5);
  }
  // Looks like code (many symbols, few prose-y periods followed by space)?
  // eslint-disable-next-line no-useless-escape
  const symRatio = (s.match(/[{}()\[\];,.<>=/*+\-]/g) || []).length / len;
  if (symRatio > 0.08) return Math.ceil(len / 3);
  // Default: natural language.
  return Math.ceil(len / 4);
}

/**
 * True when context usage is past the point where sending another turn
 * would likely overflow the provider's limit. Caller should short-circuit
 * the send and route the user to /compact or /clear.
 */
export function isAtBlockingLimit(ctx: any, systemPrompt: string): boolean {
  try {
    const systemTokens = Math.ceil((systemPrompt || '').length / 4);
    const msgTokens = (ctx.messages || []).reduce((s: number, m: any) => {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return s + Math.ceil(body.length / 4);
    }, 0);
    const total = systemTokens + msgTokens;
    const maxCtx = estimateContextWindow(ctx.providerInfo?.model || '');
    const blockingLimit = maxCtx - BLOCKING_LIMIT_BUFFER_TOKENS;
    return total >= blockingLimit;
  } catch { return false; }
}

/**
 * Token-warning gradient. After every usage update we check the new
 * context percentage and emit ONE info toast per threshold crossing
 * (80% yellow, 90% warn, 95% red). The thresholds come from Claude Code's
 * compactWarningHook and match what the user sees in the statusline
 * colouring (pctColor logic in StatusLine.tsx).
 *
 * Stateful via `ctx.lastWarnedPct` — a warning for a given threshold fires
 * at most once per session unless a compact/clear drops the pct back down
 * (we reset lastWarnedPct when that happens).
 */
export function checkTokenWarning(ctx: any, systemPrompt: string): void {
  try {
    const pct = estimateContextPct(ctx, systemPrompt);
    // Compact/clear brought us back below the lowest threshold — forget
    // past warnings so they can fire again on the next climb.
    if (pct < WARN_THRESHOLDS[0] && ctx.lastWarnedPct > 0) {
      ctx.lastWarnedPct = 0;
    }
    for (const t of WARN_THRESHOLDS) {
      if (pct >= t && ctx.lastWarnedPct < t) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { tuiLog } = require('../tui/bridge');
        const level = t >= 95 ? 'error' : t >= 90 ? 'warn' : 'info';
        tuiLog(
          `Context usage at ${pct.toFixed(0)}%. ` +
          (t >= 95 ? 'Auto-compact will fire next turn — use /compact to control the summary.' :
           t >= 90 ? 'Near the auto-compact threshold. Consider /compact or /clear.' :
                      'Getting long — microCompact or /compact will help soon.'),
          level as any,
        );
        ctx.lastWarnedPct = t;
      }
    }
  } catch (err) { swallow(err); }
}
