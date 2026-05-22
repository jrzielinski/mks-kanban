import { swallow } from '../../utils/log';
/**
 * Helpers tied to one iteration of the non-streaming (handleAIChat) tool
 * loop. Mirrors the streaming-iteration module but adapted for the
 * provider.sendMessage(...) / response.content shape and the CLI surface
 * (console.log instead of bridge.addMessage).
 */
import chalk from 'chalk';
import { ReplContext } from '../context';
import { appendMessage } from '../sessions';
import { scheduleMemoryExtraction } from './background-tasks';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');

export interface ParsedResponse {
  textBlocks: string[];
  toolUseBlocks: any[];
  thinkingText: string;
  thinkingSignature: string;
}

/**
 * Walk an Anthropic-style sendMessage response and split its content
 * blocks into (text, tool_use, thinking). Concatenates thinking across
 * blocks in the order the provider emitted them — matters for Anthropic
 * signature verification on replay.
 */
export function parseSendMessageResponse(response: any): ParsedResponse {
  const textBlocks: string[] = [];
  const toolUseBlocks: any[] = [];
  let thinkingText = '';
  let thinkingSignature = '';
  for (const block of response.content || []) {
    if (block.type === 'thinking') {
      if (block.thinking) thinkingText += block.thinking;
      if (block.signature) {
        thinkingSignature = thinkingSignature
          ? thinkingSignature + '|' + block.signature
          : block.signature;
      }
    } else if (block.type === 'text' && block.text) {
      textBlocks.push(block.text);
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push(block);
    }
  }
  return { textBlocks, toolUseBlocks, thinkingText, thinkingSignature };
}

/**
 * Reasoning-mode round-trip rejection recovery. DeepSeek (v4-flash,
 * reasoner) and other thinking-mode providers 400 with:
 *   "The reasoning_content in the thinking mode must be passed back to
 *    the API."
 * Same heal-and-retry approach as the streaming path: walk every
 * assistant message and inject `reasoning_content: ''` (empty string)
 * where the field is missing.
 *
 * Returns 'continue' to keep the outer loop going, 'break' to abort.
 * Returns 'unhandled' if the error doesn't match the reasoning pattern.
 */
export function healReasoningContentForRetry(
  errMsg: string,
  ctx: ReplContext,
  chatMessages: any[],
): 'continue' | 'break' | 'unhandled' {
  if (!/reasoning_content|thinking[_\s-]?content|reasoning.*thinking.?mode|thinking.?mode.*reasoning/i.test(errMsg)) {
    return 'unhandled';
  }
  // Two opposite failure modes share the same keyword: provider REQUIRES the
  // field (DeepSeek/Qwen) vs REJECTS it (Groq). Detect "unsupported" to
  // pick the right healing direction. See streaming-error-recovery.ts for
  // the streaming-path version of this same fix.
  const isUnsupported = /unsupported|not\s+allowed|not\s+supported|unknown\s+property|extra\s+field/i.test(errMsg);
  try {
    const dbg = require('../debug-log');
    dbg.dbgWarn('reasoning_recovery_3c_fired_nonstream', {
      tries: (ctx as any).__reasoningRecoveryTries || 0,
      mode: isUnsupported ? 'strip' : 'inject',
      errMsg: errMsg.slice(0, 600),
    });
  } catch (err) { swallow(err); }
  const triesSoFar = (ctx as any).__reasoningRecoveryTries || 0;
  if (triesSoFar >= 1) {
    if (ctx.messages.length > 0 && ctx.messages[ctx.messages.length - 1]?.role === 'user') {
      ctx.messages.pop();
    }
    console.log(`  ${yellow('!')} Provider rejeitou reasoning_content mesmo depois do healing. Resposta do provider: ${errMsg.slice(0, 200)}`);
    return 'break';
  }
  (ctx as any).__reasoningRecoveryTries = triesSoFar + 1;
  const healMessage = (m: any): void => {
    if (!m || typeof m !== 'object' || m.role !== 'assistant') return;
    if (isUnsupported) {
      delete m.reasoning_content;
      delete m.thinking_signature;
    } else {
      if (typeof m.reasoning_content !== 'string') m.reasoning_content = '';
    }
  };
  for (const m of chatMessages) healMessage(m);
  for (const m of ctx.messages || []) healMessage(m);
  return 'continue';
}

/**
 * Non-streaming post-turn pipeline. Persists the assembled assistant
 * message to ctx + the session, fires the typecheck-watcher,
 * memory extractor, journal entry, and title generator.
 */
export function runCliPostTurn(
  ctx: ReplContext,
  finalText: string,
  finalThinking: string,
  finalThinkingSignature: string,
): void {
  const asstNs: any = { role: 'assistant' as const, content: finalText };
  if (finalThinking) asstNs.reasoning_content = finalThinking;
  if (finalThinkingSignature) asstNs.thinking_signature = finalThinkingSignature;
  ctx.messages.push(asstNs);
  appendMessage(ctx, asstNs);

  // Camada B — cross-file type-check snapshot (non-streaming path).
  try {
    const w = require('./typecheck-watcher');
    const result = w.captureTurnErrors(ctx);
    const msg = w.formatTurnErrors(result, ctx.cwd);
    if (msg) console.log(yellow(msg));
  } catch (err) { swallow(err); }

  scheduleMemoryExtraction(ctx);
  try {
    const { appendJournalEntry } = require('../journal');
    const summary = finalText.split(/\n\n/)[0].slice(0, 200);
    appendJournalEntry(String(ctx.lastUserMessage || ''), summary);
  } catch (err) { swallow(err); }
  try {
    const { maybeGenerateSessionTitle } = require('./title-gen');
    maybeGenerateSessionTitle(ctx).catch(() => { /* */ });
  } catch (err) { swallow(err); }
}
