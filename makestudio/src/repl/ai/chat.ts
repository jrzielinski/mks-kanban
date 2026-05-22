import chalk from 'chalk';
import { ReplContext } from '../context';
import { getProvider } from './providers';
import { appendMessage } from '../sessions';
import { sanitizeMessagesForLLM } from './sanitize-messages';
import { compactMessages as compactMessagesByCount } from './chat-utils';
import {
  estimateContextPct,
  isAtBlockingLimit as _isAtBlockingLimit,
  checkTokenWarning,
} from './token-estimation';
import { autoCompact } from './auto-compact';
import { routeImageBlocks, prepareImagesForTurn } from './image-pipeline';
import { sanitizeHistoryForLLM, appendAtReferenceHint, reduceHistoryForToolLoop } from './history-sanitization';
import { applyAuditMode } from './audit-mode';
import { runStreamingPostTurn } from './post-turn';
import { runStreamingGuards } from './streaming-guards';
import { normalizeUsage, handleMaxTokensTruncation } from './streaming-response';
import { dispatchStreamingTool } from './tool-dispatch';
import { dispatchCliTool } from './tool-dispatch-cli';
import {
  runAwaySummaryIfNeeded,
  maybeShowClearHint,
  installTurnAlertTimer,
  healHistoryReasoning,
  buildChatMessagesFromHistory,
  resetTurnRetryFlags,
  extractTextAttachments,
  buildSystemPromptWithMemory,
  assembleEnrichedTools,
  runEagerMicroCompactPass,
  runChatPreflight,
  captureImageAttachments,
  persistUserMessage,
  resetPerTurnState,
  runUserPromptSubmitHook,
} from './chat-prelude';
import {
  handleStreamException,
  surfacePreambleNarration,
  recordLlmRequestStart,
  recordLlmRequestEnd,
  persistFinalAssistantMessage,
  surfaceEmptyTurnNoTextResponse,
  consumeProviderStream,
  logStreamResponseSummary,
  StreamAccumulators,
} from './streaming-iteration';
import {
  parseSendMessageResponse,
  healReasoningContentForRetry,
  runCliPostTurn,
} from './non-streaming-iteration';

import { swallow } from '../../utils/log';
// Re-export for backwards compatibility — chat.ts used to own
// isAtBlockingLimit; outside callers (router.ts) still import it from
// here. The implementation moved to token-estimation.ts but the public
// surface stays the same.
export const isAtBlockingLimit = _isAtBlockingLimit;

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const yellow = chalk.hex('#FBBF24');

// Streaming-path tool-loop ceiling. Two-stage:
//
//   - Soft reminder at SOFT_CONVERGENCE_THRESHOLD (75): inject a
//     system-reminder asking the model to converge or summarise. Same
//     pattern that already fires at 30 for early convergence; the 75
//     reminder is the "you've been going a while, are you still
//     making progress?" nudge BEFORE the hard cap.
//
//   - Hard cap at MAX_TOOL_LOOPS (200): absolute upper bound. Past
//     this point we abort the turn with hitToolLoopCap and surface a
//     warning to the user. This used to be 100, but real refactor
//     turns (porting a multi-file feature, end-to-end test fixup,
//     decomposition with verify) routinely hit 100-150 legitimately
//     and were getting cut off mid-implementation.
//
// History:
//   - Was 200 originally — a real session burned 14M tokens hitting it.
//   - Tightened to 40, then 60, then 100 (2026-05-02) chasing fanout.
//   - Bumped back to 200 (2026-05-04) because long refactor work was
//     hitting the cap on legitimate progress; the dedup REJECT,
//     auto-checkpoint at 30, and zero-result breaker (when enabled)
//     all catch pathological loops well before this ceiling now.
const MAX_TOOL_LOOPS = 200;
const SOFT_CONVERGENCE_THRESHOLD = 75;
const MAX_MESSAGES = 20;      // hard ceiling sent to DeepSeek per turn

/**
 * Hard cap on messages sent to the provider — wraps the generic
 * `compactMessagesByCount` from chat-utils with the chat-loop-local
 * MAX_MESSAGES ceiling. Used as the last line of defence when LLM-summary
 * autoCompact fails and the array is still huge.
 */
function compactMessages(messages: any[]): any[] {
  return compactMessagesByCount(messages, MAX_MESSAGES);
}


/**
 * Streaming variant of handleAIChat — uses SSE backend and progressively
 * updates a single TUI message as text arrives. Falls back to non-streaming
 * on error. Requires TUI bridge to be installed (otherwise falls back).
 */
