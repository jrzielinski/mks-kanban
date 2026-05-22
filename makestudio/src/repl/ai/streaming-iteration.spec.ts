import {
  consumeProviderStream,
  logStreamResponseSummary,
  handleStreamException,
  surfacePreambleNarration,
  recordLlmRequestStart,
  recordLlmRequestEnd,
  persistFinalAssistantMessage,
  surfaceEmptyTurnNoTextResponse,
} from './streaming-iteration';

describe('logStreamResponseSummary', () => {
  it('does not throw when debug-log is unavailable', () => {
    expect(() => {
      logStreamResponseSummary({} as any, 'text', [], null, 100, [] as any);
    }).not.toThrow();
  });

  it('handles null/undefined lastUsage', () => {
    const ctx = { providerInfo: { model: 'test' } };
    expect(() => {
      logStreamResponseSummary(ctx as any, 'hello', [], undefined, 0, [] as any);
    }).not.toThrow();
  });
});

describe('handleStreamException', () => {
  it('returns fatal', () => {
    const ctx = { recordApiMs: () => {} } as any;
    const result = handleStreamException({
      err: new Error('test error'),
      ctx,
      chatMessages: [] as any,
      bridge: { addMessage: () => {}, updateMessage: () => {} },
      msgId: 'm1',
      accumulatedText: '',
      buildAssistantMessage: (t: string | null) => ({ role: 'assistant', content: t }),
      lastUsage: {},
      apiStart: Date.now(),
      llmReqStartSeq: null,
      abortController: new AbortController(),
    });
    expect(result).toBe('fatal');
  });
});

describe('surfacePreambleNarration', () => {
  it('returns early when no tool calls', async () => {
    await expect(surfacePreambleNarration([], 'text', {} as any, 'm1'))
      .resolves.toBeUndefined();
  });

  it('resolves without throwing', async () => {
    const bridge = { updateMessage: () => {} };
    await expect(surfacePreambleNarration(
      [{ type: 'tool_use' }], 'some text', bridge, 'm1',
    )).resolves.toBeUndefined();
  });
});

describe('recordLlmRequestStart', () => {
  it('does not throw with minimal ctx', () => {
    expect(() => {
      recordLlmRequestStart({} as any, [] as any, '', 0);
    }).not.toThrow();
  });
});

describe('recordLlmRequestEnd', () => {
  it('does not throw', () => {
    const ctx = { recordApiMs: () => {} } as any;
    expect(() => {
      recordLlmRequestEnd(ctx, Date.now(), '', [], 0, null);
    }).not.toThrow();
  });
});

describe('persistFinalAssistantMessage', () => {
  it('does not throw', () => {
    const ctx = { messages: [], lastUserMessage: 'hi', usage: {} } as any;
    expect(() => {
      persistFinalAssistantMessage(ctx, 'hello', '', '', 0);
    }).not.toThrow();
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('hello');
  });
});

describe('surfaceEmptyTurnNoTextResponse', () => {
  it('pops last user message from ctx.messages', () => {
    const ctx = { messages: [{ role: 'user', content: 'hi' }] } as any;
    const bridge = { addMessage: () => {} };
    surfaceEmptyTurnNoTextResponse(ctx, bridge);
    expect(ctx.messages).toHaveLength(0);
  });

  it('does not throw when no user message', () => {
    const ctx = { messages: [] } as any;
    const bridge = { addMessage: () => {} };
    expect(() => surfaceEmptyTurnNoTextResponse(ctx, bridge)).not.toThrow();
  });
});
