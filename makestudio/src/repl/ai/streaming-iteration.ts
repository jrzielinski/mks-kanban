import { swallow } from '../../utils/log';
/**
 * Helpers tied to one iteration of the streaming tool-loop:
 *   - handleStreamException: the catch block that fires when the
 *     `for await` over provider.streamMessage(...) throws. Persists
 *     accumulated partial text so the next turn can continue from it.
 *   - surfacePreambleNarration: when the model emitted text BEFORE
 *     calling tools, mirror it to the transient status slot so the user
 *     sees something next to the spinner.
 *   - recordLlmRequestStart / recordLlmRequestEnd: trajectory bookkeeping.
 *   - persistFinalAssistantMessage: end-of-turn — push the assembled
 *     assistant message to ctx + the session, append journal, schedule
 *     title gen, record turn_end trajectory event.
 */

import { ReplContext } from '../context';
import { appendMessage } from '../sessions';
import { recoverStreamError } from './streaming-error-recovery';

/**
 * Mutable accumulators threaded through the chunk-consumption loop.
 * The consumer overwrites/appends in place so the outer handler can
 * read final values after `consumeProviderStream` returns.
 */
export interface StreamAccumulators {
  accumulatedText: string;
  accumulatedThinking: string;
  accumulatedThinkingSignature: string;
  toolUses: any[];
  lastUsage: any;
}

export interface ConsumeStreamArgs {
  iterator: AsyncIterable<any>;
  state: StreamAccumulators;
  bridge: { addMessage: (m: any) => any; updateMessage: (id: string, patch: any) => void };
  msgId: string;
  ctx: ReplContext;
  chatMessages: any[];
  enrichedTools: any[];
  buildAssistantMessage: (text: string | null, toolCalls?: any[]) => any;
}

export interface ConsumeStreamResult {
  recoverAndRetry: boolean;
  fatal: boolean;
}

/**
 * Drain a provider stream iterator. Routes each chunk type into the
 * accumulator state. On `chunk.type === 'error'` it delegates to
 * `recoverStreamError` and signals the outer loop to retry or bail.
 */