export async function handleAIChatStream(inputRaw: string, ctx: ReplContext): Promise<void> {
  const { getTuiBridge } = require('../tui/bridge');
  const bridge = getTuiBridge();
  if (!bridge) {
    // No TUI — fall back to non-streaming
    return handleAIChat(inputRaw, ctx);
  }

  const pre = runChatPreflight(ctx, (text) => bridge.addMessage({ role: 'error', text }));
  if (!pre.provider) return;
  const provider = pre.provider;
  if (!provider.streamMessage) {
    return handleAIChat(inputRaw, ctx);
  }

  resetTurnRetryFlags(ctx);
  // Bump per-turn seq so tool_call events can be aggregated by turn in
  // /stats (top-N fanout turns). Snapshot 80 chars of the prompt so the
  // user can recognise which question caused the explosion.
  (ctx as any).__turnSeq = ((ctx as any).__turnSeq || 0) + 1;
  (ctx as any).__turnPromptSnippet = (inputRaw || '').slice(0, 80).replace(/\s+/g, ' ').trim();
  (ctx as any).__turnToolCount = 0;
  (ctx as any).__convergenceReminderFired = false;
  (ctx as any).__convergenceReminderFired2 = false;
  // Tutor reminders — diagnostic streak + turn-total + zero-text reset
  // per turn so each user prompt starts with a clean slate.
  (ctx as any).__diagnosticStreak = 0;
  (ctx as any).__diagnosticStreakHintFired = false;
  (ctx as any).__diagnosticTurnTotal = 0;
  (ctx as any).__diagnosticTurnHintFired = false;
  (ctx as any).__zeroTextStreak = 0;
  (ctx as any).__zeroTextHintFired = false;

  let input = extractTextAttachments(inputRaw, ctx, (n) => {
    bridge.addMessage({ role: 'info', text: `(${n} text attachment(s) extracted)` });
  });

  const captured = captureImageAttachments(input, (n) => {
    bridge.addMessage({ role: 'info', text: `(${n} image(s) attached)` });
  });
  input = captured.input;
  const pendingImageBlocks = captured.pendingImageBlocks;

  // Set lastUserMessage BEFORE building the system prompt so the
  // dynamic reminders (e.g. the [Pasted #N] → read_attachment hint)
  // can see the *current* turn's input. Otherwise persistUserMessage
  // sets it on line ~211 — too late, and the reminder fires one turn
  // late (or never, if the user follows up with a non-paste message).
  ctx.lastUserMessage = input;

  // Session-pinned constraints are now LLM-driven via the
  // `pin_session_constraint` tool — the model recognises a durable rule
  // in the user's message and calls the tool. No regex-based intent
  // extractor lives here anymore (the previous one was hard-coded
  // phrase-list classification, exactly what the project's CLAUDE.md
  // forbids). The pinned set is read straight into the system prompt
  // by formatConstraintsForPrompt below.

  const { systemPrompt, systemStatic, systemDynamic } = await buildSystemPromptWithMemory(ctx, inputRaw, provider);

  // Blocking limit gate: when we're within 3K tokens of the effective
  // context window, refuse to send another turn. The user gets a clear
  // message pointing to /compact. Prevents provider 413s and the retry
  // storm that follows when auto-compact is broken (circuit breaker
  // tripped). Port of Claude Code's MANUAL_COMPACT_BUFFER_TOKENS gate.
  if (isAtBlockingLimit(ctx, systemPrompt)) {
    bridge.addMessage({
      role: 'error',
      text: 'Context is nearly full — sending another turn would overflow the provider. Run /compact to summarise, or /clear to start fresh.',
    });
    try { require('../../utils/events').recordEvent('blocking_limit_hit', { turns: ctx.messages.length }); } catch (err) { swallow(err); }
    return;
  }

  const fullTools = await assembleEnrichedTools(ctx);
  // Pre-turn routing: narrow the tool surface to ~15 most relevant for
  // this prompt. Stops the model from reaching for git_log / find / wc
  // on a "como estamos" question. Pure function on top of fullTools —
  // settings.toolRoutingDisabled bypasses entirely.
  const enrichedTools = (() => {
    try {
      const { routeTools } = require('./tool-routing');
      return routeTools(inputRaw, fullTools);
    } catch { return fullTools; }
  })();

  runEagerMicroCompactPass(ctx, (msg) => {
    try { require('../tui/bridge').setTransientStatus(msg, 5000); } catch (err) { swallow(err); }
  });

  // Compact on threshold (message count or context %)
  const compactedStream = await autoCompact(ctx, provider, systemPrompt);
  if (compactedStream) {
    try { require('../tui/bridge').setTransientStatus('autoCompact: histórico antigo resumido', 5000); } catch (err) { swallow(err); }
  }

  await runAwaySummaryIfNeeded(ctx, bridge);

  // If we have image attachments this turn, check vision support from
  // providerInfo (set at login from /repl-chat/info → apiConfig.supportsVision).
  //
  // Priority:
  //   1. Primary model supports vision → send images directly.
  //   2. A vision-capable model exists (visionModel/visionApiKey) → use it to
  //      describe images, inject descriptions as text for the primary model.
  //   3. No vision at all → strip images, tell model it can't see them.
  let effectiveImageBlocks = pendingImageBlocks;
  let effectiveInput = input;

  effectiveInput = await applyAuditMode(input, effectiveInput, ctx);
  // Apply vision routing (describe via vision model or strip images)
  const routeResult = await routeImageBlocks(pendingImageBlocks, input, effectiveInput, ctx);
  effectiveInput = routeResult.effectiveInput;
  effectiveImageBlocks = routeResult.effectiveImageBlocks;

  const userMsg: any = effectiveImageBlocks.length > 0
    ? { role: 'user' as const, content: [{ type: 'text', text: effectiveInput }, ...effectiveImageBlocks] }
    : { role: 'user' as const, content: effectiveInput };
  (ctx as any).__visionStrippedThisTurn = routeResult.visionStripped;
  persistUserMessage(ctx, userMsg, input);

  maybeShowClearHint(ctx, input);
  installTurnAlertTimer(ctx);
  resetPerTurnState(ctx, input);

  // Install fresh AbortController BEFORE the UserPromptSubmit hook fires.
  // Previously this happened ~40 lines below, so the hook received the
  // PRIOR turn's controller — which, if the user aborted that turn (Esc Esc,
  // or main's AGENT_ABORT defense), was already in `aborted` state. The hook
  // detected the aborted signal and failed immediately with
  // "UserPromptSubmit hook failed: hook aborted (turn cancelled)" on the
  // very first request after a cancellation.
  const abortController = new AbortController();
  ctx.currentAbortController = abortController;

  await runUserPromptSubmitHook(ctx, input, (m) => {
    try { require('../tui/bridge').tuiLog?.(m, 'warn'); } catch (err) { swallow(err); }
  });

  healHistoryReasoning(ctx);
  let chatMessages: any[] = buildChatMessagesFromHistory(compactMessages(ctx.messages));
  chatMessages = sanitizeHistoryForLLM(chatMessages, ctx, input);
  // Replace bulky bodies of repeated Read calls with a placeholder pointer
  // to the most recent occurrence — every prior copy of the same file (same
  // path/offset/limit) re-pays input tokens on every turn even though only
  // the last one reflects the current file state. Pure transform, no
  // semantics change for the model.
  try {
    const { dedupRepeatedReads } = require('./dedup-history');
    chatMessages = dedupRepeatedReads(chatMessages);
  } catch (err) { swallow(err); }

  // Claude Code (src/query.ts:554) has no iteration cap — it loops while
  // the model keeps emitting tool_use, relying on the model to converge.
  // We keep a runaway-safety ceiling only: no sane turn needs 200 calls;
  // anything over that is almost certainly a model stuck in a loop.
  // Overridable in headless self-hosting mode: DarkFactory executor passes
  // `--max-turns N` and `runHeadless` stores it on ctx.__headlessMaxTurns.
  // Capped at the hard ceiling so a bogus CLI arg can't unlock 10_000 loops.
  // Same cap as the module-level MAX_TOOL_LOOPS used by the streaming path,
  // but headless can override via --max-turns (still bounded so a bogus
  // arg can't unlock thousands of loops).
  const HEADLESS_CAP = Math.max(1, Math.min(300, (ctx as any).__headlessMaxTurns || 200));
  const MAX_TOOL_LOOPS = HEADLESS_CAP;
  let finalText = '';
  // Reasoning-model chain-of-thought accumulated across ALL tool loops of
  // this turn. Persisted with the final assistant message so the next turn
  // can replay it (DeepSeek requirement, Claude extended-thinking
  // requirement). Signatures from multiple thinking blocks get '|'-joined.
  let finalThinking = '';
  let finalThinkingSignature = '';
  let hitToolLoopCap = false;
  // Tracks whether we already retried with minimal context after an empty
  // first response. Only one retry allowed per turn to avoid loops.
  let emptyRetryDone = false;

  // (AbortController was created earlier — before runUserPromptSubmitHook —
  // so the hook didn't receive a stale, possibly-aborted signal from the
  // previous turn. Same controller used here for the streaming loop.)

  // Start agent-summary periodic ticks (runs every 30s while turn is live).
  let agentSummaryHandle: { stop: () => void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    agentSummaryHandle = require('./agent-summary').startAgentSummarization(ctx);
  } catch (err) { swallow(err); }

  let loop = 0;
  // When a reasoning model (DeepSeek-R1) returns empty text after tool results,
  // we retry with tools disabled so it is forced to emit a text response.
  let forceNoTools = false;
  for (loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    try { require('../debug-log').dbgInfo('streaming_loop_iter', { loop, chatMessagesLen: chatMessages.length }); } catch (err) { swallow(err); }
    // Detect cache break
    ctx.detectCacheBreak(systemPrompt, enrichedTools, ctx.providerInfo?.model || '');
    try { require('../debug-log').dbgInfo('streaming_loop_after_cachebreak', { loop }); } catch (err) { swallow(err); }

    const msgId = bridge.addMessage({ role: 'assistant', text: '', streaming: true });
    try { require('../debug-log').dbgInfo('streaming_loop_after_addmsg', { loop, msgId }); } catch (err) { swallow(err); }
    const accumulators: StreamAccumulators = {
      accumulatedText: '',
      accumulatedThinking: '',
      accumulatedThinkingSignature: '',
      toolUses: [],
      lastUsage: null,
    };
    /** Build the assistant message we persist into the conversation
     *  history. Match the non-streaming (CLI) path behaviour: only
     *  include reasoning_content when there's actual thinking text.
     *  Sending `reasoning_content: ''` was triggering DeepSeek-flash to
     *  enter reasoning mode on the NEXT turn (the empty field signals
     *  "this conversation supports reasoning, please use it") — exactly
     *  the bug the user observed: same model, CLI fast, Electron slow.
     *  If a provider 400s because the field is absent, the existing
     *  reasoning-recovery in streaming-error-recovery.ts injects it. */
    const buildAssistantMessage = (text: string | null, toolCalls?: any[]) => {
      const msg: any = { role: 'assistant', content: text };
      if (accumulators.accumulatedThinking) {
        msg.reasoning_content = accumulators.accumulatedThinking;
      }
      if (accumulators.accumulatedThinkingSignature) msg.thinking_signature = accumulators.accumulatedThinkingSignature;
      if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
      return msg;
    };
    // Set by the stream's error handler when it injects a synthetic retry
    // message. If true, the outer loop MUST continue — otherwise the empty
    // toolUses would cause `break` below to abandon the turn entirely.
    let recoverAndRetry = false;
    // Hoisted across the try/catch so both paths can see it.
    let llmReqStartSeq: number | null = null;
    const apiStart = Date.now();
    try {
      llmReqStartSeq = recordLlmRequestStart(ctx, chatMessages, systemPrompt, loop);
      const loopMessages = reduceHistoryForToolLoop(chatMessages);
      const iterator = provider.streamMessage({
        system: systemPrompt,
        systemStatic,
        systemDynamic,
        messages: sanitizeMessagesForLLM(loopMessages, {
          stripReasoning: !!(ctx as any).__skipReasoningRoundTrip,
        }),
        tools: forceNoTools ? [] : enrichedTools,
        effort: ctx.effort,
        signal: abortController.signal,
      });
      const result = await consumeProviderStream({
        iterator, state: accumulators, bridge, msgId, ctx, chatMessages,
        enrichedTools, buildAssistantMessage,
      });
      if (result.fatal) return;
      if (result.recoverAndRetry) recoverAndRetry = true;
    } catch (err: any) {
      handleStreamException({
        err, ctx, chatMessages, bridge, msgId,
        accumulatedText: accumulators.accumulatedText, buildAssistantMessage,
        lastUsage: accumulators.lastUsage, apiStart, llmReqStartSeq, abortController,
      });
      return;
    }
    const { accumulatedText, accumulatedThinking, accumulatedThinkingSignature, toolUses, lastUsage } = accumulators;

    recordLlmRequestEnd(ctx, apiStart, accumulatedText, toolUses, loop, llmReqStartSeq);

    // DON'T finalize the bubble yet. Ink's <Static> prints assistant
    // messages with `streaming:false` ONCE to scrollback and never
    // un-prints them. If a guard below rejects this answer (number
    // fabrication, search-claim refuted, etc.), we need the option to
    // hide it before it goes permanent. Keep streaming:true through
    // the guard suite; finalize only after they've all approved.
    finalText += accumulatedText;
    if (accumulatedThinking) finalThinking += accumulatedThinking;
    if (accumulatedThinkingSignature) {
      finalThinkingSignature = finalThinkingSignature
        ? finalThinkingSignature + '|' + accumulatedThinkingSignature
        : accumulatedThinkingSignature;
    }

    await surfacePreambleNarration(toolUses, accumulatedText, bridge, msgId);

    // Capture usage
    // Historical note (bug found 2026-04-23): this used to read only the raw
    // OpenAI/Anthropic shape (snake_case: prompt_tokens, completion_tokens).
    // After porting to direct providers, the providers normalise their output
    // to camelCase (promptTokens, completionTokens) — so every key missed and
    // events.jsonl recorded 48M real tokens as 0. We now accept BOTH shapes,
    // preferring the normalised one.
    if (lastUsage) {
      ctx.addUsage(normalizeUsage(lastUsage));
      checkTokenWarning(ctx, systemPrompt);
    }

    logStreamResponseSummary(ctx, accumulatedText, toolUses, lastUsage, apiStart, chatMessages);

    if (handleMaxTokensTruncation({ ctx, lastUsage, accumulatedText, chatMessages, buildAssistantMessage, bridge })) {
      recoverAndRetry = true;
    }

    // Recovery path: the stream error handler already queued a synthetic
    // retry message. Keep the outer loop going even though toolUses is
    // empty — otherwise the turn would silently end.
    if (recoverAndRetry) continue;

    if (await runStreamingGuards({ ctx, accumulatedText, toolUses, chatMessages, buildAssistantMessage, bridge })) {
      // KEEP the bubble — user wants full transparency: anything that
      // reached the chat stays visible, including flawed/garbage
      // responses that triggered the guard. The retry shows up as a
      // new bubble below, and the warn banner explains what happened.
      bridge.updateMessage(msgId, { streaming: false });
      // Abort path (set by tool-markup guard after MAX retries): drop the
      // accumulated garbage from `finalText` so the LLM history doesn't
      // re-feed it next turn, then break the loop. The bubble stays
      // visible in the UI; the user sees the error banner explaining
      // why the turn aborted.
      if ((ctx as any).__toolMarkupAbort) {
        finalText = '';
        finalThinking = '';
        finalThinkingSignature = '';
        break;
      }
      // Retry path: drop this iteration's garbage from finalText so the
      // next iteration's clean output doesn't get prefixed with it on
      // persist. The guard already pushed buildAssistantMessage into
      // chatMessages so the model's reasoning chain stays intact for
      // the retry.
      finalText = finalText.slice(0, finalText.length - accumulatedText.length);
      continue;
    }

    // ── Anti-fabrication guards ──────────────────────────────────────
    // 5 detectors extracted to chat-guards.ts so the non-streaming path
    // (handleAIChat → runHeadless → DUM tasks) gets the same coverage:
    //   1. fabricated-output    — invented shell-log blocks
    //   2. bash-failure         — non-zero exit not acknowledged
    //   3. number-fabrication   — measurements not traceable
    //   4. search-claim refuted — "X has no callers" but grep finds matches
    //   5. missing-test         — prompt demanded tests but corpus has no evidence
    // Each is one-shot per turn (own __xxxRetryDone flag in ctx). On fire
    // it pushes the assistant turn + retry message and we continue the loop.
    if (toolUses.length === 0 && accumulatedText) {
      try {
        const { runAntiFabricationGuards } = require('./chat-guards');
        const fired = await runAntiFabricationGuards({
          ctx,
          accumulatedText,
          toolUses,
          chatMessages,
          buildAssistantMessage,
          surfaceInfo: (text: string) => bridge.addMessage({ role: 'info', text }),
          surfaceWarn: (text: string) => bridge.addMessage({ role: 'warn', text }),
        });
        if (fired) {
          // KEEP the bubble — user wants full transparency: the
          // flawed answer stays visible. The corrected version shows
          // up as a new bubble; the warn banner explains the retry.
          // The text stays in chatMessages too (buildAssistantMessage
          // was called inside the guard) so the model's reasoning
          // chain remains intact for the retry.
          bridge.updateMessage(msgId, { streaming: false });
          continue;
        }
      } catch (err) { swallow(err); }
    }

    // All guards approved (or didn't fire). Finalize the bubble.
    // Even when tools were called this round, KEEP the preamble text
    // visible — user explicitly wants no chat erasure. The transient
    // status line (set by surfacePreambleNarration) still mirrors
    // the preamble briefly for ambient awareness.
    bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });

    if (toolUses.length === 0) {
      // Auto-retry: if the first loop returned nothing (no text, no tools) AND
      // we haven't retried yet AND the history has more than 1 message, try once
      // more with only the last user message (stripped history). This handles the
      // "confused by accumulated history" case without the user having to /clear.
      // Empty-response retries below are silent on purpose — the user only
      // sees the eventual response (or the final "modelo não respondeu"
      // error if every retry is also empty). Surfacing every intermediate
      // retry as an info bubble was visual noise that just confused users.
      // Mechanism is still recorded via dbgWarn for debugging.
      const recordEmptyRetry = (variant: string): void => {
        try {
          require('../debug-log').dbgWarn('empty_response_retry', {
            variant,
            loop,
            histLen: chatMessages.length,
            model: ctx.providerInfo?.model,
          });
        } catch (err) { swallow(err); }
      };
      if (loop === 0 && !accumulatedText && !emptyRetryDone && chatMessages.length > 1) {
        emptyRetryDone = true;
        // Keep the last 5 messages for context (not just 1) so the model
        // knows which codebase/project it's working on. With only 1 message
        // the model calls list_projects blindly and then stalls on the result.
        chatMessages = chatMessages.slice(-5);
        recordEmptyRetry('trim_history');
        loop = -1; // will be incremented to 0
        continue;
      }
      // Fresh-turn empty response (loop=0, history.length === 1, no text, no
      // tools). Common with small/quantized models that get paralysed by a
      // 30-tool surface and return absolutely nothing on a simple greeting.
      // Retry once with tools DISABLED so the model is forced to emit text.
      if (loop === 0 && !accumulatedText && !emptyRetryDone) {
        emptyRetryDone = true;
        forceNoTools = true;
        recordEmptyRetry('no_tools_fresh');
        continue;
      }
      // After tool calls (loop > 0): reasoning models (DeepSeek-R1) sometimes
      // generate only thinking tokens after tool results and return empty final
      // text. Inject a follow-up user nudge AND disable tools for that iteration
      // so the model is forced to emit a text response instead of calling more tools.
      if (loop > 0 && !accumulatedText && !emptyRetryDone) {
        emptyRetryDone = true;
        forceNoTools = true;
        recordEmptyRetry('no_tools_post_tool');
        chatMessages.push({
          role: 'user',
          content: 'Based on the tool results above, please provide your response now.',
        });
        continue;
      }
      break;
    }
    if (loop === MAX_TOOL_LOOPS - 1) {
      // About to exit the for — mark so we surface the cap to the user.
      hitToolLoopCap = true;
    }

    // Build assistant message for next round
    const toolCalls = toolUses.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
    }));
    chatMessages.push(buildAssistantMessage(accumulatedText || null, toolCalls));

    // ── Tool execution: partition + concurrent/serial batches ────
    // Replaces the previous serial for-loop + parallel-prefetch
    // gambiarra. Now we partition toolUses into batches:
    //   - Consecutive concurrency-safe tools (Read/Glob/Grep/LSP/
    //     WebFetch/Bash-with-grep|find|ls|git-log) run via Promise.all
    //     with a cap of MAKESTUDIO_MAX_TOOL_CONCURRENCY (default 10).
    //   - Any not-safe tool (Edit/Write/MultiEdit/Bash-mutating/
    //     dispatch_agent) runs alone, serial — preserving the
    //     before/after ordering callers rely on.
    //
    // We loop through ALL batches unconditionally; aborting mid-batch
    // would leave assistant.tool_calls without matching tool_results
    // for the un-dispatched ids and the next request would 400. The
    // breakers (zero-result, diagnostic-streak, etc.) stash their
    // signals on ctx via __pendingSoftHint / __pendingHardStop and we
    // surface them AFTER every tool_result is in place.
    {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { partitionToolUses, getMaxConcurrency } = require('./tool-concurrency');
      const batches = partitionToolUses(toolUses);
      try { require('../debug-log').dbgInfo('batches_partitioned', { loop, count: batches.length, sizes: batches.map((b: any) => b.tools.length) }); } catch (err) { swallow(err); }
      const concurrency = getMaxConcurrency();
      for (const batch of batches) {
        try { require('../debug-log').dbgInfo('batch_iter_start', { loop, batchSize: batch.tools.length, concurrencySafe: batch.concurrencySafe }); } catch (err) { swallow(err); }
        if (batch.concurrencySafe && batch.tools.length > 1) {
          // Run with bounded concurrency. We slice the batch into
          // chunks of size `concurrency` — each chunk Promise.all'd —
          // so a 30-tool batch becomes 3 sequential 10-wide waves
          // instead of 30 simultaneous file handles.
          for (let i = 0; i < batch.tools.length; i += concurrency) {
            const chunk = batch.tools.slice(i, i + concurrency);
            await Promise.all(
              chunk.map((tool: any) =>
                dispatchStreamingTool({ tool, ctx, chatMessages, bridge }).catch((err: any) => {
                  // Single-tool failure must not abort the whole chunk —
                  // dispatcher already pushes an error tool_result, the
                  // round-trip protocol stays intact.
                  try { require('../debug-log').dbgError('parallel_tool_dispatch', { tool: tool.name, err: String(err?.message || err) }); } catch (err) { swallow(err); }
                }),
              ),
            );
          }
        } else {
          for (const tool of batch.tools) {
            try { require('../debug-log').dbgInfo('serial_tool_pre_await', { loop, tool: tool.name }); } catch (err) { swallow(err); }
            await dispatchStreamingTool({ tool, ctx, chatMessages, bridge });
            try { require('../debug-log').dbgInfo('serial_tool_post_await', { loop, tool: tool.name }); } catch (err) { swallow(err); }
          }
        }
        try { require('../debug-log').dbgInfo('batch_iter_end', { loop }); } catch (err) { swallow(err); }
      }
      try { require('../debug-log').dbgInfo('batches_outer_done', { loop }); } catch (err) { swallow(err); }
    }
    try { require('../debug-log').dbgInfo('streaming_loop_after_batches', { loop }); } catch (err) { swallow(err); }
    // Surface any deferred breaker / soft-hint AFTER every tool_result
    // is in place. The order is important: bridge error first (visible
    // in the TUI), then the system reminder injected as a `user` role
    // — at this point the chatMessages array already has all
    // matching tool messages, so injecting `user` here doesn't break
    // the OpenAI/DeepSeek tool_calls→tool_messages contract.
    {
      const pendingHard = (ctx as any).__pendingHardStop;
      if (pendingHard) {
        (ctx as any).__pendingHardStop = null;
        try {
          if (pendingHard.bridgeText) {
            bridge.addMessage({ role: 'error', text: pendingHard.bridgeText });
          }
          if (pendingHard.message) {
            chatMessages.push({ role: 'user', content: pendingHard.message });
          }
        } catch (err) { swallow(err); }
        return; // honour the deferred circuit-break
      }
      const pendingSoft = (ctx as any).__pendingSoftHint;
      if (pendingSoft) {
        (ctx as any).__pendingSoftHint = null;
        chatMessages.push({ role: 'user', content: pendingSoft });
      }
    }
    try { require('../debug-log').dbgInfo('streaming_loop_post_dispatch', { loop, chatMessagesLen: chatMessages.length }); } catch (err) { swallow(err); }
    // Enforce the per-turn ceiling — evicts older tool_results if the sum
    // went over the budget (200K chars by default). Claude Code behavior.
    try { require('./tool-limits').capTurnToolResults(chatMessages); } catch (err) { swallow(err); }
    try { require('../debug-log').dbgInfo('streaming_loop_post_cap', { loop }); } catch (err) { swallow(err); }

    // Mid-turn convergence reminder — when the model has burned ~30 tool
    // calls without producing a final text answer, inject a system-level
    // user message telling it to stop investigating and either commit
    // to one implementation or summarise. One-shot per turn (the
    // CONVERGENCE_REMINDER_THRESHOLD_HIT flag prevents re-firing on
    // every subsequent loop). Evidence-based: real session burned 100
    // tools without converging — half of those were post-30 churn.
    const toolCount = (ctx as any).__turnToolCount || 0;
    // First reminder at 30 — the model has explored enough; it should
    // be moving from "investigate" to "decide and act".
    if (toolCount >= 30 && !(ctx as any).__convergenceReminderFired) {
      (ctx as any).__convergenceReminderFired = true;
      chatMessages.push({
        role: 'user',
        content:
          '<system-reminder>\n' +
          `You've made ${toolCount} tool calls without producing a final answer. STOP investigating now.\n\n` +
          'Choose ONE of:\n' +
          '  (a) Commit to a specific implementation immediately — write the files / make the edits / run the build, then summarise what you did.\n' +
          '  (b) Stop and tell the user what you found so far + ask which direction to take.\n\n' +
          'Do NOT issue more exploratory tool calls (Read/Glob/Grep/git/find/ls) before answering. The information you have is enough to decide.\n' +
          '</system-reminder>',
      });
    }
    // Second, sterner reminder at SOFT_CONVERGENCE_THRESHOLD — last
    // chance to converge before the hard cap. Long refactors legitimately
    // need this much, but at this point the model should be writing,
    // not searching.
    if (toolCount >= SOFT_CONVERGENCE_THRESHOLD && !(ctx as any).__convergenceReminderFired2) {
      (ctx as any).__convergenceReminderFired2 = true;
      chatMessages.push({
        role: 'user',
        content:
          '<system-reminder>\n' +
          `${toolCount} tool calls in this turn — close to the ${MAX_TOOL_LOOPS}-call ceiling. ` +
          `Each remaining loop costs the user real money in tokens.\n\n` +
          `If you're STILL refining (legitimate refactor): continue but ONLY with concrete writes (Edit/Write/Bash for build), no more exploration.\n` +
          `If you're STUCK or unsure: stop NOW, summarise what you accomplished, and ask the user for direction.\n` +
          `</system-reminder>`,
      });
    }
  }

  // If we hit the cap without any text response, surface it. Otherwise
  // the user just sees a wall of tool calls with no assistant reply.
  if (hitToolLoopCap) {
    // Snapshot of what the model was doing right before it hit the cap —
    // most useful diagnostic when the model loops 40 calls without a
    // final answer. Lists the prompt that started the turn + the names
    // of the last 5 tool calls so you can see the pattern.
    const promptHint = (ctx as any).__turnPromptSnippet
      ? `prompt: "${(ctx as any).__turnPromptSnippet}"`
      : 'prompt: <unknown>';
    const lastTools: string[] = [];
    for (let i = chatMessages.length - 1; i >= 0 && lastTools.length < 5; i--) {
      const m: any = chatMessages[i];
      if (Array.isArray(m?.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = tc?.function?.name;
          if (n) lastTools.unshift(n);
          if (lastTools.length >= 5) break;
        }
      }
    }
    const lastToolsHint = lastTools.length > 0 ? `last tools: [${lastTools.join(', ')}]` : '';
    bridge.addMessage({
      role: 'error',
      text: `⚠ Tool-loop cap reached (${MAX_TOOL_LOOPS}). The model kept calling tools without returning a final answer.\n` +
        `   ${promptHint}\n` +
        (lastToolsHint ? `   ${lastToolsHint}\n` : '') +
        `   Likely cause: dispatch_agent failure-retry loop, explore overspend, or TodoWrite→Verify churn.\n` +
        `   Try rephrasing the question, or say "what did you find so far?" to force a summary.`,
    });
  } else if (!finalText) {
    surfaceEmptyTurnNoTextResponse(ctx, bridge);
  }

  if (finalText) {
    persistFinalAssistantMessage(ctx, finalText, finalThinking, finalThinkingSignature, loop);
    await runStreamingPostTurn(ctx, bridge, inputRaw, finalText);
  }
  if (agentSummaryHandle) agentSummaryHandle.stop();
  ctx.currentAbortController = null;
}


