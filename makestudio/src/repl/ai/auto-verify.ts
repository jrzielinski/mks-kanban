/**
 * auto-verify.ts
 *
 * End-of-turn hook that dispatches a read-only verification subagent after
 * any turn where file edits happened. Bridges the final gap that compile-gate
 * and git-diff-gate can't cover: semantic lies — code that compiles but
 * doesn't do what the model claimed (missing SDK calls, empty tokens,
 * unwired buttons, 404 backend endpoints, etc.).
 *
 * Pattern ported from claude-code/src/tools/AgentTool/built-in/verificationAgent.ts.
 * Claude Code's version is model-initiated (the main agent decides when to
 * call it). Ours is host-initiated — we auto-dispatch on the user's behalf
 * so weak models that skip voluntary verification still get caught.
 *
 * Default is OFF — the verifier can spend hundreds of thousands of
 * tokens chasing its tail on a trivial edit, and when it gets confused
 * (thinking cached Read vs fresh Grep disagree, etc.) it loops until
 * timeout. Opt in with /verify on when you need the safety net.
 */

import { ReplContext } from '../context';

export interface VerifyResult {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'UNKNOWN';
  summary: string;
}

/** Heuristic: should we trigger verification for this turn? */
export function shouldAutoVerify(ctx: ReplContext): boolean {
  // 1. User must explicitly opt in. Default is OFF. Legacy
  //    `autoVerifyDisabled === false` also counts as opt-in for
  //    backwards compatibility with existing settings.json files
  //    that were written under the old default-on semantics.
  try {
    const { loadSettings } = require('../settings');
    const s = loadSettings() || {};
    const enabled = s.autoVerifyEnabled === true
      || (s.autoVerifyDisabled === false && s.autoVerifyEnabled === undefined);
    if (!enabled) return false;
  } catch { return false; }

  // 2. Env escape hatch (tests, CI, power users) — still honoured.
  if (process.env.MAKESTUDIO_NO_AUTO_VERIFY === '1') return false;

  // 3. Only if at least one file was edited this turn.
  try {
    const hooks = require('./post-edit-hooks');
    // Accessing the module-level WeakMap via the tracked edit helpers.
    // post-edit-hooks doesn't export getTurnEdits, so use formatTurnSummary
    // as a "there were edits" probe — it returns null when the set is empty.
    const summary = hooks.formatTurnSummary(ctx);
    if (!summary) return false;
  } catch { return false; }

  return true;
}

/**
 * Build the prompt we hand to the verification subagent. The subagent has
 * NO conversation history — everything it needs must be in this string.
 */
export function buildVerifyTask(
  ctx: ReplContext,
  originalRequest: string,
  assistantFinalText: string,
): string {
  let filesSummary = '';
  try {
    const { formatTurnSummary } = require('./post-edit-hooks');
    filesSummary = formatTurnSummary(ctx) || '(no files tracked)';
  } catch {
    filesSummary = '(no files tracked)';
  }

  const projectLine = ctx.activeProject
    ? `Project: ${ctx.activeProject.name} at ${ctx.activeProject.localPath || ctx.cwd}`
    : `Working directory: ${ctx.cwd}`;

  // Cap the assistant text — if the model rambled we don't want to blow
  // the verification subagent's context on it.
  const asstExcerpt = assistantFinalText.length > 2000
    ? assistantFinalText.slice(0, 2000) + '\n...[truncated]'
    : assistantFinalText;

  return `${projectLine}

## Original user request
${originalRequest}

## Files the implementer claims to have changed this turn
${filesSummary}

## Implementer's summary of what was done
${asstExcerpt}

## Your task
Verify that the implementation actually does what the implementer claims.
Run builds, tests, linters, and adversarial probes. Pay extra attention to
the "Common lies to probe" section of your system prompt — unwired UI, empty
placeholders, missing SDK imports, backend endpoints that don't exist.

Keep the report concise. End with exactly one of:
  VERDICT: PASS
  VERDICT: FAIL
  VERDICT: PARTIAL`;
}

/** Parse VERDICT: line from the subagent's output. */
export function parseVerdict(text: string): VerifyResult['verdict'] {
  // Match from the END of the string backwards — the subagent may mention
  // "VERDICT:" earlier in prose when describing the format.
  const lines = text.split('\n').map(l => l.trim()).reverse();
  for (const line of lines) {
    const m = line.match(/^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i);
    if (m) return m[1].toUpperCase() as VerifyResult['verdict'];
  }
  return 'UNKNOWN';
}

/**
 * Dispatch the verification subagent via dispatch_agent and return the
 * parsed result. Best-effort: on any error, returns UNKNOWN so the turn
 * doesn't hang / crash just because verification broke.
 */
export async function runAutoVerify(
  ctx: ReplContext,
  originalRequest: string,
  assistantFinalText: string,
): Promise<VerifyResult> {
  const task = buildVerifyTask(ctx, originalRequest, assistantFinalText);

  try {
    const { executeTool } = require('./tools');
    const rawResult = await executeTool(
      'dispatch_agent',
      { task, subagent_type: 'verification' },
      ctx,
    );

    let summary = '';
    try {
      const parsed = JSON.parse(rawResult);
      summary = parsed.summary || parsed.error || rawResult;
    } catch {
      summary = rawResult;
    }

    return {
      verdict: parseVerdict(summary),
      summary: summary.trim(),
    };
  } catch (err: any) {
    return {
      verdict: 'UNKNOWN',
      summary: `Verification dispatch failed: ${err?.message || String(err)}`,
    };
  }
}