export async function consumeProviderStream(args: ConsumeStreamArgs): Promise<ConsumeStreamResult> {
  const { iterator, state, bridge, msgId, ctx, chatMessages, enrichedTools, buildAssistantMessage } = args;
  // Throttle bridge.updateMessage to ~30fps. A streaming response of
  // 5000 tokens in 5-token chunks fired updateMessage ~1000 times per
  // turn — each call rebuilt the full TUI message array, copied the
  // ENTIRE accumulated text into a new object, and triggered a React +
  // log-update repaint. With the kitt scanner running at 16fps in
  // parallel, that produced visible UI lag and serious memory churn.
  // Capping at 33ms drops the per-turn cost ~30x while staying smoother
  // than human eyes can follow. The final flush (streaming:false) runs
  // unconditionally in chat.ts after this function returns, so capped
  // mid-stream updates never lose tail text.
  let lastUpdateAt = 0;
  let firstThinkingAt = 0;
  const UPDATE_MIN_INTERVAL_MS = 33;
  // Thinking-only watchdog: DeepSeek-R1 / v4-flash sometimes burns 2-5
  // minutes streaming reasoning_content without ever emitting visible
  // text or tool calls — the user just sees "thinking..." with no
  // progress. Cap at 30s of pure thinking; once tripped, break the
  // for-await so chat.ts's empty-turn retry can kick in with tools=[]
  // and force a real text response. 30s is generous for legitimate
  // reasoning bursts; runaway loops trigger the retry well within
  // the user's patience window.
  const THINKING_ONLY_MAX_MS = 30_000;
  for await (const chunk of iterator) {
    // Trip the watchdog as early as possible inside the loop. If the
    // model produces only thinking_delta for too long, abort.
    if (
      firstThinkingAt > 0 &&
      !state.accumulatedText &&
      state.toolUses.length === 0 &&
      Date.now() - firstThinkingAt > THINKING_ONLY_MAX_MS
    ) {
      try { require('../debug-log').dbgWarn('thinking_only_runaway', {
        elapsedMs: Date.now() - firstThinkingAt,
        thinkingChars: state.accumulatedThinking.length,
      }); } catch (err) { swallow(err); }
      // Break the for-await loop — JS calls iterator.return() automatically,
      // which runs the provider generator's cleanup (closes the HTTP reader).
      // We do NOT abort ctx.currentAbortController: that signal is shared
      // with the rest of the turn, and aborting it would also poison the
      // forceNoTools retry that chat.ts is about to dispatch.
      break;
    }

    if (chunk.type === 'text_delta' && chunk.text) {
      state.accumulatedText += chunk.text;
      const now = Date.now();
      if (now - lastUpdateAt >= UPDATE_MIN_INTERVAL_MS) {
        bridge.updateMessage(msgId, { text: state.accumulatedText });
        lastUpdateAt = now;
      }
      // Rough live estimate: ~4 chars/token for English+code. Providers
      // don't stream incremental usage for most APIs, so this is what
      // the StatusLine shows while waiting. Real count (if reported in
      // the final `usage` chunk) replaces it via lastUsage on commit.
      try { require('../tui/bridge').setStreamTokens(Math.ceil(state.accumulatedText.length / 4)); } catch (err) { swallow(err); }
    } else if (chunk.type === 'thinking_delta' && chunk.thinking) {
      // Match CLI behaviour: swallow reasoning_content silently. We need
      // it for the next API turn round-trip (DeepSeek/Claude require the
      // field on prior assistant messages), so it goes into accumulator,
      // but we do NOT surface a "reasoning... Nk tokens" transient status
      // — that turned the streaming UI into a counter watching the model
      // think for minutes, which the user perceived as "stuck". The
      // pre-existing `thinking... Xs` busy label set by main.ts is enough
      // visual feedback that something is happening.
      state.accumulatedThinking += chunk.thinking;
      if (firstThinkingAt === 0) firstThinkingAt = Date.now();
    } else if (chunk.type === 'thinking_signature' && chunk.signature) {
      // Anthropic emits this once per thinking block. Multiple
      // thinking blocks in a single turn would arrive as separate
      // signatures; we concatenate with a delimiter so the full
      // payload can be replayed.
      state.accumulatedThinkingSignature = state.accumulatedThinkingSignature
        ? state.accumulatedThinkingSignature + '|' + chunk.signature
        : chunk.signature;
    } else if (chunk.type === 'tool_use') {
      if (!chunk.name) continue; // malformed — no tool name
      state.toolUses.push({ id: chunk.id, name: chunk.name, input: chunk.input });
    } else if (chunk.type === 'usage') {
      state.lastUsage = chunk.usage;
      // If provider streams running usage, prefer the real number.
      try {
        const real = chunk.usage?.completionTokens || chunk.usage?.completion_tokens || chunk.usage?.output_tokens;
        if (typeof real === 'number' && real > 0) require('../tui/bridge').setStreamTokens(real);
      } catch (err) { swallow(err); }
    } else if (chunk.type === 'error') {
      const errText: string = chunk.error || 'stream error';
      const outcome = await recoverStreamError({
        errText, ctx, chatMessages, enrichedTools,
        accumulatedText: state.accumulatedText,
        buildAssistantMessage, bridge, msgId,
      });
      if (outcome === 'recovered') return { recoverAndRetry: true, fatal: false };
      if (outcome === 'fatal') return { recoverAndRetry: false, fatal: true };
      bridge.updateMessage(msgId, { text: state.accumulatedText, streaming: false });
      bridge.addMessage({ role: 'error', text: errText });
      return { recoverAndRetry: false, fatal: true };
    }
  }
  return { recoverAndRetry: false, fatal: false };
}

/**
 * Diagnostic logging after a stream iteration completed (or returned
 * empty). Records dbgLlmResponse + an `empty_llm_response` warning when
 * the model produced neither text nor tool calls.
 */
