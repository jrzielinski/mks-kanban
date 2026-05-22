/**
 * Tests for jsonl-stream-formatter.ts — subprocess JSONL stream parser
 * that converts each parsed line into a human-readable terminal line.
 *
 * Covers: formatStreamLine, JsonlStreamReader (push + flush).
 */
import { formatStreamLine, JsonlStreamReader } from './jsonl-stream-formatter';

// ── formatStreamLine ─────────────────────────────────────────────────────────

describe('formatStreamLine', () => {
  it('returns null for empty/whitespace-only input', () => {
    expect(formatStreamLine('')).toBeNull();
    expect(formatStreamLine('   ')).toBeNull();
    expect(formatStreamLine('\n')).toBeNull();
  });

  it('handles info type messages', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'info', message: 'loading config' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(false);
    expect(r!.display).toContain('loading config');
  });

  it('handles log type messages', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'log', message: 'step 1 done' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.display).toContain('step 1 done');
  });

  it('handles log type with empty trimmed message', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'log', message: '   ' }));
    expect(r).toBeNull();
  });

  it('highlights tool invocations in log messages', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'log', message: '[tool] Read (file_path=src/a.ts)' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.toolCallCount).toBe(1);
    expect(r!.display).toContain('Read');
  });

  it('handles error type messages', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'error', message: 'something broke' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.display).toContain('something broke');
  });

  it('handles assistant text', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'assistant', text: 'Here is the result' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.resultText).toBe('Here is the result');
    expect(r!.display).toContain('Here is the result');
  });

  it('handles assistant text > 200 chars (truncated display)', () => {
    const long = 'x'.repeat(250);
    const r = formatStreamLine(JSON.stringify({ type: 'assistant', text: long }));
    expect(r).not.toBeNull();
    expect(r!.resultText).toBe(long);
    expect(r!.display).not.toContain('x'.repeat(201));
  });

  it('returns null for assistant text that is empty after trim', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'assistant', text: '   ' }));
    expect(r).toBeNull();
  });

  it('handles claude stream-JSON with tool_use blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
          { type: 'text', text: 'Found the file.' },
        ],
      },
    };
    const r = formatStreamLine(JSON.stringify(msg));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.toolCallCount).toBe(1);
    expect(r!.display).toContain('Read');
    expect(r!.resultText).toBe('Found the file.');
  });

  it('handles claude stream-JSON with multiple tool_calls', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          { type: 'text', text: 'Done' },
        ],
      },
    };
    const r = formatStreamLine(JSON.stringify(msg));
    expect(r).not.toBeNull();
    expect(r!.toolCallCount).toBe(2);
  });

  it('handles claude stream-JSON with empty content blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [] },
    };
    const r = formatStreamLine(JSON.stringify(msg));
    expect(r).toBeNull();
  });

  it('handles result type with cost and turns', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'result', total_cost_usd: 0.042, num_turns: 5, result: 'final output' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.costUsd).toBe(0.042);
    expect(r!.resultText).toBe('final output');
    expect(r!.display).toContain('5 turns');
    expect(r!.display).toContain('$0.0420');
  });

  it('returns null for noise events (system/user/rate_limit)', () => {
    expect(formatStreamLine(JSON.stringify({ type: 'system' }))).toBeNull();
    expect(formatStreamLine(JSON.stringify({ type: 'user' }))).toBeNull();
    expect(formatStreamLine(JSON.stringify({ type: 'rate_limit_event' }))).toBeNull();
  });

  it('handles unknown JSON with preview', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'custom', someField: 'value' }));
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(false);
    expect(r!.display).toContain('custom');
  });

  it('falls back to plain text for non-JSON lines', () => {
    const r = formatStreamLine('some plain text output');
    expect(r).not.toBeNull();
    expect(r!.hadActivity).toBe(true);
    expect(r!.display).toContain('some plain text output');
  });

  it('returns null for short (< 3 chars) or long (> 500 chars) plain text', () => {
    expect(formatStreamLine('ab')).toBeNull();
    expect(formatStreamLine('x'.repeat(501))).toBeNull();
  });

  it('strips ANSI codes from plain text fallback', () => {
    const r = formatStreamLine('\x1b[31mred text\x1b[0m');
    expect(r).not.toBeNull();
    expect(r!.display).not.toContain('\x1b[31m');
  });

  it('respects a custom prefix', () => {
    const r = formatStreamLine(JSON.stringify({ type: 'log', message: 'test' }), '│ ');
    expect(r).not.toBeNull();
    expect(r!.display).toContain('│');
  });

  it('handles input with tool_use blocks using query field', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'WebSearch', input: { query: 'latest news' } },
        ],
      },
    };
    const r = formatStreamLine(JSON.stringify(msg));
    expect(r).not.toBeNull();
    expect(r!.display).toContain('WebSearch');
    expect(r!.display).toContain('latest news');
  });

  it('handles input with tool_use blocks using command field', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la /tmp' } },
        ],
      },
    };
    const r = formatStreamLine(JSON.stringify(msg));
    expect(r).not.toBeNull();
    expect(r!.display).toContain('Bash');
    expect(r!.display).toContain('ls -la /tmp');
  });

  it('returns null for tool_use with no text blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '   ' }],
      },
    };
    const r = formatStreamLine(JSON.stringify(msg));
    expect(r).toBeNull();
  });
});

// ── JsonlStreamReader ────────────────────────────────────────────────────────

describe('JsonlStreamReader', () => {
  it('processes complete lines from a chunk', () => {
    const reader = new JsonlStreamReader();
    const lines = reader.push(
      JSON.stringify({ type: 'log', message: 'a' }) + '\n' +
      JSON.stringify({ type: 'log', message: 'b' }) + '\n',
    );
    expect(lines).toHaveLength(2);
  });

  it('buffers partial line until flush', () => {
    const reader = new JsonlStreamReader();
    const first = reader.push('{"type":"log","message":"partial');
    expect(first).toHaveLength(0);
    const second = reader.push('"}');
    expect(second).toHaveLength(0);
    const flushed = reader.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].display).toContain('partial');
  });

  it('returns nothing from flush when buffer is empty', () => {
    const reader = new JsonlStreamReader();
    expect(reader.flush()).toHaveLength(0);
  });

  it('returns nothing from flush when buffer is whitespace', () => {
    const reader = new JsonlStreamReader();
    reader.push('   \n');
    expect(reader.flush()).toHaveLength(0);
  });

  it('handles multiple partial chunks with final flush', () => {
    const reader = new JsonlStreamReader('│ ');
    reader.push('{"type":"log","message":"line1"}\n{"type":"');
    reader.push('info","message":"line2"}\n{"type":"log"');
    const flushed = reader.flush();
    // push should have returned 2 complete lines, flush returns the last partial
    expect(flushed).toHaveLength(1);
  });

  it('accepts Buffer input', () => {
    const reader = new JsonlStreamReader();
    const lines = reader.push(Buffer.from('{"type":"log","message":"buf"}\n'));
    expect(lines).toHaveLength(1);
    expect(lines[0].display).toContain('buf');
  });
});
