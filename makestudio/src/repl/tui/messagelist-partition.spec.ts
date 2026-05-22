import { newPartitionState, partitionMessages } from './messagelist-partition';
import type { TuiMessage } from './types';

function msg(id: string, overrides: Partial<TuiMessage> = {}): TuiMessage {
  return {
    id,
    role: 'tool',
    text: '',
    timestamp: Date.now(),
    ...overrides,
  } as TuiMessage;
}

describe('partitionMessages — Ink Static dup guard', () => {
  it('routes streaming tool messages to live, never finalized', () => {
    const state = newPartitionState();
    const m = msg('t1', { role: 'tool', streaming: true });
    const r = partitionMessages([m], state, false);
    expect(r.live).toEqual([m]);
    expect(r.finalized).toEqual([]);
    expect(state.finalizedIds.has('t1')).toBe(false);
  });

  it('moves a tool from live to finalized when streaming flips false — appended exactly once', () => {
    const state = newPartitionState();
    const streaming = msg('t1', { role: 'tool', streaming: true });
    const r1 = partitionMessages([streaming], state, false);
    expect(r1.live).toEqual([streaming]);
    expect(r1.finalized).toEqual([]);

    // Bash close handler patches → new ref, same id, streaming:false.
    const finalized = msg('t1', { role: 'tool', streaming: false, toolDurationMs: 38 });
    const r2 = partitionMessages([finalized], state, false);
    expect(r2.live).toEqual([]);
    expect(r2.finalized).toEqual([finalized]);
    expect(state.finalizedIds.has('t1')).toBe(true);
  });

  it('keeps the FIRST finalized ref across re-renders even if a stray patch creates a new ref later — this is the dup-guard', () => {
    // Static's lagging index could otherwise re-slice from old position
    // and re-emit. We ensure the SAME object ref sits at index N every
    // time, so Ink's child-equality short-circuits the print.
    const state = newPartitionState();
    const first = msg('t1', { role: 'tool', streaming: false, toolDurationMs: 38 });
    partitionMessages([first], state, false);

    // Imagine some downstream system re-patched the same id (it shouldn't,
    // but if it did, dup must NOT come back).
    const second = msg('t1', { role: 'tool', streaming: false, toolDurationMs: 99 });
    const r = partitionMessages([second], state, false);
    expect(r.finalized).toHaveLength(1);
    expect(r.finalized[0]).toBe(first); // same reference, NOT `second`
  });

  it('handles 3 tools in succession — each appended exactly once', () => {
    // Mirrors the user-reported pattern: wc → grep export → grep interface,
    // where the larger outputs were appearing 2-3x in scrollback.
    const state = newPartitionState();
    const t1 = msg('t1', { role: 'tool', streaming: false });
    const t2 = msg('t2', { role: 'tool', streaming: false });
    const t3 = msg('t3', { role: 'tool', streaming: false });

    // Each setMessages frame might trigger an extra render — call partition
    // multiple times with the same input to simulate that. The cache
    // must not grow.
    partitionMessages([t1], state, false);
    partitionMessages([t1], state, false);
    partitionMessages([t1, t2], state, false);
    partitionMessages([t1, t2], state, false);
    partitionMessages([t1, t2], state, false);
    partitionMessages([t1, t2, t3], state, false);
    const r = partitionMessages([t1, t2, t3], state, false);
    expect(r.finalized).toEqual([t1, t2, t3]);
  });

  it('drops empty assistant placeholders (model went straight to a tool call)', () => {
    const state = newPartitionState();
    const empty = msg('a1', { role: 'assistant', text: '', streaming: false });
    const r = partitionMessages([empty], state, false);
    expect(r.live).toEqual([]);
    expect(r.finalized).toEqual([]);
  });

  it('hides streaming assistants in non-verbose mode but exposes them in verbose', () => {
    const state1 = newPartitionState();
    const stream = msg('a1', { role: 'assistant', text: 'partial', streaming: true });
    expect(partitionMessages([stream], state1, false).live).toEqual([]);

    const state2 = newPartitionState();
    expect(partitionMessages([stream], state2, true).live).toEqual([stream]);
  });

  it('resets cached finalized state when /clear empties messages', () => {
    const state = newPartitionState();
    const t1 = msg('t1', { role: 'tool', streaming: false });
    partitionMessages([t1], state, false);
    expect(state.finalized).toHaveLength(1);

    // /clear → setMessages([])
    const r = partitionMessages([], state, false);
    expect(r.finalized).toEqual([]);
    expect(state.finalized).toEqual([]);
    expect(state.finalizedIds.size).toBe(0);

    // Subsequent fresh messages re-populate from zero.
    const t2 = msg('t2', { role: 'tool', streaming: false });
    const r2 = partitionMessages([t2], state, false);
    expect(r2.finalized).toEqual([t2]);
  });

  it('returns a FRESH array ref each call but stable item refs inside — the contract Ink 3 <Static> needs to actually emit', () => {
    // Static memoizes `items.slice(index)` on `[items, index]`. If we
    // hand it the SAME array ref every render, the memo never busts and
    // nothing is ever emitted to scrollback (this regression shipped
    // briefly: "agora nao imprime nada porra"). Solution: copy the
    // outer array each call — the items inside still come from the
    // append-only buffer, so each index is reference-identical to the
    // previous render and Ink's diff skips already-printed cards.
    const state = newPartitionState();
    const t1 = msg('t1', { role: 'tool', streaming: false });
    const r1 = partitionMessages([t1], state, false);
    const r2 = partitionMessages([t1], state, false);
    expect(r1.finalized).not.toBe(r2.finalized);          // fresh outer ref
    expect(r1.finalized[0]).toBe(r2.finalized[0]);        // same inner ref
  });
});