export function logStreamResponseSummary(
  ctx: ReplContext,
  accumulatedText: string,
  toolUses: any[],
  lastUsage: any,
  apiStart: number,
  chatMessages: any[],
): void {
  try {
    const dbg = require('../debug-log');
    const tokOut = lastUsage?.completionTokens || lastUsage?.completion_tokens || lastUsage?.output_tokens || Math.ceil(accumulatedText.length / 4);
    const fr = lastUsage?.finish_reason || lastUsage?.stop_reason || 'unknown';
    dbg.dbgLlmResponse(ctx.providerInfo?.model || 'unknown', accumulatedText, tokOut, Date.now() - apiStart);
    if (!accumulatedText && toolUses.length === 0) {
      dbg.dbgWarn('empty_llm_response', {
        finish_reason: fr,
        msgCount: chatMessages.length,
        lastMsgRole: chatMessages[chatMessages.length - 1]?.role,
        usageRaw: JSON.stringify(lastUsage).slice(0, 200),
      });
    }
  } catch (err) { swallow(err); }
}

export interface StreamExceptionArgs {
  err: any;
  ctx: ReplContext;
  chatMessages: any[];
  bridge: { addMessage: (m: any) => any; updateMessage: (id: string, patch: any) => void };
  msgId: string;
  accumulatedText: string;
  buildAssistantMessage: (text: string | null, toolCalls?: any[]) => any;
  lastUsage: any;
  apiStart: number;
  llmReqStartSeq: number | null;
  abortController: AbortController;
}

/**
 * Catch-block handler for the streamMessage iteration. Persists meaningful
 * partial text (>40 chars of prose) so the next turn can continue from it
 * — without this, hitting Esc on a 3KB generated explanation loses
 * everything. Always returns 'fatal' (caller must return).
 */
export function handleStreamException(args: StreamExceptionArgs): 'fatal' {
  const { err, ctx, chatMessages, bridge, msgId, accumulatedText, buildAssistantMessage,
          lastUsage, apiStart, llmReqStartSeq, abortController } = args;
  const aborted = err?.name === 'AbortError' || abortController.signal.aborted;
  bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
  try {
    const dbg = require('../debug-log');
    const tokOut = lastUsage?.completionTokens || lastUsage?.completion_tokens || lastUsage?.output_tokens || Math.ceil(accumulatedText.length / 4);
    dbg.dbgLlmResponse(ctx.providerInfo?.model || 'unknown', accumulatedText, tokOut, Date.now() - apiStart);
  } catch (err) { swallow(err); }
  const hasPartial = accumulatedText.trim().length > 40;
  if (aborted) {
    if (hasPartial) {
      chatMessages.push(buildAssistantMessage(
        accumulatedText + '\n\n[response interrupted by user — partial content preserved]',
      ));
      try { require('../sessions').appendMessage?.(ctx, { role: 'assistant', content: accumulatedText }); } catch (err) { swallow(err); }
      bridge.addMessage({ role: 'info', text: `(request cancelled — preserved ${accumulatedText.length} chars so the next turn can continue)` });
    } else {
      bridge.addMessage({ role: 'info', text: '(request cancelled)' });
    }
  } else {
    if (hasPartial) {
      chatMessages.push(buildAssistantMessage(
        accumulatedText + '\n\n[response was cut off by stream error: ' + (err.message || 'unknown') + ']',
      ));
      try { require('../sessions').appendMessage?.(ctx, { role: 'assistant', content: accumulatedText }); } catch (err) { swallow(err); }
    }
    bridge.addMessage({ role: 'error', text: err.message || 'stream failed' });
  }
  try {
    const { recordCtxEvent } = require('../trajectory');
    recordCtxEvent(ctx, 'model', 'llm_request_error', {
      aborted,
      error: err?.message || String(err),
      ms: Date.now() - apiStart,
    }, llmReqStartSeq ?? undefined);
  } catch (err) { swallow(err); }
  ctx.recordApiMs(Date.now() - apiStart);
  ctx.currentAbortController = null;
  return 'fatal';
}

