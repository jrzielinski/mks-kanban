import {
  estimateContextPct,
  COMPACT_MAX_CONSECUTIVE_FAILURES,
} from './token-estimation';
import { microCompact, apiMicroCompact, compactToolUseInputs, compactOldImages } from './micro-compact';
import {
  messagesToTranscript,
  formatCompactSummary,
  extractText,
} from './chat-utils';

import { swallow } from '../../utils/log';
// Tightened 2026-04-27: previous 15 messages / 75% ctx allowed sessions
// to grow until OOM at 4GB heap (now 8GB but still a real failure mode).
// 10 messages / 60% ctx triggers compact much earlier — turns are smaller
// but RSS stays bounded.
export const COMPACT_THRESHOLD = 10; // compact when above this, keep last 10
export const COMPACT_CTX_PCT = 60;   // also compact when ctx usage crosses this %

// 9-section detailed summary
// preserves all user messages verbatim to prevent drift on continuation.
// Claude Code's NO_TOOLS_PREAMBLE pattern (services/compact/prompt.ts:19-26).
// Weak phrasing ("do not call tools") leaks ~2.79% of the time on Sonnet+; the
// model tries a tool on its one-shot turn and the whole compaction is wasted.
// Strong phrasing names the CONSEQUENCE so the model knows what happens when
// it disobeys. Prepended AND appended so it survives mid-prompt attention drift.
export const COMPACT_NO_TOOLS_PREAMBLE =
  `CRITICAL — SINGLE TURN, NO TOOLS:
You have EXACTLY ONE turn to produce a summary. Tool calls will be REJECTED and
will waste your only turn — the caller's context will be lost entirely if that
happens. Do not call Read, Grep, Bash, or any other tool. Respond with plain
text (the <analysis> + <summary> wrapping described below) and nothing else.
`;
export const COMPACT_NO_TOOLS_TRAILER =
  `\n\nREMINDER: Output ONLY the <analysis>...</analysis><summary>...</summary> text. Tool calls will be rejected.`;
export const COMPACT_SYSTEM_PROMPT = `${COMPACT_NO_TOOLS_PREAMBLE}
You are a conversation summarizer. Be thorough and precise.`;

export const COMPACT_USER_TEMPLATE = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and previous actions.
This summary must be thorough in capturing technical details, code patterns, and architectural decisions essential for continuing work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags. In your analysis:

1. Chronologically analyze each message and section. For each section identify:
   - The user's explicit requests and intents
   - The assistant's approach to address them
   - Key decisions, technical concepts and code patterns
   - Specific details: file names, full code snippets, function signatures, file edits
   - Errors encountered and how they were fixed
   - Specific user feedback, especially corrections
2. Double-check for technical accuracy and completeness.

Your summary must include these sections inside <summary> tags:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable
4. Errors and fixes: List all errors and how they were fixed, plus user feedback
5. Problem Solving: Document problems solved and any ongoing troubleshooting
6. All user messages: List ALL user messages that are not tool results — critical for understanding feedback and intent changes
7. Pending Tasks: Outline any pending tasks explicitly requested
8. Current Work: Describe precisely what was being worked on immediately before this summary. Include file names and code snippets
9. Optional Next Step: List the next step directly in line with the most recent user request. Include direct quotes from the most recent conversation showing where you left off

Output format:
<analysis>
[your thought process]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name]
     - [Summary of importance]
     - [Code snippet]

4. Errors and fixes:
   - [Error]:
     - [Fix]
     - [User feedback if any]

5. Problem Solving:
   [Description]

6. All user messages:
   - [User message verbatim]
   - [...]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description]

9. Optional Next Step:
   [Next step with direct quote from recent conversation]
</summary>

Conversation to summarize:

{TRANSCRIPT}`;

/**
 * Single-turn summary call. Emits the COMPACT_SYSTEM_PROMPT + transcript
 * as a one-shot user message and reads the assistant's reply as the
 * summary text. Used by autoCompact and by /compact.
 */
export async function compactSimple(msgs: any[], provider: any, ctx?: any): Promise<string> {
  // Output-token reserve: the compact summary can be long (9 structured
  // sections, entire user-message history verbatim). If the active config
  // has a small maxTokens (e.g. 1000 for a low-effort chat config), the
  // summary will be truncated and we lose the tail of the conversation.
  //
  // Claude Code reserves ~20K output tokens from the context window for
  // the summary. We don't speak tokens here directly (the backend maps
  // effort → maxTokens based on the model's ai_models.maxTokens row), so
  // the next best lever is to force `effort: 'max'` which the backend
  // maps to the full modelMax (see applyEffort in repl-chat.controller.ts:62).
  //
  // This is still bounded by the model's hard ceiling — not unlimited.

  // Compact via the FAST tier when available — summarising a transcript is
  // a fan-out task perfectly suited to a cheaper/faster model (Groq Llama,
  // DeepSeek-V3, etc). Cuts compact cost by 10-30× without measurably
  // degrading the summary because the structure is rigid (9 fixed sections)
  // and the input is mostly literal copy. Falls back to the active provider
  // when no fast tier is configured.
  // Always TRY codex (fast tier). getProvider('codex') falls back to the
  // default provider internally if no fast config exists. If the call
  // itself errors (rare — bad fast model, quota exhausted), we retry on
  // the original provider. Compact never blocks a turn — fail-soft.
  let activeProvider = provider;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getProvider } = require('./providers');
    activeProvider = getProvider('codex') || provider;
  } catch (err) { swallow(err); }

  const sendCompact = async (p: any) => p.sendMessage({
    system: COMPACT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content:
        COMPACT_USER_TEMPLATE.replace('{TRANSCRIPT}', messagesToTranscript(msgs)) +
        COMPACT_NO_TOOLS_TRAILER,
    }],
    // Empty tools array + explicit no-tools instruction in system + trailer.
    // Belt + suspenders — Anthropic models occasionally ignore empty tools[]
    // if conversation history contains tool_use blocks.
    tools: [],
    effort: 'max',
  });

  let response: any;
  try {
    response = await sendCompact(activeProvider);
  } catch (err) {
    // Fast tier failed — retry once on the original (default) provider so
    // /compact never returns blank because Groq was overloaded.
    if (activeProvider !== provider) {
      try { require('../debug-log').dbgWarn?.('compact_fast_failed_fallback', { error: String((err as any)?.message || err) }); } catch (err) { swallow(err); }
      response = await sendCompact(provider);
    } else {
      throw err;
    }
  }
  // Charge the compact call to ctx so /stats can attribute it correctly.
  // Compact calls are infrequent but burn one full prompt + a long output
  // — easy to mistake for a user turn in token logs without this label.
  try {
    const usage = (response as any).usage;
    if (ctx && usage) ctx.addUsage(usage, 'compact');
  } catch (err) { swallow(err); }
  return extractText(response) || '(empty summary)';
}

/**
 * Auto-compaction with strategy selection:
 *  - "topic": group by topic (file paths, project names), summarize per topic
 *  - "timeline": chronological compression — drop low-value middle messages
 *  - "simple": single summary (fallback)
 * Strategy is chosen based on message content heuristics.
 */
export async function autoCompact(
  ctx: any,
  provider: any,
  systemPrompt: string,
  force: boolean = false,
): Promise<boolean> {
  // Circuit breaker tripped — stay disabled until the session ends (or the
  // user manually resets via /compact-reset, if we add one later).
  if (ctx.autoCompactDisabled) return false;

  const pct = estimateContextPct(ctx, systemPrompt);
  const shouldCompact = force
    || ctx.messages.length >= COMPACT_THRESHOLD
    || pct >= COMPACT_CTX_PCT;
  if (!shouldCompact) return false;

  // PreCompact hook — user can e.g. dump ctx.messages to disk before we
  // collapse history, or emit a notification. Non-blocking.
  try {
    const { runHooks } = require('../hooks');
    await runHooks('PreCompact', { projectPath: ctx.cwd, currentAbortController: ctx.currentAbortController });
  } catch (err) { swallow(err); }

  // microCompact first — cheap, no LLM call, preserves conversation
  // structure (role, tool_use metadata, cache prefix). If it frees enough
  // context that we're back below the threshold, we skip the expensive
  // text summary entirely. Only triggers on non-forced auto-compact —
  // `force=true` (explicit /compact) still always runs the full summary.
  if (!force) {
    // Two-pass cheap compaction:
    //   1. snipOldTurns — collapse old USER-turn groups into a single stub
    //      message. Aggressive but preserves the structure the model needs.
    //   2. microCompact — truncate tool_result bodies in what remains.
    // Each step checks context pct and short-circuits if already under the
    // threshold. Claude Code's autoCompactIfNeeded runs compact
    // (LLM-summarised) and snip in sequence; our snip is non-LLM (no cost)
    // so we always try it first.
    try {
      const { snipOldTurns } = require('./compact-grouping');
      // Checkpoint BEFORE snip fires — snip is the most aggressive cheap
      // pass, so if it produces garbage we want a clean restore point.
      try { require('./compact-checkpoints').snapshotBeforeCompact(ctx, 'snip'); } catch (err) { swallow(err); }
      const snipRes = snipOldTurns(ctx.messages);
      if (snipRes.replaced > 0) {
        ctx.messages = snipRes.newMessages;
        const pctAfter = estimateContextPct(ctx, systemPrompt);
        try {
          require('../tui/bridge').setTransientStatus(
            `snipCompact: ${snipRes.replaced} turn(s), ${Math.max(0, snipRes.freedChars).toLocaleString()} chars (${pct.toFixed(0)}% → ${pctAfter.toFixed(0)}% ctx)`,
            6000,
          );
        } catch (err) { swallow(err); }
        try { require('../../utils/events').recordEvent('snip_compact', { replaced: snipRes.replaced, freedChars: Math.max(0, snipRes.freedChars), pctBefore: pct, pctAfter }); } catch (err) { swallow(err); }
        if (pctAfter < COMPACT_CTX_PCT && ctx.messages.length < COMPACT_THRESHOLD) {
          ctx.compactFailures = 0;
          return true;
        }
      }
    } catch (err) { swallow(err); }

    // Strip old image attachments — base64 screenshots are 1MB+ each
    // and re-paid every turn forever. After the model used them, the
    // placeholder is fine; user can re-paste if needed.
    try {
      const imgTrim = compactOldImages(ctx);
      if (imgTrim.stripped > 0) {
        const pctAfter = estimateContextPct(ctx, systemPrompt);
        try {
          require('../tui/bridge').setTransientStatus(
            `compactOldImages: ${imgTrim.stripped} attachment(s), ${imgTrim.freedChars.toLocaleString()} chars (~${pctAfter.toFixed(0)}% ctx)`,
            6000,
          );
        } catch (err) { swallow(err); }
        if (pctAfter < COMPACT_CTX_PCT && ctx.messages.length < COMPACT_THRESHOLD) {
          ctx.compactFailures = 0;
          return true;
        }
      }
    } catch (err) { swallow(err); }

    // Trim large `new_string` payloads from old Edit/Write tool_use blocks
    // BEFORE the result-side compaction. The model only needs to remember
    // it edited file X — the verbatim content is on disk now. Cheap pass,
    // ~5–20K tokens freed in sessions with multiple Edits.
    try {
      const inputTrim = compactToolUseInputs(ctx);
      if (inputTrim.trimmed > 0) {
        const pctAfter = estimateContextPct(ctx, systemPrompt);
        try {
          require('../tui/bridge').setTransientStatus(
            `compactToolUseInputs: ${inputTrim.trimmed} write tool_use(s), ${inputTrim.freedChars.toLocaleString()} chars (~${pctAfter.toFixed(0)}% ctx)`,
            6000,
          );
        } catch (err) { swallow(err); }
        if (pctAfter < COMPACT_CTX_PCT && ctx.messages.length < COMPACT_THRESHOLD) {
          ctx.compactFailures = 0;
          return true;
        }
      }
    } catch (err) { swallow(err); }

    // Smart prune — stubs duplicate Read/Glob/Grep tool_results,
    // old failures, and verbose-bash middles. Runs BEFORE microCompact
    // so its char savings reduce what microCompact has to truncate.
    // Cheap (one pass through messages) and idempotent.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { incrementalPrune } = require('./smart-prune');
      const sp = incrementalPrune(ctx);
      if (sp.duplicatesStubbed + sp.failuresStubbed + sp.bashTrimmed > 0) {
        require('../tui/bridge').setTransientStatus(
          `smartPrune: ${sp.duplicatesStubbed} dup, ${sp.failuresStubbed} fail, ${sp.bashTrimmed} bash, ${sp.freedChars.toLocaleString()} chars`,
          6000,
        );
      }
    } catch (err) { swallow(err); }

    const micro = microCompact(ctx);
    if (micro.trimmed > 0) {
      const pctAfter = estimateContextPct(ctx, systemPrompt);
      try {
        require('../tui/bridge').setTransientStatus(
          `microCompact: ${micro.trimmed} tool_result(s), ${micro.freedChars.toLocaleString()} chars (${pct.toFixed(0)}% → ${pctAfter.toFixed(0)}% ctx)`,
          6000,
        );
      } catch (err) { swallow(err); }
      if (pctAfter < COMPACT_CTX_PCT && ctx.messages.length < COMPACT_THRESHOLD) {
        ctx.compactFailures = 0;
        return true;
      }
    }

    // apiMicroCompact — second pass, token-aware. Catches JSON/code blobs
    // that packed more tokens than their char count suggested. Runs only
    // when we still haven't dropped below the threshold after the char pass.
    // Wrap apiMicroCompact in try/catch — walking ctx.messages on an
    // unusual shape (e.g. OpenAI/Anthropic content-array mix) could throw.
    // An unhandled throw here used to abort the user's turn via the
    // chat.ts outer try. Now it's non-blocking — log the failure, proceed
    // to the full-summary compact path.
    let apiMicro: { trimmed: number; freedTokens: number } = { trimmed: 0, freedTokens: 0 };
    try { apiMicro = apiMicroCompact(ctx); }
    catch (e: any) {
      try { require('../../utils/events').recordEvent('apimicrocompact_fail', { message: String(e?.message || e).slice(0, 200) }); } catch (err) { swallow(err); }
    }
    if (apiMicro.trimmed > 0) {
      const pctAfter = estimateContextPct(ctx, systemPrompt);
      try {
        const { tuiLog } = require('../tui/bridge');
        tuiLog(
          `apiMicroCompact trimmed ${apiMicro.trimmed} dense tool_result(s), freed ~${apiMicro.freedTokens.toLocaleString()} tokens (~${pctAfter.toFixed(0)}% ctx).`,
          'info',
        );
      } catch (err) { swallow(err); }
      if (pctAfter < COMPACT_CTX_PCT && ctx.messages.length < COMPACT_THRESHOLD) {
        ctx.compactFailures = 0;
        return true;
      }
    }
  }

  // Incremental compact: if msgs[0] already IS a previous compact summary
  // (the marker phrase below was injected by an earlier autoCompact call),
  // we don't need to re-summarise it — that's pure waste because a summary
  // OF a summary loses fidelity AND costs the full prompt again. Slice it
  // out, summarise only the new mid-section, then re-stitch:
  //   [prev_summary, new_summary, ...toKeep]
  const PRIOR_SUMMARY_MARKER = 'This session is being continued from a previous conversation';
  const hasPriorSummary =
    ctx.messages.length > 0
    && typeof ctx.messages[0]?.content === 'string'
    && ctx.messages[0].content.startsWith(PRIOR_SUMMARY_MARKER);
  const priorSummary = hasPriorSummary ? ctx.messages[0] : null;
  const startIdx = hasPriorSummary ? 1 : 0;

  // Keep last 15, compress earlier (excluding prior summary if present)
  const toCompress = ctx.messages.slice(startIdx, ctx.messages.length - 15);
  const toKeep = ctx.messages.slice(ctx.messages.length - 15);
  if (toCompress.length < 5) return false;

  // Pre-flight: if ALL messages are plain text (no tool_result blocks) the
  // cheap passes above did nothing. Count text-only messages — if we're still
  // above threshold after the cheap passes, the LLM summary is our only hope.
  // But if the circuit breaker has already tripped once (compactFailures > 0),
  // don't burn another LLM call that will likely fail too. Apply hard truncation
  // now so the next turn sees at most 15 messages instead of 30+.
  if ((ctx.compactFailures || 0) > 0 && ctx.messages.length > toKeep.length) {
    const _beforeHt = ctx.messages.length;
    ctx.messages = toKeep;
    try { require('../sessions').rewriteSession(ctx, ctx.messages); } catch (err) { swallow(err); }
    try {
      const { tuiLog } = require('../tui/bridge');
      tuiLog(
        `compact-LLM previously failed — applying hard truncation upfront, kept last ${toKeep.length} messages.`,
        'warn',
      );
    } catch (err) { swallow(err); }
    try { require('../../utils/events').recordEvent('hard_truncation', { reason: 'circuit_breaker', kept: toKeep.length, dropped: _beforeHt - toKeep.length }); } catch (err) { swallow(err); }
    try {
      const { recordCtxEvent } = require('../trajectory');
      recordCtxEvent(ctx, 'runtime', 'compaction', {
        kind: 'hard_truncation',
        reason: 'circuit_breaker',
        kept: toKeep.length,
        dropped: _beforeHt - toKeep.length,
      });
    } catch (err) { swallow(err); }
    return true;
  }

  // Checkpoint BEFORE the full-summary compact — this is the most
  // destructive pass (replaces nearly-all history with one summary blob),
  // so /undo-compact here is especially valuable.
  try { require('./compact-checkpoints').snapshotBeforeCompact(ctx, 'summary'); } catch (err) { swallow(err); }

  try {
    const raw = await compactSimple(toCompress, provider, ctx);
    const formatted = formatCompactSummary(raw);
    const _beforeCompact = ctx.messages.length;
    if (priorSummary) {
      // Keep the original prior summary intact and append a NEW summary
      // covering only what happened since. Two summaries side-by-side is
      // fine — the model reads them as a chronological brief.
      ctx.messages = [
        priorSummary,
        {
          role: 'user',
          content: `Continuation summary — covers messages since the prior summary above:\n\n${formatted}\n\nRecent messages are preserved verbatim below.`,
        },
        ...toKeep,
      ];
    } else {
      ctx.messages = [
        {
          role: 'user',
          content: `${PRIOR_SUMMARY_MARKER} that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formatted}\n\nRecent messages are preserved verbatim below.`,
        },
        ...toKeep,
      ];
    }
    ctx.compactFailures = 0; // reset on success
    // Persist the compacted message list to disk. Without this rewrite,
    // the session jsonl still has every pre-compact message — the next
    // process boot replays them all and the user reports "compact didn't
    // stick". Atomic via tmp+rename inside rewriteSession.
    try {
      const { rewriteSession } = require('../sessions');
      rewriteSession(ctx, ctx.messages);
    } catch (err: any) {
      try {
        const { tuiLog } = require('../tui/bridge');
        tuiLog(`compact rewrite failed (${String(err?.message || err)}) — in-memory state OK, but session file may be stale on restart.`, 'warn');
      } catch (err) { swallow(err); }
    }
    try {
      const { recordCtxEvent } = require('../trajectory');
      recordCtxEvent(ctx, 'runtime', 'compaction', {
        kind: 'llm_summary',
        before: _beforeCompact,
        after: ctx.messages.length,
      });
    } catch (err) { swallow(err); }
    // Flag a dynamic system-reminder for the NEXT turn so the model knows
    // the history has been summarised. Consumed on first read by
    // context.buildSystemReminders (one-shot).
    (ctx as any).__justCompacted = true;
    try {
      const { runHooks } = require('../hooks');
      await runHooks('PostCompact', { projectPath: ctx.cwd, currentAbortController: ctx.currentAbortController });
    } catch (err) { swallow(err); }
    return true;
  } catch {
    ctx.compactFailures = (ctx.compactFailures || 0) + 1;

    // Hard-truncation fallback: LLM summarization failed (provider returned
    // empty or threw). We still MUST trim the history — sending 30+ messages
    // to DeepSeek causes it to return an empty stream, and the user gets
    // "Model ended the turn with no text response" on EVERY turn.
    // Keeping the last 15 messages is worse than a proper summary but far
    // better than a broken session. We log it so the user knows context was lost.
    if (ctx.messages.length > toKeep.length) {
      const _beforeHt = ctx.messages.length;
      ctx.messages = toKeep;
      try { require('../sessions').rewriteSession(ctx, ctx.messages); } catch (err) { swallow(err); }
      try {
        const { tuiLog } = require('../tui/bridge');
        tuiLog(
          `compact-LLM failed — hard truncation applied, kept last ${toKeep.length} messages. Some earlier context was dropped.`,
          'warn',
        );
        try { require('../../utils/events').recordEvent('hard_truncation', { reason: 'compact_llm_fail', kept: toKeep.length, dropped: _beforeHt - toKeep.length }); } catch (err) { swallow(err); }
        try {
          const { recordCtxEvent } = require('../trajectory');
          recordCtxEvent(ctx, 'runtime', 'compaction', {
            kind: 'hard_truncation',
            reason: 'compact_llm_fail',
            kept: toKeep.length,
            dropped: _beforeHt - toKeep.length,
          });
        } catch (err) { swallow(err); }
      } catch (err) { swallow(err); }
    }

    if (ctx.compactFailures >= COMPACT_MAX_CONSECUTIVE_FAILURES) {
      ctx.autoCompactDisabled = true;
      try {
        const { tuiLog } = require('../tui/bridge');
        tuiLog(
          `auto-compact disabled after ${ctx.compactFailures} consecutive failures. ` +
          `Context will not be auto-compressed for the rest of this session. ` +
          `Use /compact manually, or /clear, to free context.`,
          'warn',
        );
      } catch (err) { swallow(err); }
    }
    return false;
  }
}
