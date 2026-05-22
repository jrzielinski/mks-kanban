import { swallow } from '../../utils/log';
/**
 * chat-guards.ts — anti-fabrication guards extracted from chat.ts.
 *
 * Reason for extraction (2026-04-26): the streaming chat handler had
 * these guards inline; the non-streaming path (handleAIChat) — which is
 * what `runHeadless` invokes for DUM tasks dispatched via WebSocket —
 * had ZERO guard coverage. Anything dispatched as `cli=makestudio` from
 * the dark-factory orchestrator could fabricate output, skip tests, and
 * report success freely. Moving the 5 anti-fabrication guards here lets
 * both handlers share the same protection.
 *
 * Guards covered (in execution order):
 *   1. fabricated-output detector — invented shell-log blocks
 *   2. bash-failure unacknowledged — non-zero exit not mentioned in report
 *   3. number-fabrication — measurements not traceable to tool output
 *   4. search-claim refuted — "X has no callers" disproved by real grep
 *   5. missing-test-execution — prompt demanded tests, response skipped them
 *
 * Guards NOT covered (still inline in handleAIChatStream):
 *   - tool-markup-as-text (catch model emitting markup as prose)
 *   - promised-action (catch "I will edit X" with no tool call)
 *   - absence-claim verifier (audit-mode only)
 *   - contradiction detector (audit-mode only)
 * Those four either fire pre-loop in the streaming path, or are gated by
 * audit-mode keywords that DUM tasks rarely trigger.
 */

import { ReplContext } from '../context';

export interface GuardOptions {
  ctx: ReplContext;
  /** This iteration's response text (model output before tool execution). */
  accumulatedText: string;
  /** This iteration's tool_use blocks. Caller already gated on length === 0. */
  toolUses: any[];
  /** Mutable conversation history — guards push retry messages here. */
  chatMessages: any[];
  /** Build assistant message with proper reasoning_content shape (closure over thinking state). */
  buildAssistantMessage: (text: string | null) => any;
  /** Surface info-level message to the user (TUI bridge or console). */
  surfaceInfo: (text: string) => void;
  /** Surface warn-level message. */
  surfaceWarn: (text: string) => void;
}

/**
 * Run the anti-fabrication guard suite. Caller invokes when `toolUses.length === 0`
 * (model decided to stop emitting tool calls). Returns true when a guard fired
 * and the caller should `continue` the loop instead of breaking out.
 *
 * Guards check + push retry messages atomically — by the time `true` is returned,
 * `chatMessages` has both the assistant turn (so the next iteration sees what was
 * said) and a system-reminder pushing the model to fix the issue.
 */
export async function runAntiFabricationGuards(opts: GuardOptions): Promise<boolean> {
  const { ctx, accumulatedText, toolUses, chatMessages } = opts;
  if (toolUses.length > 0 || !accumulatedText) return false;

  if (await checkFabricatedOutput(opts)) return true;
  if (await checkBashFailureUnacknowledged(opts)) return true;
  if (await checkNumberFabrication(opts)) return true;
  if (await checkSearchClaimRefuted(opts)) return true;
  if (await checkMissingTestExecution(opts)) return true;
  return false;
}