/**
 * Preamble narration handling: when the model emits text BEFORE calling
 * tools ("Vou verificar...", "Now I'll check..."), mirror it to the
 * transient status slot for ~6s so it shows up next to the spinner.
 * The text remains in chatMessages either way for API coherence.
 */
export async function surfacePreambleNarration(
  toolUses: any[],
  accumulatedText: string,
  bridge: { updateMessage: (id: string, patch: any) => void },
  msgId: string,
): Promise<void> {
  if (toolUses.length === 0 || !accumulatedText.trim()) return;
  try {
    const { setTransientStatus } = require('../tui/bridge');
    // Strip markdown so the status line stays single-line readable.
    const oneLine = accumulatedText
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[*_`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    if (oneLine) setTransientStatus?.(oneLine, 6000);
  } catch (err) { swallow(err); }
  // Mark the streaming bubble done so the spinner stops, but leave
  // the text visible in the body.
  bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Pre-call trajectory bookkeeping. Returns the seq number for the
 * llm_request_start event so the matching end/error event can link to
 * it. Also fires the dbgLlmRequest debug log + tail snapshot.
 */
export function recordLlmRequestStart(
  ctx: ReplContext,
  chatMessages: any[],
  systemPrompt: string,
  loop: number,
): number | null {
  try {
    const dbg = require('../debug-log');
    dbg.dbgLlmRequest(
      ctx.providerInfo?.model || 'unknown',
      chatMessages.length,
      systemPrompt.length,
    );
    const tail = chatMessages.slice(-3).map((m: any) => ({
      role: m.role,
      contentSnippet: (typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content)).slice(0, 120),
      hasToolCalls: Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    }));
    dbg.dbgInfo('llm_request_tail', { tail, hasImportedRules: !!((ctx as any).importedRules), loop });
  } catch (err) { swallow(err); }
  try {
    const { recordCtxEvent } = require('../trajectory');
    return recordCtxEvent(ctx, 'model', 'llm_request_start', {
      provider: ctx.providerInfo?.provider,
      model: ctx.providerInfo?.model,
      effort: ctx.effort,
      loop,
    });
  } catch { return null; }
}

/**
 * Post-iteration trajectory bookkeeping. Logs llm_request_end and the
 * elapsed ms via ctx.recordApiMs.
 */
export function recordLlmRequestEnd(
  ctx: ReplContext,
  apiStart: number,
  accumulatedText: string,
  toolUses: any[],
  loop: number,
  llmReqStartSeq: number | null,
): void {
  try {
    const { recordCtxEvent } = require('../trajectory');
    recordCtxEvent(ctx, 'model', 'llm_request_end', {
      ms: Date.now() - apiStart,
      textLen: accumulatedText.length,
      toolCount: toolUses.length,
      loop,
    }, llmReqStartSeq ?? undefined);
  } catch (err) { swallow(err); }
  ctx.recordApiMs(Date.now() - apiStart);

  // ── Stuck-thinking detector (textLen=0 + tool calls back-to-back) ──
  // Pattern observed 2026-05-04: model emits tool_uses but ZERO
  // explanatory prose for 65+ rounds. This means it's churning
  // without producing forward output — the model is "stuck thinking
  // out loud through tool_calls instead of finishing the task". We
  // count consecutive responses with textLen===0 AND toolCount>0;
  // after 3 in a row, push a system-reminder forcing it to either
  // commit or admit defeat.
  //
  // toolCount===0 + textLen===0 is a different bug (handled by
  // surfaceEmptyTurnNoTextResponse below).
  try {
    if (accumulatedText.length === 0 && toolUses.length > 0) {
      const streak = ((ctx as any).__zeroTextStreak || 0) + 1;
      (ctx as any).__zeroTextStreak = streak;
      if (streak >= 3 && !(ctx as any).__zeroTextHintFired) {
        (ctx as any).__zeroTextHintFired = true;
        const hint =
          '<system-reminder>' +
          `${streak} consecutive turns where you produced ZERO assistant text — only tool calls. ` +
          `That is the "stuck thinking through tools" pattern. The user has no idea what you're doing or why.\n\n` +
          `Pick ONE now: ` +
          `(a) Stop the tool chain, write a 1-2 sentence text response stating what you've concluded so far + your next concrete action; ` +
          `(b) Admit you can't solve this from current information and ask the user for direction. ` +
          `Do NOT issue more tool calls without text first.` +
          '</system-reminder>';
        // Inject into chat history so the next round-trip sees it.
        // Goes through the same `pendingSoftHint` path that other
        // breakers use, so the protocol order (tool_results first)
        // is preserved.
        if (!(ctx as any).__pendingSoftHint) {
          (ctx as any).__pendingSoftHint = hint;
        }
      }
    } else if (accumulatedText.length > 0) {
      // Any forward text resets the streak — even one sentence means
      // the model is communicating again.
      (ctx as any).__zeroTextStreak = 0;
      (ctx as any).__zeroTextHintFired = false;
    }
  } catch (err) { swallow(err); }
}

