import { normalizeUsage, handleMaxTokensTruncation } from './streaming-response';

describe('normalizeUsage', () => {
  it('handles camelCase (normalised) shape', () => {
    const out = normalizeUsage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(out).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheReads: 0, cacheWrites: 0 });
  });

  it('handles OpenAI snake_case shape', () => {
    const out = normalizeUsage({ prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 });
    expect(out).toEqual({ promptTokens: 5, completionTokens: 15, totalTokens: 20, cacheReads: 0, cacheWrites: 0 });
  });

  it('handles Anthropic output_tokens / input_tokens', () => {
    const out = normalizeUsage({ input_tokens: 100, output_tokens: 50 });
    expect(out.promptTokens).toBe(100);
    expect(out.completionTokens).toBe(50);
    expect(out.totalTokens).toBe(150);
  });

  it('falls back to 0 when no usage data', () => {
    const out = normalizeUsage({});
    expect(out).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReads: 0, cacheWrites: 0 });
  });

  it('handles empty object same as null — both return zeros', () => {
    const out = normalizeUsage({});
    expect(out).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReads: 0, cacheWrites: 0 });
  });

  it('prefers camelCase over snake_case', () => {
    const out = normalizeUsage({ promptTokens: 99, prompt_tokens: 1 });
    expect(out.promptTokens).toBe(99);
  });

  it('reads cache reads from cacheReads (camelCase)', () => {
    const out = normalizeUsage({ cacheReads: 50, cache_read_input_tokens: 10 });
    expect(out.cacheReads).toBe(50);
  });

  it('reads cache reads from cache_read_input_tokens (Anthropic)', () => {
    const out = normalizeUsage({ cache_read_input_tokens: 25 });
    expect(out.cacheReads).toBe(25);
  });

  it('reads cache writes from cacheWrites (camelCase)', () => {
    const out = normalizeUsage({ cacheWrites: 7 });
    expect(out.cacheWrites).toBe(7);
  });

  it('reads cache writes from cache_creation_input_tokens (Anthropic)', () => {
    const out = normalizeUsage({ cache_creation_input_tokens: 13 });
    expect(out.cacheWrites).toBe(13);
  });

  it('reads cache from prompt_tokens_details.cached_tokens', () => {
    const out = normalizeUsage({ prompt_tokens_details: { cached_tokens: 42 } });
    expect(out.cacheReads).toBe(42);
  });
});

describe('handleMaxTokensTruncation', () => {
  const buildAssistantMsg = (text: string | null) => ({ role: 'assistant', content: text });

  it('returns false when finishReason is not truncation', () => {
    const ctx: any = { __maxTokenContinuations: 0 };
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { stop_reason: 'end_turn' },
      accumulatedText: 'some text',
      chatMessages: [],
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(false);
    expect(ctx.__maxTokenContinuations).toBe(0);
  });

  it('returns false on length with no accumulated text', () => {
    const ctx: any = {};
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { finish_reason: 'length' },
      accumulatedText: '',
      chatMessages: [],
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(false);
  });

  it('returns true and queues continuation on length with text', () => {
    const ctx: any = {};
    const chatMessages: any[] = [];
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { finish_reason: 'length' },
      accumulatedText: 'partial response',
      chatMessages,
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(true);
    expect(chatMessages).toHaveLength(2);
    expect(chatMessages[0].role).toBe('assistant');
    expect(chatMessages[1].role).toBe('user');
    expect(chatMessages[1].content).toContain('truncated at max_tokens');
    expect(ctx.__maxTokenContinuations).toBe(1);
  });

  it('queues continuation on max_tokens finish reason', () => {
    const ctx: any = {};
    const chatMessages: any[] = [];
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { finish_reason: 'max_tokens' },
      accumulatedText: 'partial',
      chatMessages,
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(true);
    expect(ctx.__maxTokenContinuations).toBe(1);
  });

  it('uses stop_reason too (Anthropic shape)', () => {
    const ctx: any = {};
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { stop_reason: 'max_tokens' },
      accumulatedText: 'partial',
      chatMessages: [],
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(true);
  });

  it('stops after MAX_CONTINUATION_RETRIES (2)', () => {
    const ctx: any = { __maxTokenContinuations: 2 };
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { finish_reason: 'length' },
      accumulatedText: 'still partial',
      chatMessages: [],
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(false);
    expect(bridge.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'warn' }),
    );
  });

  it('resets non-truncated turn counter', () => {
    const ctx: any = { __maxTokenContinuations: 3 };
    const bridge = { addMessage: jest.fn() };
    const result = handleMaxTokensTruncation({
      ctx,
      lastUsage: { finish_reason: 'stop' },
      accumulatedText: 'full response',
      chatMessages: [],
      buildAssistantMessage: buildAssistantMsg,
      bridge,
    });
    expect(result).toBe(false);
    expect(ctx.__maxTokenContinuations).toBe(0);
  });
});
