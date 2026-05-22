/**
 * messagelist-partition.ts — pure split of TUI messages into live + finalized.
 *
 * Lives in its own .ts file so the test runner (Jest, .ts only) can import
 * it without depending on the React/Ink-aware MessageList.tsx.
 *
 * The append-only `finalized` cache is what defeats the Ink 3 <Static>
 * scrollback-dup. Ink's Static component tracks emitted-up-to-here via
 * an internal `index` updated in useLayoutEffect on `[items.length]`. When
 * setMessages fires multiple times in quick succession (bash output chunks
 * → finalize → next bash starts), each render passes Static a NEW items
 * array reference; Static's useMemo (`items.slice(index)`) recomputes from
 * the OLD index and re-emits already-printed cards. We sidestep this by
 * keeping our own append-only buffer and handing Static the same item
 * references at the same indices every render — so even if its index
 * lags, the items it slices are reference-identical to what it last
 * printed and Ink's diff machinery skips the write.
 */

import type { TuiMessage } from './types';

export interface PartitionState {
  /** Append-only finalized buffer. Item refs at index i never change. */
  finalized: TuiMessage[];
  /** IDs already in `finalized` — O(1) dedup on subsequent renders. */
  finalizedIds: Set<string>;
}

export function newPartitionState(): PartitionState {
  return { finalized: [], finalizedIds: new Set() };
}

/**
 * Walk `messages` and partition into live (streaming, repaint each frame)
 * and finalized (one-shot scrollback). Mutates `state` to append new
 * finalized items. Detects /clear (messages==[] but state non-empty) and
 * wipes state in place.
 *
 * Returns a FRESH array reference for `finalized` each call so Ink 3's
 * <Static> useMemo (`items.slice(index)`, deps `[items, index]`) sees the
 * change and recomputes the slice — handing the same array ref would
 * memo-skip and Static would never emit anything to scrollback. The item
 * refs INSIDE the array are stable (taken from append-only state), which
 * is what defeats the lagging-index re-emission race.
 */
export function partitionMessages(
  messages: TuiMessage[],
  state: PartitionState,
  verbose: boolean,
): { live: TuiMessage[]; finalized: TuiMessage[] } {
  // /clear: setMessages([]) was called, drop the cached history.
  if (messages.length === 0 && state.finalized.length > 0) {
    state.finalized.length = 0;
    state.finalizedIds.clear();
  }
  const live: TuiMessage[] = [];
  for (const m of messages) {
    // Empty assistant placeholder (model went straight to a tool call):
    // skip entirely, even an empty fragment in <Static> prints a blank line.
    if (m.role === 'assistant' && !m.streaming && !m.text.trim()) continue;
    // Streaming bash card: visible in dynamic area until proc.close finalises it.
    if (m.role === 'tool' && m.streaming) {
      live.push(m);
      continue;
    }
    // Streaming assistant text: dropped from both arrays in non-verbose mode
    // because Ink's cursor-up erasure leaks streamed rows into scrollback when
    // they exceed the dynamic area's row budget.
    if (m.streaming) {
      if (verbose) live.push(m);
      continue;
    }
    // Finalized: append once, by id. The first reference seen for an id
    // wins — later refs (e.g. a stray post-finalize updateMessage that
    // patched a field) are intentionally ignored, otherwise the dedup
    // would break and Static would re-emit.
    if (!state.finalizedIds.has(m.id)) {
      state.finalizedIds.add(m.id);
      state.finalized.push(m);
    }
  }
  // Fresh array ref, stable item refs — see comment on the function.
  return { live, finalized: state.finalized.slice() };
}