/**
 * End-of-turn assistant-message persistence. Writes the assembled text
 * (+ accumulated thinking) to ctx.messages and the session log, fires
 * the daily journal entry + session-title generator, and records the
 * turn_end trajectory event with token usage. Also clears the per-turn
 * elapsed alert.
 */
export function persistFinalAssistantMessage(
  ctx: ReplContext,
  finalText: string,
  finalThinking: string,
  finalThinkingSignature: string,
  loop: number,
): void {
  const asst: any = { role: 'assistant' as const, content: finalText };
  if (finalThinking) asst.reasoning_content = finalThinking;
  if (finalThinkingSignature) asst.thinking_signature = finalThinkingSignature;
  ctx.messages.push(asst);
  appendMessage(ctx, asst);
  try { require('../cassettes').recordTurn(ctx, asst); } catch (err) { swallow(err); }
  // Daily journal — append a one-line summary of this turn so future
  // sessions today can recall what happened without scanning the chat.
  try {
    const { appendJournalEntry } = require('../journal');
    const summary = (finalText || '').split(/\n\n/)[0].slice(0, 200);
    appendJournalEntry(String(ctx.lastUserMessage || ''), summary);
  } catch (err) { swallow(err); }
  // Session title — auto-generate after the first turn so /sessions
  // shows readable names instead of timestamps. Idempotent + silent
  // on failure; runs async, doesn't block the chat path.
  try {
    const { maybeGenerateSessionTitle } = require('./title-gen');
    maybeGenerateSessionTitle(ctx).catch(() => { /* */ });
  } catch (err) { swallow(err); }
  try {
    const { recordCtxEvent } = require('../trajectory');
    recordCtxEvent(ctx, 'model', 'turn_end', {
      textLen: (finalText || '').length,
      toolCalls: loop,
      usage: ctx.usage ? {
        promptTokens: ctx.usage.promptTokens,
        completionTokens: ctx.usage.completionTokens,
        cacheReads: ctx.usage.cacheReads,
      } : undefined,
    });
  } catch (err) { swallow(err); }
  try { (ctx as any).__clearTurnAlert?.(); } catch (err) { swallow(err); }
}

/**
 * Surface "model ended the turn with no text response" + roll back the
 * user message from ctx.messages so the next attempt doesn't snowball.
 * Without the rollback, each empty response leaves the unanswered user
 * message in the session, and subsequent turns see N consecutive
 * unanswered users which causes the model to keep returning empty
 * (feedback loop).
 */
export function surfaceEmptyTurnNoTextResponse(
  ctx: ReplContext,
  bridge: { addMessage: (m: any) => any },
): void {
  if (ctx.messages.length > 0 && ctx.messages[ctx.messages.length - 1].role === 'user') {
    ctx.messages.pop();
    // We can't remove from the session file (JSONL is append-only), but at
    // least the in-memory state is clean for this session. On next -c resume,
    // the justResumed tail-stripping handles the persisted orphan.
  }
  bridge.addMessage({
    role: 'error',
    text: '⚠ Model ended the turn with no text response. Try again or switch models via /model.',
  });
}
