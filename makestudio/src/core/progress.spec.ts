import { parseClaudeOutputStream, parseGenericOutput } from './progress';

describe('parseClaudeOutputStream', () => {
  const TASK = 'task-1';
  const T0 = Date.now();

  it('returns null on empty input', () => {
    expect(parseClaudeOutputStream(TASK, '', T0)).toBeNull();
    expect(parseClaudeOutputStream(TASK, '   \n', T0)).toBeNull();
  });

  it('returns null on non-JSON raw output', () => {
    expect(parseClaudeOutputStream(TASK, 'plain text, not json', T0)).toBeNull();
  });

  it('returns null for system init messages', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(parseClaudeOutputStream(TASK, line, T0)).toBeNull();
  });

  it('returns null for user (tool-result) messages', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    expect(parseClaudeOutputStream(TASK, line, T0)).toBeNull();
  });

  it('returns null for rate_limit_event', () => {
    expect(parseClaudeOutputStream(TASK, JSON.stringify({ type: 'rate_limit_event' }), T0)).toBeNull();
  });

  it('parses a tool_use event with file_path', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } },
        ],
      },
    });
    const ev = parseClaudeOutputStream(TASK, line, T0);
    expect(ev?.type).toBe('tool_call');
    expect(ev?.tool).toBe('Read');
    expect(ev?.file).toBe('src/foo.ts');
    expect(ev?.message).toBe('Read: src/foo.ts');
  });

  it('falls back to pattern / command / content / query / url when file_path missing', () => {
    const cases = [
      { input: { pattern: 'TODO' }, expectedDetail: 'TODO' },
      { input: { command: 'npm install' }, expectedDetail: 'npm install' },
      { input: { content: 'line of code' }, expectedDetail: 'line of code' },
      { input: { query: 'search me' }, expectedDetail: 'search me' },
      { input: { url: 'https://x.com' }, expectedDetail: 'https://x.com' },
    ];
    for (const c of cases) {
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Tool', input: c.input }] },
      });
      const ev = parseClaudeOutputStream(TASK, line, T0);
      expect(ev?.file).toBe(c.expectedDetail);
    }
  });

  it('uses tool name only when no input detail is present', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Glob', input: {} }] },
    });
    const ev = parseClaudeOutputStream(TASK, line, T0);
    expect(ev?.message).toBe('Glob');
  });

  it('truncates long command/content/query/url at specified caps', () => {
    // command capped at 80 chars
    const long = 'x'.repeat(200);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: long } }] },
    });
    const ev = parseClaudeOutputStream(TASK, line, T0);
    expect(ev?.file?.length).toBe(80);
  });

  it('parses a short text block as progress message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Looking at the file.' }] },
    });
    const ev = parseClaudeOutputStream(TASK, line, T0);
    expect(ev?.type).toBe('text');
    expect(ev?.message).toBe('Looking at the file.');
  });

  it('ignores very long text blocks (>= 200 chars)', () => {
    const longText = 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: longText }] },
    });
    expect(parseClaudeOutputStream(TASK, line, T0)).toBeNull();
  });

  it('parses a final result with cost / turns / duration', () => {
    const line = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.1234,
      num_turns: 7,
      duration_ms: 45_000,
    });
    const ev = parseClaudeOutputStream(TASK, line, T0);
    expect(ev?.type).toBe('result');
    expect(ev?.message).toContain('7 turnos');
    expect(ev?.message).toContain('45s');
    expect(ev?.message).toContain('$0.1234');
  });

  it('handles missing fields on result gracefully', () => {
    const ev = parseClaudeOutputStream(TASK, JSON.stringify({ type: 'result' }), T0);
    expect(ev?.type).toBe('result');
    expect(ev?.message).toContain('$0.0000');
  });

  it('returns null for unrecognised message types', () => {
    expect(parseClaudeOutputStream(TASK, JSON.stringify({ type: 'unknown' }), T0)).toBeNull();
  });

  it('handles malformed content arrays without throwing', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: null } });
    expect(parseClaudeOutputStream(TASK, line, T0)).toBeNull();
  });

  it('picks only the FIRST actionable block in a mixed content array', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'First', input: {} },
          { type: 'tool_use', name: 'Second', input: {} },
        ],
      },
    });
    const ev = parseClaudeOutputStream(TASK, line, T0);
    expect(ev?.tool).toBe('First');
  });
});

describe('parseGenericOutput', () => {
  const TASK = 't';
  const T0 = Date.now();

  it('returns null for empty / whitespace / too-short lines', () => {
    expect(parseGenericOutput(TASK, '', T0)).toBeNull();
    expect(parseGenericOutput(TASK, '  ', T0)).toBeNull();
    expect(parseGenericOutput(TASK, 'ab', T0)).toBeNull();
  });

  it('returns an output event for normal lines', () => {
    const ev = parseGenericOutput(TASK, 'Processing task...', T0);
    expect(ev?.type).toBe('output');
    expect(ev?.message).toBe('Processing task...');
  });

  it('skips lines that look like large data dumps (> 200 chars)', () => {
    const big = 'a'.repeat(210);
    expect(parseGenericOutput(TASK, big, T0)).toBeNull();
  });

  it('trims leading/trailing whitespace before returning', () => {
    const ev = parseGenericOutput(TASK, '   hello   ', T0);
    expect(ev?.message).toBe('hello');
  });

  it('accepts the 200-char boundary exactly', () => {
    const exactly200 = 'a'.repeat(200);
    const ev = parseGenericOutput(TASK, exactly200, T0);
    expect(ev).not.toBeNull();
  });
});
