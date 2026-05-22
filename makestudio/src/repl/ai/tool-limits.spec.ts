import {
  clipToolResult,
  capTurnToolResults,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from './tool-limits';

describe('clipToolResult', () => {
  it('returns the string unchanged when under the limit', () => {
    expect(clipToolResult('hello', 100)).toBe('hello');
  });

  it('truncates and appends a tail marker when over the limit', () => {
    const input = 'a'.repeat(2000);
    const result = clipToolResult(input, 500);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toContain('[tool-result truncated:');
  });

  it('uses DEFAULT_MAX_RESULT_SIZE_CHARS when no limit given', () => {
    const short = 'short text';
    expect(clipToolResult(short)).toBe(short);
  });

  it('includes remain chars in the truncation message', () => {
    const result = clipToolResult('x'.repeat(60_000));
    expect(result).toContain('removed');
  });
});

describe('capTurnToolResults', () => {
  it('returns 0 when total tool content is under the cap', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'tool', tool_call_id: '1' },
      { role: 'tool', content: 'a'.repeat(100) },
    ];
    expect(capTurnToolResults(msgs, 500)).toBe(0);
  });

  it('evicts oldest tool results when over the cap', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'a'.repeat(10_000) },
      { role: 'tool', content: 'b'.repeat(1_000) },
    ];
    const dropped = capTurnToolResults(msgs, 5_000);
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(msgs[1].content).toContain('evicted');
  });

  it('ignores non-tool messages in the count', () => {
    const msgs = [
      { role: 'user', content: 'a'.repeat(100_000) },
      { role: 'assistant', content: 'b'.repeat(100_000) },
    ];
    expect(capTurnToolResults(msgs)).toBe(0);
  });

  it('handles object content in tool messages', () => {
    const msgs = [
      { role: 'tool', content: { data: 'x'.repeat(100_000) } },
    ];
    const dropped = capTurnToolResults(msgs, 1_000);
    expect(dropped).toBe(1);
  });

  it('returns the count of evicted messages', () => {
    const msgs = [
      { role: 'tool', content: 'x'.repeat(80_000) },
      { role: 'tool', content: 'y'.repeat(80_000) },
      { role: 'tool', content: 'z'.repeat(80_000) },
    ];
    const dropped = capTurnToolResults(msgs, 50_000);
    expect(dropped).toBeGreaterThanOrEqual(2);
  });
});
