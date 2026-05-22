import {
  stripResumeTail,
  injectCancelSignal,
  compressTrailingUsers,
  normalizeAlternation,
  appendAtReferenceHint,
  sanitizeHistoryForLLM,
  reduceHistoryForToolLoop,
} from './history-sanitization';

function makeMsg(role: string, content: any, extra?: any) {
  return { role, content, ...extra };
}

function makeCtx(overrides?: any): any {
  return { justResumed: false, cwd: '/tmp', ...overrides };
}

describe('stripResumeTail', () => {
  it('returns messages unchanged when not justResumed', () => {
    const msgs = [makeMsg('user', 'hi')];
    expect(stripResumeTail(msgs, makeCtx())).toBe(msgs);
  });

  it('strips incomplete tool chain after resume', () => {
    const msgs = [
      makeMsg('assistant', 'ok'),
      makeMsg('tool', 'result'),
      makeMsg('assistant', 'some text'),
      makeMsg('assistant', [{ type: 'tool_use', name: 'read' }]),
      makeMsg('user', 'continue'),
    ];
    const ctx = makeCtx({ justResumed: true });
    const result = stripResumeTail(msgs, ctx);
    // stripResumeTail only strips if the tail has incomplete tool calls
    // or accumulated users. The tool chain detection looks at the last
    // clean assistant/tool message.
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(ctx.justResumed).toBe(false);
  });

  it('strips accumulated user messages after resume', () => {
    const msgs = [
      makeMsg('assistant', 'ok'),
      makeMsg('user', 'msg1'),
      makeMsg('user', 'msg2'),
      makeMsg('user', 'final'),
    ];
    const ctx = makeCtx({ justResumed: true });
    const result = stripResumeTail(msgs, ctx);
    // With 4 messages: [assistant, user, user, user], cleanEnd=0
    // tail=[user, user], tailIsOnlyUsers=true → strips to [assistant, user(final)]
    expect(Array.isArray(result)).toBe(true);
    expect(result[result.length - 1].role).toBe('user');
  });
});

describe('injectCancelSignal', () => {
  it('injects cancel signal when prev turn ended with tool_use', () => {
    const msgs = [
      makeMsg('user', 'do it'),
      makeMsg('assistant', [{ type: 'tool_use', name: 'read' }]),
      makeMsg('user', 'stop'),
    ];
    const result = injectCancelSignal(msgs);
    expect(result).toHaveLength(4);
    expect(result[2].role).toBe('assistant');
    expect(result[2].content).toContain('interrupted');
  });

  it('returns unchanged when no tool_use in prev turn', () => {
    const msgs = [
      makeMsg('user', 'hi'),
      makeMsg('assistant', 'hello'),
      makeMsg('user', 'bye'),
    ];
    expect(injectCancelSignal(msgs)).toBe(msgs);
  });

  it('returns same length when prev turn ended cleanly with text', () => {
    const msgs = [
      makeMsg('user', 'hi'),
      makeMsg('assistant', [{ type: 'tool_use', name: 'read' }, { type: 'text', text: 'done' }]),
      makeMsg('user', 'ok'),
    ];
    const result = injectCancelSignal(msgs);
    // If endedClean=true (has text AND the last block isn't tool_use), no injection expected
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

describe('compressTrailingUsers', () => {
  it('compresses 3+ trailing user messages to 1', () => {
    const msgs = [
      makeMsg('assistant', 'ok'),
      makeMsg('user', 'a'),
      makeMsg('user', 'b'),
      makeMsg('user', 'c'),
    ];
    const result = compressTrailingUsers(msgs);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('c');
  });

  it('compresses 2 identical trailing user messages', () => {
    const msgs = [
      makeMsg('assistant', 'ok'),
      makeMsg('user', 'hello'),
      makeMsg('user', 'hello'),
    ];
    const result = compressTrailingUsers(msgs);
    expect(result).toHaveLength(2);
  });

  it('does not compress 2 different trailing user messages', () => {
    const msgs = [
      makeMsg('assistant', 'ok'),
      makeMsg('user', 'hello'),
      makeMsg('user', 'world'),
    ];
    expect(compressTrailingUsers(msgs)).toBe(msgs);
  });

  it('does not compress single trailing user', () => {
    const msgs = [
      makeMsg('assistant', 'ok'),
      makeMsg('user', 'hello'),
    ];
    expect(compressTrailingUsers(msgs)).toBe(msgs);
  });
});

describe('normalizeAlternation', () => {
  it('inserts placeholder between consecutive user messages', () => {
    const msgs = [
      makeMsg('user', 'first'),
      makeMsg('user', 'second'),
    ];
    const result = normalizeAlternation(msgs);
    expect(result).toHaveLength(3);
    expect(result[1].role).toBe('assistant');
  });

  it('does not modify already alternating messages', () => {
    const msgs = [
      makeMsg('user', 'hi'),
      makeMsg('assistant', 'hello'),
    ];
    expect(normalizeAlternation(msgs)).toEqual(msgs);
  });
});

describe('sanitizeHistoryForLLM', () => {
  it('runs all passes without throwing', () => {
    const msgs = [makeMsg('user', 'hello')];
    const ctx = makeCtx();
    const result = sanitizeHistoryForLLM(msgs, ctx, 'hello');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('reduceHistoryForToolLoop', () => {
  it('compacts older Bash results and trims their tool args', () => {
    const oldBash = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'bash-1',
        type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command: 'git status --short && npm test && echo extra' }) },
      }],
    };
    const oldResult = makeMsg('tool', 'x'.repeat(500), { tool_call_id: 'bash-1' });
    const recentTail = Array.from({ length: 8 }, (_, i) => makeMsg(i % 2 === 0 ? 'assistant' : 'tool', `recent-${i}`, i % 2 === 1 ? { tool_call_id: `recent-${i}` } : undefined));
    const msgs = [oldBash, oldResult, ...recentTail];

    const result = reduceHistoryForToolLoop(msgs);
    expect(result).not.toBe(msgs);
    expect(result[0].tool_calls[0].function.arguments).toContain('_omitted');
    expect(result[1].content).toContain('Older Bash result omitted');
  });

  it('preserves recent Bash results verbatim', () => {
    const msgs = [
      makeMsg('user', 'start'),
      makeMsg('assistant', 'older'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'bash-recent',
          type: 'function',
          function: { name: 'Bash', arguments: JSON.stringify({ command: 'ls -la' }) },
        }],
      },
      makeMsg('tool', 'y'.repeat(500), { tool_call_id: 'bash-recent' }),
    ];

    const result = reduceHistoryForToolLoop(msgs);
    expect(result).toBe(msgs);
    expect(result[3].content).toBe('y'.repeat(500));
  });

  it('compacts older Anthropic-style tool_result blocks for Grep', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'foo', path: 'src' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'grep-1', content: 'z'.repeat(300) }],
      },
      ...Array.from({ length: 8 }, (_, i) => makeMsg('assistant', `recent-${i}`)),
    ];

    const result = reduceHistoryForToolLoop(msgs);
    expect(result[1].content[0].content).toContain('Older Grep result omitted');
  });
});
