import { bashCardOutputRows } from './bash-card-render';

describe('bashCardOutputRows — Bash card scrollback-dup guard', () => {
  it('returns null while streaming so Ink dynamic area stays at 1 row', () => {
    const r = bashCardOutputRows({
      isStreaming: true,
      liveLines: ['line a', 'line b', 'line c'],
      totalLiveLines: 50,
    });
    // Streaming MUST suppress output rows. If this returns non-null,
    // Ink's dynamic area renders the tail; when those rows scroll past
    // the viewport they leak into scrollback, then <Static> prints the
    // finalized card *again* with the same tail → "$ ls -la" twice.
    expect(r).toBeNull();
  });

  it('returns the full tail + moreCount once streaming has ended', () => {
    const r = bashCardOutputRows({
      isStreaming: false,
      liveLines: ['a', 'b'],
      totalLiveLines: 2,
    });
    expect(r).toEqual({ lines: ['a', 'b'], moreCount: 0 });
  });

  it('computes moreCount from totalLiveLines when tail was truncated', () => {
    // Bash sends only the last N lines via liveLines; totalLiveLines is
    // the original count. The card surfaces `+N more lines` so the
    // operator knows there was more output than what's shown.
    const r = bashCardOutputRows({
      isStreaming: false,
      liveLines: ['line 41', 'line 42', 'line 43'],
      totalLiveLines: 43,
    });
    expect(r).toEqual({ lines: ['line 41', 'line 42', 'line 43'], moreCount: 40 });
  });

  it('falls back to liveLines.length when totalLiveLines is undefined', () => {
    // Path executed when bash.ts emits a result without totalLiveLines
    // (older message shape). Without the fallback, `total - lines.length`
    // would be NaN and the +N counter would render as `+NaN more lines`.
    const r = bashCardOutputRows({
      isStreaming: false,
      liveLines: ['only one'],
      totalLiveLines: undefined,
    });
    expect(r).toEqual({ lines: ['only one'], moreCount: 0 });
  });

  it('clamps moreCount at zero so a stale total never renders negative', () => {
    // Defensive: if liveLines somehow exceeds totalLiveLines (bug or
    // race), the card must NOT render `+-3 more lines`.
    const r = bashCardOutputRows({
      isStreaming: false,
      liveLines: ['a', 'b', 'c', 'd', 'e'],
      totalLiveLines: 2,
    });
    expect(r).toEqual({ lines: ['a', 'b', 'c', 'd', 'e'], moreCount: 0 });
  });

  it('handles undefined liveLines defensively (renders empty body)', () => {
    const r = bashCardOutputRows({
      isStreaming: false,
      liveLines: undefined,
      totalLiveLines: 0,
    });
    expect(r).toEqual({ lines: [], moreCount: 0 });
  });
});
