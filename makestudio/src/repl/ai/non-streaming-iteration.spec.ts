import {
  parseSendMessageResponse,
  healReasoningContentForRetry,
  runCliPostTurn,
} from './non-streaming-iteration';

describe('parseSendMessageResponse', () => {
  it('parses text blocks', () => {
    const response = {
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
    };
    const parsed = parseSendMessageResponse(response);
    expect(parsed.textBlocks).toEqual(['Hello', 'World']);
    expect(parsed.toolUseBlocks).toEqual([]);
  });

  it('parses tool_use blocks', () => {
    const response = {
      content: [
        { type: 'tool_use', name: 'read', input: { file: 'x' } },
      ],
    };
    const parsed = parseSendMessageResponse(response);
    expect(parsed.toolUseBlocks).toHaveLength(1);
    expect(parsed.toolUseBlocks[0].name).toBe('read');
  });

  it('concatenates thinking blocks with signature', () => {
    const response = {
      content: [
        { type: 'thinking', thinking: 'step 1', signature: 'sig1' },
        { type: 'thinking', thinking: 'step 2', signature: 'sig2' },
      ],
    };
    const parsed = parseSendMessageResponse(response);
    expect(parsed.thinkingText).toBe('step 1step 2');
    expect(parsed.thinkingSignature).toBe('sig1|sig2');
  });

  it('handles empty content', () => {
    const parsed = parseSendMessageResponse({ content: [] });
    expect(parsed.textBlocks).toEqual([]);
    expect(parsed.toolUseBlocks).toEqual([]);
    expect(parsed.thinkingText).toBe('');
  });

  it('handles undefined content', () => {
    const parsed = parseSendMessageResponse({});
    expect(parsed.textBlocks).toEqual([]);
    expect(parsed.toolUseBlocks).toEqual([]);
  });
});

describe('healReasoningContentForRetry', () => {
  it('returns unhandled for non-reasoning errors', () => {
    expect(healReasoningContentForRetry('some other error', {} as any, [] as any))
      .toBe('unhandled');
  });

  it('returns continue for reasoning content errors', () => {
    // When assistants have no reasoning_content, it heals them
    const ctx = { messages: [] } as any;
    const result = healReasoningContentForRetry(
      'The reasoning_content must be passed back',
      ctx,
      [{ role: 'assistant', content: 'hello' }],
    );
    // If all messages already have content, it returns continue
    expect(result).toBe('continue');
  });
});

describe('runCliPostTurn', () => {
  it('does not throw with minimal ctx', () => {
    const ctx = { messages: [], provider: 'anthropic', providerInfo: {} } as any;
    // @ts-ignore
    expect(() => runCliPostTurn(ctx, 'hello')).not.toThrow();
  });
});
