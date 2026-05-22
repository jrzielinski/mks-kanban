/**
 * zero-result-breaker.ts — interrupt the model when its search tools
 * keep coming back empty.
 *
 * Pattern observed in real sessions: a vague user query ("como estamos
 * na lista?") sends the model on a fishing expedition — Glob this,
 * Grep that, ls here, curl there — and every result is empty. The
 * model never converges, just keeps trying new shapes until the
 * runaway cap or the convergence reminder kick in (often only at
 * 30+ tool calls). Wasted tokens, wasted wall time.
 *
 * The fix: count CONSECUTIVE zero-result tool outputs. As soon as the
 * model produces ONE useful result, the counter resets. So legitimate
 * investigation — refining a Glob pattern from `**\/*.tsx` to
 * `**\/auth/*.tsx` until a real match shows up — never trips the
 * breaker, because the eventual hit zeroes the streak.
 *
 * Two thresholds:
 *   - SOFT (3 consecutive): inject a system reminder that suggests
 *     reformulating or asking the user to clarify, but doesn't stop
 *     the loop. Lets the model self-correct.
 *   - HARD (6 consecutive): force the dispatcher to break the turn
 *     and hand control back to the user. Prevents pathological
 *     fanouts from burning unbounded tokens.
 *
 * Soft fires once per turn (one nudge is enough). Hard always fires
 * once it crosses the threshold. Both are silent when the breaker
 * is disabled (set settings.zeroResultBreaker:false to opt out).
 */

const SOFT_THRESHOLD = 3;
const HARD_THRESHOLD = 6;

// ── Activation check ─────────────────────────────────────────────

let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const env = (process.env.MAKESTUDIO_ZERO_RESULT_BREAKER || '').toLowerCase().trim();
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    const s = loadSettings() as any;
    // Default: OFF. The breaker can confuse the model when legitimate
    // exploration is happening — the soft hint at 3 zero-results
    // pushes the model to "stop guessing" even when it was making
    // sensible incremental searches. Opt-in only.
    cachedEnabled = s?.zeroResultBreaker === true;
    return cachedEnabled;
  } catch { cachedEnabled = false; return false; }
}

export function resetZeroResultBreakerCache(): void { cachedEnabled = null; }

// ── Zero-result detector ─────────────────────────────────────────

const SEARCH_TOOLS = new Set([
  'Read', 'read_file',
  'Glob', 'Grep',
  'WebFetch', 'web_fetch',
  'lsp_definition', 'lsp_references', 'lsp_workspace_symbol',
]);

/**
 * Decide whether a tool output represents "zero useful results found".
 * High-precision — false positives here mean we wrongly increment the
 * counter and might trip the breaker on a productive turn. So we only
 * match the EXACT zero-shape phrases the tool implementations emit,
 * not generic empty strings or arbitrary errors.
 *
 * Tools that mutate (Edit/Write/Bash) are excluded entirely — the
 * breaker is a SEARCH-fanout detector, not a generic failure
 * detector. Bash exit-code 0 with empty stdout is meaningful for
 * many legitimate commands (touch, mkdir, mv).
 */
export function isZeroResult(toolName: string, output: any, ok: boolean): boolean {
  if (!SEARCH_TOOLS.has(toolName)) return false;
  if (typeof output !== 'string' || output.length === 0) return false;

  // Read with file-not-found error → counted as zero (exfil into
  // wrong directories during fishing). The dispatcher serialises
  // errors as JSON; check both shapes.
  if (toolName === 'Read' || toolName === 'read_file') {
    if (!ok && /File not found:/i.test(output)) return true;
    // No-content file is NOT zero — empty file is a valid finding.
    return false;
  }

  if (toolName === 'Glob') {
    return /^No files matched pattern:/m.test(output);
  }

  if (toolName === 'Grep') {
    return /^No matches for \//m.test(output);
  }

  if (toolName === 'WebFetch' || toolName === 'web_fetch') {
    // 404, empty body, "not found" responses
    if (!ok && /\b(404|not found|no such)\b/i.test(output)) return true;
    return false;
  }

  if (toolName.startsWith('lsp_')) {
    // LSP "not found" / "no references" responses are typed as JSON
    // arrays with length 0. Most lsp tools serialise as { result: [] }
    // or [] directly.
    if (/^\s*\[\s*\]\s*$/.test(output)) return true;
    if (/"result"\s*:\s*\[\s*\]/.test(output)) return true;
    if (/\bno (?:definition|references|symbols?) found\b/i.test(output)) return true;
    return false;
  }

  return false;
}