// ── Guard 1: fabricated-output ─────────────────────────────────────────────
// Catches the failure mode where the agent presents a shell-log audit
// ("$ command → output → verdict") but the OUTPUT block doesn't match
// what the tool actually returned. Common with smaller models — they
// paste a selectively-truncated grep that supports their wrong conclusion.
// Gate is intentionally permissive (no auditMode requirement) — the
// underlying detectFabricatedOutput has its own shell-log marker pre-filter.
async function checkFabricatedOutput(opts: GuardOptions): Promise<boolean> {
  const { ctx, accumulatedText, chatMessages, buildAssistantMessage } = opts;
  if ((ctx as any).__fabricatedOutputRetryDone) return false;

  const toolOutputCorpus = chatMessages
    .filter((m: any) => m?.role === 'tool')
    .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
    .join('\n---\n')
    .slice(0, 12000);
  if (!toolOutputCorpus.trim()) return false;

  let fabricated: string | null = null;
  try {
    const { detectFabricatedOutput } = require('./llm-classifier');
    fabricated = await detectFabricatedOutput(accumulatedText, toolOutputCorpus);
  } catch (err) { swallow(err); }
  if (!fabricated) return false;

  (ctx as any).__fabricatedOutputRetryDone = true;
  try {
    require('../debug-log').dbgWarn('fabricated_output_detected', {
      detail: fabricated.slice(0, 400),
    });
  } catch (err) { swallow(err); }
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      'FABRICATED OUTPUT DETECTED — the OUTPUT block(s) you presented do not match what the tools actually returned this turn.\n\n' +
      `Specific issue:\n${fabricated}\n\n` +
      'You are NOT allowed to invent tool output, nor to selectively truncate output in a way that supports a wrong conclusion. The user reads tool outputs from your transcript — if your shell-log block lies about what a grep / read / find returned, the audit is worse than no audit at all.\n\n' +
      'Re-emit the response with HONEST output blocks: paste the REAL tool output (full or trimmed-but-faithful), and update any verdict whose conclusion changes once you look at the real data.\n' +
      '</system-reminder>',
  });
  return true;
}

// ── Guard 2: bash-failure unacknowledged ───────────────────────────────────
// Tracks Bash invocations in this turn that exited non-zero (or got killed/
// timed out) via ctx.__turnBashFailures. If the model's response doesn't
// mention any failure-related word, force a retry with the failure list.
async function checkBashFailureUnacknowledged(opts: GuardOptions): Promise<boolean> {
  const { ctx, accumulatedText, chatMessages, buildAssistantMessage } = opts;
  if ((ctx as any).__bashFailureRetryDone) return false;

  const failures: Array<{ cmd: string; exitCode: number; reason: string }> =
    (ctx as any).__turnBashFailures;
  if (!Array.isArray(failures) || failures.length === 0) return false;

  // Multilingual acknowledgement detector — any failure-related verb counts.
  // Lenient on purpose: a false-negative just makes the guard fire more often.
  const ACKNOWLEDGED = /\b(?:fail(?:ed|ure)?|crash(?:ed|ou)?|error(?:ou)?|exit(?:ed|ou)?|broke?|broken|n[aã]o\s+(?:rodou|funcionou|sucedeu|terminou)|deu\s+(?:ruim|errado|merda)|deu\s+pau|fal(?:hou|hado)|quebr(?:ou|ado)|exit(?:ed|ou)?\s*[:=]?\s*-?\d|non(?:-|\s)?zero|exit\s+code|status\s*\d|abort(?:ed|ou)?|ReferenceError|TypeError|SyntaxError|cancel(?:ed|led|ada|ado)|timeout|timed?\s+out)/i;
  if (ACKNOWLEDGED.test(accumulatedText)) return false;

  (ctx as any).__bashFailureRetryDone = true;
  try {
    require('../debug-log').dbgWarn('bash_failure_unacknowledged', {
      count: failures.length,
      samples: failures.slice(0, 3).map((f) => ({ cmd: f.cmd.slice(0, 120), exit: f.exitCode, reason: f.reason })),
    });
  } catch (err) { swallow(err); }
  const list = failures
    .slice(0, 5)
    .map((f, i) => `  ${i + 1}. \`${f.cmd.slice(0, 120)}\` — exit ${f.exitCode} (${f.reason})`)
    .join('\n');
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      `BASH FAILURE UNACKNOWLEDGED — ${failures.length} command(s) in this turn exited non-zero (or were killed/timed out), but your response does not mention the failure. You are reporting results as if every command succeeded.\n\n` +
      `Failed commands:\n${list}\n\n` +
      'Re-emit the response WITH the failure(s) acknowledged. Specifically: state which command failed and what that means for any conclusion you drew from its output. If the failed command was a benchmark or test that did not finish, you CANNOT report numbers from it — re-run it (fix the underlying error first) or omit those numbers.\n\n' +
      'DO NOT re-emit the same wording. Update the response to reflect what actually happened.\n' +
      '</system-reminder>',
  });
  return true;
}

