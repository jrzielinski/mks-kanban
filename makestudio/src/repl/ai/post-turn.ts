import { ReplContext } from '../context';
import { schedulePromptSuggestion, scheduleMemoryExtraction } from './background-tasks';

import { swallow } from '../../utils/log';
/**
 * Streaming post-turn pipeline. Runs after `finalText` was captured and
 * persisted on ctx.messages. Sequential side-effects:
 *   - git-diff summary of files edited this turn
 *   - auto-verify subagent dispatch (if enabled and turn had edits)
 *   - Stop hook (user-defined end-of-turn notification)
 *   - SessionMemory refresh (debounced internally)
 *   - typecheck-watcher capture (camada B)
 *   - memory extraction + prompt suggestion (fire-and-forget)
 *   - magic-docs update (fire-and-forget)
 *
 * Non-blocking apart from `runHooks('Stop', ...)` (so the hook can flush
 * before the prompt returns) and the verify dispatch's bridge messages.
 */
export async function runStreamingPostTurn(
  ctx: ReplContext,
  bridge: any,
  inputRaw: string,
  finalText: string,
): Promise<void> {
  // Git-diff-gate: show what actually changed on disk, per file edited
  // this turn. Lets the user eyeball discrepancies between what the model
  // claims and what git sees ("no net change vs HEAD" = probable mentira).
  try {
    const { formatTurnSummary } = require('./post-edit-hooks');
    const summary = formatTurnSummary(ctx);
    if (summary) bridge.addMessage({ role: 'info', text: summary });
  } catch (err) { swallow(err); }

  // Constraint verifier — runs the real check for each pinned session
  // constraint (test-coverage, tsc-zero, etc) against the files
  // actually modified this turn. Catches the "tests for everything"
  // failure mode where the model creates the test file but never runs
  // it (peer-dep miss, syntax error, etc) and declares done anyway.
  // Only emits a banner when at least one constraint is unmet — keeps
  // turns where everything passed quiet.
  try {
    const { verifyConstraints, formatVerifierResults } = require('../session-constraint-verifier');
    const results = verifyConstraints(ctx);
    const banner = formatVerifierResults(results);
    if (banner) {
      const failed = results.filter((r: any) => r.status === 'FAIL' || r.status === 'PARTIAL');
      bridge.addMessage({ role: failed.length > 0 ? 'error' : 'info', text: banner });
    }
  } catch (err) { swallow(err); }

  // Auto-verify: dispatch the read-only verification subagent if this turn
  // had edits. Catches semantic lies (stub tokens, missing SDK calls,
  // unwired UI, 404 backend routes) that compile-gate can't see because
  // the code is syntactically valid. Toggleable via /verify off.
  try {
    const { shouldAutoVerify, runAutoVerify } = require('./auto-verify');
    if (shouldAutoVerify(ctx)) {
      bridge.addMessage({ role: 'info', text: 'verifying...' });
      // fire-and-await — must block so the user sees the verdict before
      // the prompt returns. Don't push to ctx.messages — verification is
      // meta-information, not part of the dialogue.
      Promise.resolve(runAutoVerify(ctx, inputRaw, finalText))
        .then((r: any) => {
          const icon = r.verdict === 'PASS' ? '✓' : r.verdict === 'FAIL' ? '✗' : '!';
          const role = r.verdict === 'FAIL' ? 'error' : 'info';
          bridge.addMessage({ role, text: `${icon} VERIFY ${r.verdict}\n${r.summary}` });
        })
        .catch(() => { /* already logged inside runAutoVerify */ });
    }
  } catch (err) { swallow(err); }

  // Stop hook — end-of-turn notification. Non-blocking; user can wire
  // this to desktop notifications, external logging, etc.
  try {
    const { runHooks } = require('../hooks');
    await runHooks('Stop', { projectPath: ctx.cwd, currentAbortController: ctx.currentAbortController });
  } catch (err) { swallow(err); }

  // SessionMemory refresh — debounced internally, safe to call every turn.
  try { require('./session-memory').scheduleSessionMemoryUpdate(ctx); } catch (err) { swallow(err); }

  // Camada B — cross-file type-check (tsc --watch background). Não
  // bloqueante: coleta erros novos surgidos neste turno e mostra como
  // info-message via bridge (TUI streaming path).
  try {
    const w = require('./typecheck-watcher');
    const result = w.captureTurnErrors(ctx);
    const msg = w.formatTurnErrors(result, ctx.cwd);
    if (msg) bridge.addMessage({ role: 'info', text: msg });
  } catch (err) { swallow(err); }

  // Auto-memory extraction — non-blocking.
  scheduleMemoryExtraction(ctx);
  // Prompt-suggestion (PromptSuggestion port) — non-blocking.
  schedulePromptSuggestion(ctx);
  // MagicDocs update — non-blocking, only runs if any docs were tracked.
  try {
    Promise.resolve(require('./magic-docs').runMagicDocsUpdates(ctx))
      .then((results: any[]) => {
        if (!results || results.length === 0) return;
        const updated = results.filter(r => r.updated);
        if (updated.length === 0) return;
        const b = require('../tui/bridge').getTuiBridge?.();
        if (b) b.addMessage({ role: 'info', text: `↳ magic-docs updated: ${updated.map(u => u.path).join(', ')}` });
      })
      .catch(() => { /* non-critical */ });
  } catch (err) { swallow(err); }
}