export async function handleAIChat(inputRaw: string, ctx: ReplContext): Promise<void> {
  resetTurnRetryFlags(ctx);
  (ctx as any).__turnSeq = ((ctx as any).__turnSeq || 0) + 1;
  (ctx as any).__turnPromptSnippet = (inputRaw || '').slice(0, 80).replace(/\s+/g, ' ').trim();
  (ctx as any).__turnToolCount = 0;
  (ctx as any).__convergenceReminderFired = false;
  (ctx as any).__convergenceReminderFired2 = false;
  // Tutor reminders — diagnostic streak + turn-total + zero-text reset
  // per turn so each user prompt starts with a clean slate.
  (ctx as any).__diagnosticStreak = 0;
  (ctx as any).__diagnosticStreakHintFired = false;
  (ctx as any).__diagnosticTurnTotal = 0;
  (ctx as any).__diagnosticTurnHintFired = false;
  (ctx as any).__zeroTextStreak = 0;
  (ctx as any).__zeroTextHintFired = false;

  // Install an AbortController on ctx so double-Esc in the TUI can cancel
  // this turn mid-stream without killing the REPL (same as streaming path).
  const abortController = new AbortController();
  ctx.currentAbortController = abortController;

  // Reset per-turn edit tracking + program cache. Without this the
  // CompilerHost cache + turnEdits Set accumulated forever on long
  // headless sessions (DUM tasks dispatched as cli=makestudio used
  // this path) — every Edit/Write/MultiEdit added a SourceFile to
  // the fileCache and never released, contributing to OOM.
  try { require('./post-edit-hooks').clearTurnEdits(ctx); } catch (err) { swallow(err); }
  try { ctx.readCache?.clear(); } catch (err) { swallow(err); }

  let input = extractTextAttachments(inputRaw, ctx, (n) => {
    console.log(`  ${dim(`(${n} anexo(s) extraido(s) — IA pode ler via read_attachment)`)}`);
  });
  const pre = runChatPreflight(ctx, (text) => console.log(`  ${yellow('!')} ${text}`));
  if (!pre.provider) return;
  const provider = pre.provider;
  if (!provider.available) {
    console.log(`  ${yellow('!')} Provider "${ctx.provider}" nao disponivel no backend.`);
    console.log(`  ${dim('Configure um ApiConfig default em')} ${cyan('https://www.zielinski.dev.br/api-configs')}`);
    return;
  }

  // See the streaming path above: set lastUserMessage BEFORE building
  // the system prompt so dynamic reminders see the current turn's input.
  ctx.lastUserMessage = input;

  const { systemPrompt, systemStatic: systemStatic2, systemDynamic: systemDynamic2 } = await buildSystemPromptWithMemory(ctx, inputRaw, provider);

  // Blocking limit gate — same as the streaming path. Refuse to send when
  // within 3K tokens of the provider's context limit.
  if (isAtBlockingLimit(ctx, systemPrompt)) {
    console.log(`  ${yellow('!')} Context is nearly full — sending another turn would overflow the provider.`);
    console.log(`  Run ${cyan('/compact')} to summarise, or ${cyan('/clear')} to start fresh.`);
    try { require('../../utils/events').recordEvent('blocking_limit_hit', { turns: ctx.messages.length }); } catch (err) { swallow(err); }
    return;
  }

  const fullTools = await assembleEnrichedTools(ctx);
  const enrichedTools = (() => {
    try {
      const { routeTools } = require('./tool-routing');
      return routeTools(inputRaw, fullTools);
    } catch { return fullTools; }
  })();

  runEagerMicroCompactPass(ctx, (msg) => console.log(`  ${dim(`(${msg})`)}`));

  // Auto-compact if conversation is getting long
  const compacted = await autoCompact(ctx, provider, systemPrompt);
  if (compacted) {
    console.log(`  ${dim('(historico antigo foi resumido automaticamente — contexto mantido limpo)')}`);
  }

  // Image attachments — process via shared helper (same logic as streaming path)
  const imgResult = await prepareImagesForTurn(input, ctx);
  const effectiveInput = imgResult.effectiveInput;
  const effectiveImageBlocks = imgResult.effectiveImageBlocks;

  // Add user message to history (may include image content blocks or vision descriptions)
  const userMsgNs: any = effectiveImageBlocks.length > 0
    ? { role: 'user' as const, content: [{ type: 'text', text: effectiveInput }, ...effectiveImageBlocks] }
    : { role: 'user' as const, content: effectiveInput };
  if ((ctx as any).__skillDisplayText) {
    userMsgNs.displayText = String((ctx as any).__skillDisplayText);
    delete (ctx as any).__skillDisplayText;
  }
  (ctx as any).__visionStrippedThisTurn = imgResult.visionStripped;
  ctx.messages.push(userMsgNs);
  appendMessage(ctx, userMsgNs);
  ctx.lastUserMessage = input;

  healHistoryReasoning(ctx);
  let chatMessages: any[] = buildChatMessagesFromHistory(compactMessages(ctx.messages));
  appendAtReferenceHint(chatMessages, input, ctx.cwd);
  try {
    const { dedupRepeatedReads } = require('./dedup-history');
    chatMessages = dedupRepeatedReads(chatMessages);
  } catch (err) { swallow(err); }

  let loops = 0;
  let finalText = '';
  let finalThinking = '';
  let finalThinkingSignature = '';

  while (loops < MAX_TOOL_LOOPS) {
    loops++;

    const apiStart = Date.now();
    try {
      // Detect cache break for logging in /cost
      const breakReason = ctx.detectCacheBreak(systemPrompt, enrichedTools, ctx.providerInfo?.model || '');
      const loopMessages = reduceHistoryForToolLoop(chatMessages);

      const response = await provider.sendMessage({
        system: systemPrompt,
        systemStatic: systemStatic2,
        systemDynamic: systemDynamic2,
        messages: sanitizeMessagesForLLM(loopMessages, {
          stripReasoning: !!(ctx as any).__skipReasoningRoundTrip,
        }),
        tools: enrichedTools,
        effort: ctx.effort,
        signal: abortController.signal,
      });
      ctx.recordApiMs(Date.now() - apiStart);

      if (response.usage) {
        ctx.addUsage(response.usage);
        checkTokenWarning(ctx, systemPrompt);
        // Track cache miss if no reads AND we had a break reason
        if (breakReason && !response.usage.cacheReads) {
          ctx.usage.cacheMisses++;
        }
      }

      const { textBlocks, toolUseBlocks, thinkingText, thinkingSignature } = parseSendMessageResponse(response);
      if (thinkingText) finalThinking += thinkingText;
      if (thinkingSignature) {
        finalThinkingSignature = finalThinkingSignature
          ? finalThinkingSignature + '|' + thinkingSignature
          : thinkingSignature;
      }

      // Print text with markdown rendering.
      // In headless mode, suppress — runHeadless emits the final assistant
      // text itself (from ctx.messages) so echoing here would duplicate the
      // whole answer in stdout (once from chat.ts, once from headless.ts).
      if (textBlocks.length > 0) {
        const text = textBlocks.join('');
        finalText += text;
        if (process.env.MAKESTUDIO_HEADLESS !== '1') {
          const { renderMarkdown, looksLikeMarkdown } = require('../markdown');
          const rendered = looksLikeMarkdown(text) ? renderMarkdown(text) : text;
          console.log(`${cyan('⏺')} ${rendered}`);
        }
      }

      // No tool calls — but before declaring the turn done, run the
      // anti-fabrication guards (same suite as handleAIChatStream). When
      // dispatched as `cli=makestudio` from the dark-factory orchestrator
      // (DUM tasks), this is the path that runs — without these guards
      // every fabrication failure mode we caught interactively would
      // re-emerge in headless. If a guard fires, push the retry messages
      // and continue the while-loop instead of breaking.
      if (toolUseBlocks.length === 0) {
        const thisText = textBlocks.join('');
        if (thisText) {
          try {
            const { runAntiFabricationGuards } = require('./chat-guards');
            const buildAssistantMsg = (text: string | null) => {
              const msg: any = { role: 'assistant', content: text };
              if (thinkingText) msg.reasoning_content = thinkingText;
              if (thinkingSignature) msg.thinking_signature = thinkingSignature;
              return msg;
            };
            const fired = await runAntiFabricationGuards({
              ctx,
              accumulatedText: thisText,
              toolUses: toolUseBlocks,
              chatMessages,
              buildAssistantMessage: buildAssistantMsg,
              surfaceInfo: (text: string) => console.log(dim(text)),
              surfaceWarn: (text: string) => console.log(yellow(text)),
            });
            if (fired) continue;
          } catch (err) { swallow(err); }
        }
        break;
      }

      // Build OpenAI-format assistant message with tool_calls
      // (backend expects this shape — maps to tool_use internally for Anthropic)
      const toolCalls = toolUseBlocks.map(tool => ({
        id: tool.id,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(tool.input || {}),
        },
      }));

      {
        const assistantMsg: any = {
          role: 'assistant',
          content: textBlocks.join('') || null,
          tool_calls: toolCalls,
        };
        if (thinkingText) assistantMsg.reasoning_content = thinkingText;
        if (thinkingSignature) assistantMsg.thinking_signature = thinkingSignature;
        chatMessages.push(assistantMsg);
      }

      // Execute each tool, auto-injecting active project context.
      for (const tool of toolUseBlocks) {
        await dispatchCliTool({ tool, ctx, chatMessages });
      }
      try { require('./tool-limits').capTurnToolResults(chatMessages); } catch (err) { swallow(err); }

    } catch (err: any) {
      ctx.recordApiMs(Date.now() - apiStart);
      const errMsg = String(err?.message || err);
      const recovery = healReasoningContentForRetry(errMsg, ctx, chatMessages);
      if (recovery === 'continue') continue;
      if (recovery === 'break') break;
      console.log(`  ${yellow('!')} Erro na IA: ${err.message || err}`);
      break;
    }
  }

  if (loops >= MAX_TOOL_LOOPS) {
    console.log(`  ${dim('(limite de chamadas de ferramentas atingido)')}`);
  }

  if (finalText) {
    runCliPostTurn(ctx, finalText, finalThinking, finalThinkingSignature);
  }

  ctx.currentAbortController = null;
  console.log();
}

/**
 * Manual compaction trigger — invoked by /compact slash command.
 * Forces summarization regardless of thresholds.
 */
export async function compactNow(ctx: ReplContext): Promise<{ compacted: boolean; before: number; after: number; pct: number }> {
  const before = ctx.messages.length;
  const systemPrompt = ctx.buildSystemPrompt();
  const pct = estimateContextPct(ctx, systemPrompt);
  if (before < 10) return { compacted: false, before, after: before, pct };
  const provider = getProvider(ctx.provider);
  const ok = await autoCompact(ctx, provider, systemPrompt, true);
  return { compacted: ok, before, after: ctx.messages.length, pct };
}