// ── Guard 3: number-fabrication ────────────────────────────────────────────
// Catches measurements/percentages/ratios in the response that don't trace
// back to actual tool output. Detector has its own regex pre-gate (skip when
// no perf-style numbers in response).
async function checkNumberFabrication(opts: GuardOptions): Promise<boolean> {
  const { ctx, accumulatedText, chatMessages, buildAssistantMessage } = opts;
  if ((ctx as any).__numberFabricationRetryDone) return false;

  const toolOutputCorpus = chatMessages
    .filter((m: any) => m?.role === 'tool')
    .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
    .join('\n---\n')
    .slice(0, 12000);
  if (!toolOutputCorpus.trim()) return false;

  let fabricated: string | null = null;
  try {
    const { detectFabricatedNumbers } = require('./llm-classifier');
    fabricated = await detectFabricatedNumbers(accumulatedText, toolOutputCorpus);
  } catch (err) { swallow(err); }
  if (!fabricated) return false;

  (ctx as any).__numberFabricationRetryDone = true;
  try {
    require('../debug-log').dbgWarn('number_fabrication_detected', {
      detail: fabricated.slice(0, 400),
    });
  } catch (err) { swallow(err); }
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      'NUMBER FABRICATION DETECTED — your response includes quantitative claims that do not trace back to the real tool outputs collected this turn.\n\n' +
      `Specific issue:\n${fabricated}\n\n` +
      'You are NOT allowed to invent measurements, percentages, or ratios. Numbers must come from actual tool output (directly present, or derivable by simple arithmetic from values that ARE present). If a benchmark crashed or did not run to completion, you cannot report numbers from it — re-run it or omit those claims entirely.\n\n' +
      'Re-emit the response with ONLY numbers that are honestly traceable to the tool outputs above. If you do not have the data, say so.\n' +
      '</system-reminder>',
  });
  return true;
}

// ── Guard 4: search-claim refuted ──────────────────────────────────────────
// Detects identifier-level negative claims ("X has no callers", "X is unused")
// then runs a real grep across the project. If matches found, the claim is
// refuted — push a retry with the actual citations.
async function checkSearchClaimRefuted(opts: GuardOptions): Promise<boolean> {
  const { ctx, accumulatedText, chatMessages, buildAssistantMessage } = opts;
  if ((ctx as any).__searchClaimRetryDone) return false;

  let claims: Array<{ identifier: string; claimType: string; phrase: string }> = [];
  try {
    const { extractSearchClaims } = require('./llm-classifier');
    claims = await extractSearchClaims(accumulatedText);
  } catch (err) { swallow(err); }
  if (claims.length === 0) return false;

  const projectRoot = String(
    (ctx as any).activeProject?.localPath || ctx.cwd || process.cwd(),
  ).replace(/\/+$/, '');
  const { spawnSync } = require('child_process');
  type Hit = { identifier: string; phrase: string; matches: string[] };
  const refuted: Hit[] = [];

  for (const claim of claims) {
    const r = spawnSync(
      'grep',
      [
        '-rwn',
        '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
        '--include=*.mjs', '--include=*.cjs',
        '--exclude-dir=node_modules', '--exclude-dir=build', '--exclude-dir=dist', '--exclude-dir=.git',
        claim.identifier,
        projectRoot,
      ],
      { encoding: 'utf8', timeout: 8_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (r.status === 0 && r.stdout) {
      const lines = (r.stdout as string).split('\n').filter((l: string) => l.trim()).slice(0, 5);
      if (lines.length > 0) {
        refuted.push({ identifier: claim.identifier, phrase: claim.phrase, matches: lines });
      }
    }
  }

  if (refuted.length === 0) return false;

  (ctx as any).__searchClaimRetryDone = true;
  try {
    require('../debug-log').dbgWarn('search_claim_refuted', {
      count: refuted.length,
      samples: refuted.slice(0, 3).map((r) => ({ id: r.identifier, hit: r.matches[0]?.slice(0, 160) })),
    });
  } catch (err) { swallow(err); }
  const list = refuted
    .slice(0, 5)
    .map((r, i) =>
      `  ${i + 1}. claim: "${r.phrase.slice(0, 100)}" — but grep found ${r.matches.length}+ match(es):\n` +
      r.matches.slice(0, 3).map((m: string) => `       ${m}`).join('\n'),
    )
    .join('\n\n');
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      `SEARCH CLAIM REFUTED — your response asserts ${refuted.length} identifier(s) have no callers / are unused, but a real grep across \`${projectRoot}\` returned matches:\n\n${list}\n\n` +
      'Your previous search was too narrow (wrong scope, wrong path, wrong flags) or you reported stale results. Either:\n' +
      '  (a) Rerun the search with the broader scope this guard used, then update the claim with the actual call sites.\n' +
      '  (b) Narrow the claim with the matched citation (e.g. "X has no callers in module Y" if the matches are all elsewhere).\n\n' +
      'DO NOT re-emit the original wording. The grep above proves it wrong.\n' +
      '</system-reminder>',
  });
  return true;
}

