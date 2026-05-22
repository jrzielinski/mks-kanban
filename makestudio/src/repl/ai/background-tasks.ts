import { ReplContext } from '../context';

import { swallow } from '../../utils/log';
/**
 * Fire-and-forget: ask the suggestion generator for a follow-up command
 * the user might want to type next. If one is produced, store it on the
 * bridge and notify the TUI so InputBox can offer it as a Tab-completion.
 */
export function schedulePromptSuggestion(ctx: ReplContext): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generateSuggestion } = require('./suggestion');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bridgeMod = require('../tui/bridge');
    const bridge = bridgeMod.getTuiBridge?.();
    // Fire and forget — the turn is already complete.
    Promise.resolve(generateSuggestion(ctx))
      .then((s: string | null) => {
        if (!s || !bridge) return;
        // Store on bridge so InputBox Tab can accept it.
        bridgeMod.setPendingSuggestion?.(s);
        bridge.addMessage({ role: 'info', text: `↳ suggestion: ${s}  (Tab to use)` });
      })
      .catch(() => { /* non-critical */ });
  } catch (err) { swallow(err); }
}

/**
 * Fire-and-forget: dispatch the memory extractor on a background tick if
 * the threshold gate (token delta + tool-call delta since the last run)
 * has fired. Persisted entries are announced through the bridge.
 */
export function scheduleMemoryExtraction(ctx: ReplContext): void {
  try {
    const { extractAndSaveMemories, shouldExtractMemory, markMemExtractionDone } = require('../extract-memories');
    // Threshold gate — skip extraction if not enough conversation has
    // accumulated since the last extraction. Port of Claude Code's
    // shouldExtractMemory() pattern (sessionMemory.ts:134-178).
    // Thresholds: totalTokens >= 10000 for init, +5000 tokens and/or +3
    // tool calls between subsequent extractions.
    if (!shouldExtractMemory(ctx)) return;
    // Fire and forget — don't block the UI on memory extraction.
    setImmediate(() => {
      extractAndSaveMemories(ctx).then((saved: any[]) => {
        // Update the snapshot so the next delta counts from here.
        markMemExtractionDone(ctx);
        // Memory saves used to surface as a chat info note ("memory: saved
        // N new entries — foo, bar"). Background bookkeeping is the wrong
        // thing to interrupt the conversation with — the user didn't ask
        // for it and the entry names mean nothing without context. Log to
        // the debug audit instead so /debug-tail still shows them.
        if (saved && saved.length > 0) {
          try {
            const dbg = require('../debug-log');
            dbg.dbgInfo('memory_extracted', {
              count: saved.length,
              names: saved.map((s: any) => s.name),
            });
          } catch (err) { swallow(err); }
        }
      }).catch(() => { /* silent */ });
    });
  } catch (err) { swallow(err); }
}