// ── Public API ───────────────────────────────────────────────────

export interface BreakerOutcome {
  /** Soft hint to inject as a system reminder. Empty when no hint. */
  softHint?: string;
  /** Hard stop — caller should break the dispatch loop. */
  hardStop?: boolean;
  /** Current consecutive zero-result count (for diagnostics). */
  streak: number;
}

/**
 * Update the per-context counter and return what should happen now.
 * Caller passes the just-completed tool's name, output, and ok flag;
 * we mutate ctx.__zeroResultStreak and ctx.__zeroResultSoftFired.
 */
export function noteToolOutcome(
  ctx: any,
  toolName: string,
  output: any,
  ok: boolean,
): BreakerOutcome {
  if (!ctx) return { streak: 0 };
  if (!isEnabled()) return { streak: 0 };

  const wasZero = isZeroResult(toolName, output, ok);

  if (!wasZero) {
    // Reset on any productive search. Mutating tools also pass
    // through here but isZeroResult returns false for them, so
    // they leave the counter alone.
    if (SEARCH_TOOLS.has(toolName)) {
      ctx.__zeroResultStreak = 0;
      ctx.__zeroResultSoftFired = false;
    }
    return { streak: ctx.__zeroResultStreak || 0 };
  }

  const streak = (ctx.__zeroResultStreak || 0) + 1;
  ctx.__zeroResultStreak = streak;

  if (streak >= HARD_THRESHOLD) {
    return { streak, hardStop: true };
  }

  if (streak >= SOFT_THRESHOLD && !ctx.__zeroResultSoftFired) {
    ctx.__zeroResultSoftFired = true;
    return { streak, softHint: buildSoftHint(streak) };
  }

  return { streak };
}

function buildSoftHint(streak: number): string {
  return (
    `<system-reminder>` +
    `Your last ${streak} search tool calls (Read/Glob/Grep/etc.) all returned ZERO results. ` +
    `This usually means one of: (a) the search target lives at a different path / has a different ` +
    `name than you expect, (b) the user's request is too vague to investigate without more info, ` +
    `or (c) the symbol genuinely doesn't exist in this codebase.\n\n` +
    `STOP guessing patterns. Pick ONE of:\n` +
    `  - Ask the user (AskUserQuestion tool) for clarification on what they actually want.\n` +
    `  - Make ONE refined search with a much broader pattern (e.g. *.* in repo root).\n` +
    `  - Tell the user honestly that you couldn't find what they asked about.\n\n` +
    `Do NOT continue probing with more Read/Glob/Grep calls until you've reset your hypothesis.` +
    `</system-reminder>`
  );
}

export function buildHardStopMessage(streak: number): string {
  return (
    `<system-reminder>` +
    `BREAKER TRIPPED: ${streak} consecutive search tools returned zero results. ` +
    `The dispatch loop has been interrupted to prevent runaway fanout. ` +
    `Reply to the user with what you couldn't find, ask for clarification, ` +
    `or summarise a different angle of attack — but do NOT issue more search tools ` +
    `in this turn. Counter will reset on the next user message.` +
    `</system-reminder>`
  );
}

/** Test helper / explicit reset (e.g. after /clear). */
export function resetZeroResultStreak(ctx: any): void {
  if (!ctx) return;
  ctx.__zeroResultStreak = 0;
  ctx.__zeroResultSoftFired = false;
}