// ── Guard 5: missing-test-execution (Gap 6) ────────────────────────────────
// When the prompt explicitly demanded tests/deliverables but the tool corpus
// has no matching evidence, force a retry with the specific items skipped.
// Expands [Pasted #N, ...] attachment refs so the pre-gate sees real content.
async function checkMissingTestExecution(opts: GuardOptions): Promise<boolean> {
  const { ctx, accumulatedText, chatMessages, buildAssistantMessage } = opts;
  if ((ctx as any).__missingTestRetryDone) return false;

  // Resolve the user prompt — expand [Pasted #N, ...] refs since long prompts
  // get externalised by extractAttachments and ctx.lastUserMessage holds only
  // the short ref like `[Pasted #5, 87 lines, 4500 chars]`.
  let userPrompt = String((ctx as any).lastUserMessage || '');
  try {
    const { readAttachmentContent } = require('../attachments');
    userPrompt = userPrompt.replace(/\[Pasted #(\d+)[^\]]*\]/g, (m: string, idStr: string) => {
      const id = parseInt(idStr, 10);
      const content = readAttachmentContent(id);
      return content || m;
    });
  } catch (err) { swallow(err); }
  if (userPrompt.length <= 60) return false;

  const toolOutputCorpus = chatMessages
    .filter((m: any) => m?.role === 'tool')
    .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
    .join('\n---\n')
    .slice(0, 12000);
  if (!toolOutputCorpus.trim()) return false;

  let missing: string | null = null;
  try {
    const { detectMissingTestExecution } = require('./llm-classifier');
    missing = await detectMissingTestExecution(userPrompt, toolOutputCorpus);
  } catch (err) { swallow(err); }
  if (!missing) return false;

  (ctx as any).__missingTestRetryDone = true;
  try {
    require('../debug-log').dbgWarn('missing_test_execution', {
      detail: missing.slice(0, 300),
      promptHead: userPrompt.slice(0, 120),
    });
  } catch (err) { swallow(err); }
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      'MISSING TEST EXECUTION — the user prompt explicitly demanded tests / deliverables that were NOT executed this turn.\n\n' +
      `Skipped:\n  ${missing}\n\n` +
      'You implemented the change but skipped the testing phase. The prompt is not satisfied until those tests have been RUN and their LITERAL output is present in this turn\'s tool history.\n\n' +
      'Run each missing test now via Bash. Paste the actual output (not paraphrased). Then re-emit the report with the test outputs included.\n\n' +
      'DO NOT declare the task done without the test outputs.\n' +
      '</system-reminder>',
  });
  return true;
}
