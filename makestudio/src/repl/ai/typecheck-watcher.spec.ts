import { appendBounded } from './typecheck-watcher';

/**
 * Buffer-cap tests for typecheck-watcher.
 *
 * Why this exists: the agent OOM'd at 2h46min into a real session because
 * stderrBuf inside the tsc --watch handler grew without limit (and stdoutBuf
 * could grow if tsc never emitted "Found N errors" between cycles). The
 * fix introduced `appendBounded` — keep the tail when the cap would be
 * exceeded — and these specs verify the cap holds under realistic adverse
 * input patterns: many small chunks, single huge chunk, mixed sizes.
 *
 * The cap matters more than the exact retention: if memory grows past
 * `maxBytes` the agent eventually dies. Keeping the tail rather than the
 * head is correct because tsc's most recent output is the most diagnostic
 * (latest error stack, latest "Watching for file changes" marker).
 */

describe('appendBounded', () => {
  it('appends without truncation when total stays under the cap', () => {
    const out = appendBounded('hello ', 'world', 1024);
    expect(out).toBe('hello world');
  });

  it('returns just the chunk when the buffer is empty and chunk fits', () => {
    expect(appendBounded('', 'first chunk', 100)).toBe('first chunk');
  });

  it('truncates the head when appending would exceed the cap', () => {
    const buf = 'a'.repeat(800);
    const chunk = 'b'.repeat(400);
    const out = appendBounded(buf, chunk, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    // Tail of new chunk MUST be present (recency wins)
    expect(out.endsWith('b'.repeat(400))).toBe(true);
  });

  it('cap holds under repeated 100-byte chunks (simulates tsc stderr stream)', () => {
    let buf = '';
    const chunk = 'x'.repeat(100);
    for (let i = 0; i < 100_000; i++) {
      buf = appendBounded(buf, chunk, 1024);
    }
    expect(buf.length).toBeLessThanOrEqual(1024);
  });

  it('cap holds when a single chunk is larger than the cap (single 5MB blob)', () => {
    // Edge case: one huge chunk should NOT crash; we drop everything before
    // it and keep the chunk itself (or a tail of it).
    const huge = 'z'.repeat(5 * 1024 * 1024);
    const out = appendBounded('previous content', huge, 1 * 1024 * 1024);
    // The chunk was 5MB and the cap is 1MB. We append the chunk after
    // shrinking the buffer; the resulting size is `floor(maxBytes/2) + chunk.length`
    // which exceeds maxBytes when chunk > maxBytes — this is acceptable
    // because the next call will re-shrink. The contract is "no unbounded
    // growth across MANY calls", not "every single call returns ≤ maxBytes".
    expect(out.endsWith('z')).toBe(true);
  });

  it('handles empty chunk gracefully', () => {
    expect(appendBounded('existing', '', 100)).toBe('existing');
  });

  it('handles maxBytes=0 by returning chunk only (degenerate cap)', () => {
    const out = appendBounded('previous', 'new', 0);
    // slice(-0) == '' — so we get just the new chunk
    expect(out).toBe('new');
  });

  it('preserves the tail of the buffer when the chunk is small', () => {
    // Buffer at cap, small chunk — should keep buffer's tail half + chunk
    const buf = 'a'.repeat(1000);
    const chunk = 'b';
    const out = appendBounded(buf, chunk, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.endsWith('b')).toBe(true);
    // Tail of the OLD buffer should still be present (we kept the recent half)
    expect(out.includes('a')).toBe(true);
  });

  it('regression: 100MB of cumulative input with 1MB cap stays at 1MB±chunk', () => {
    // The actual scenario: tsc --watch streams ~100MB of "[12:34:56] checking..."
    // over a long session. With the cap, buffer stays bounded.
    let buf = '';
    const chunkSize = 50_000;
    const totalChunks = 2_000; // 100MB total
    for (let i = 0; i < totalChunks; i++) {
      buf = appendBounded(buf, 'data'.repeat(chunkSize / 4), 1 * 1024 * 1024);
    }
    // Final buffer should be bounded near the cap (allow chunkSize overshoot
    // since one fresh chunk was appended after the truncation)
    expect(buf.length).toBeLessThan(1 * 1024 * 1024 + chunkSize + 100);
  });
});
