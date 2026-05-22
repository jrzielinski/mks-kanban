import { AnthropicDirectProvider } from './direct-anthropic';
import { getProviderKey } from '../../../config/credentials';
import type { CatalogEntry, DirectCallParams } from './types';

jest.mock('../../../config/credentials', () => ({
  getProviderKey: jest.fn(),
}));

const mockClient = { messages: { create: jest.fn(), stream: jest.fn() } };
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(() => mockClient),
}));

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    baseURL: 'https://api.anthropic.com',
    maxOutputTokens: 8192,
    ...overrides,
  };
}

function makeParams(overrides: Partial<DirectCallParams> = {}): DirectCallParams {
  return {
    system: '',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    ...overrides,
  };
}

function mockSendResponse(overrides: Record<string, any> = {}) {
  return {
    content: [{ type: 'text', text: 'Hi!' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: async () => {
          if (i < items.length) return { done: false, value: items[i++] };
          return { done: true, value: undefined as any };
        },
      };
    },
  };
}

describe('AnthropicDirectProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProviderKey as jest.Mock).mockReturnValue('sk-ant-test-key');
  });

  describe('constructor', () => {
    it('uses default baseURL when none provided', () => {
      const p = new AnthropicDirectProvider(makeEntry({ baseURL: undefined }));
      expect(p.baseURL).toBe('https://api.anthropic.com');
    });

    it('uses provided baseURL', () => {
      const p = new AnthropicDirectProvider(makeEntry({ baseURL: 'https://custom.test' }));
      expect(p.baseURL).toBe('https://custom.test');
    });

    it('defaults maxOutputTokens to 8192', () => {
      const p = new AnthropicDirectProvider(makeEntry({ maxOutputTokens: undefined }));
      expect(p.maxOutputTokens).toBe(8192);
    });

    it('stores model from entry', () => {
      const p = new AnthropicDirectProvider(makeEntry({ model: 'claude-3-opus' }));
      expect(p.model).toBe('claude-3-opus');
    });
  });

  describe('send', () => {
    it('throws when API key is missing', async () => {
      (getProviderKey as jest.Mock).mockReturnValue(null);
      const p = new AnthropicDirectProvider(makeEntry());
      await expect(p.send(makeParams())).rejects.toThrow(
        "Missing API key for provider 'anthropic'",
      );
    });

    it('calls messages.create with correct model and messages', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams());
      expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.max_tokens).toBe(8192);
      expect(body.temperature).toBe(0.7);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('includes system with cache_control when provided', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ system: 'Be concise.' }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.system).toEqual([
        { type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('omits system when empty string', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ system: '' }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.system).toBeUndefined();
    });

    it('converts tools to Anthropic format with parameters', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(
        makeParams({
          tools: [
            {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.tools).toEqual([
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]);
    });

    it('uses input_schema when parameters is absent', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(
        makeParams({
          tools: [{ name: 'tool', description: 'desc', input_schema: { type: 'object' } }],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.tools[0].input_schema).toEqual({ type: 'object' });
    });

    it('omits tools when empty array', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ tools: [] }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.tools).toBeUndefined();
    });

    it('passes signal to messages.create', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      const ac = new AbortController();
      await p.send(makeParams({ signal: ac.signal }));
      expect(mockClient.messages.create.mock.calls[0][1]?.signal).toBe(ac.signal);
    });

    it('parses plain text response', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      const result = await p.send(makeParams());
      expect(result.content).toEqual([{ type: 'text', text: 'Hi!' }]);
      expect(result.stopReason).toBe('end_turn');
    });

    it('parses thinking + text + tool_use blocks', async () => {
      mockClient.messages.create.mockResolvedValue(
        mockSendResponse({
          content: [
            { type: 'thinking', thinking: 'Hmm...', signature: 'sig123' },
            { type: 'text', text: 'Answer' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        }),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const result = await p.send(makeParams());
      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'Hmm...', signature: 'sig123' });
      expect(result.content[1]).toEqual({ type: 'text', text: 'Answer' });
      expect(result.content[2]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'NYC' } });
    });

    it('parses usage stats correctly', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      const result = await p.send(makeParams());
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReads: 0,
        cacheWrites: 0,
      });
    });

    it('handles cache usage in response', async () => {
      mockClient.messages.create.mockResolvedValue(
        mockSendResponse({
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 2,
          },
        }),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const result = await p.send(makeParams());
      expect(result.usage?.cacheReads).toBe(8);
      expect(result.usage?.cacheWrites).toBe(2);
    });

    it('defaults stopReason to stop when missing', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse({ stop_reason: undefined }));
      const p = new AnthropicDirectProvider(makeEntry());
      const result: any = await p.send(makeParams());
      expect(result.stopReason).toBe('stop');
    });
  });

  describe('stream', () => {
    async function collectStream(
      p: AnthropicDirectProvider,
      params: DirectCallParams,
    ): Promise<any[]> {
      const items: any[] = [];
      for await (const chunk of p.stream(params)) {
        items.push(chunk);
      }
      return items;
    }

    it('yields start chunk then end when client creation fails', async () => {
      (getProviderKey as jest.Mock).mockReturnValue(null);
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      expect(items[0]).toEqual({ type: 'start', provider: 'anthropic', model: 'claude-sonnet-4-6' });
      expect(items[1]).toEqual({ type: 'error', error: "Missing API key for provider 'anthropic'" });
      expect(items[2]).toEqual({ type: 'end' });
    });

    it('yields text deltas from stream events', async () => {
      mockClient.messages.stream.mockReturnValue(
        asyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      // Filter content chunks for assertion
      const chunks = items.filter((c) => c.type !== 'start');
      expect(chunks[0]).toEqual({ type: 'text_delta', text: 'Hello' });
      expect(chunks[1]).toEqual({ type: 'text_delta', text: ' world' });
    });

    it('yields thinking deltas with signature', async () => {
      mockClient.messages.stream.mockReturnValue(
        asyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking...' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_val' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15, input_tokens: 10 } },
        ]),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      const deltas = items.filter((c) => c.type !== 'start');
      expect(deltas[0]).toEqual({ type: 'thinking_delta', thinking: 'Thinking...' });
      expect(deltas[1]).toEqual({ type: 'thinking_signature', signature: 'sig_val' });
      expect(deltas[2]).toEqual({ type: 'text_delta', text: 'Answer' });
    });

    it('yields tool_use from content_block_start + input_json_delta', async () => {
      mockClient.messages.stream.mockReturnValue(
        asyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"NYC"}' } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
        ]),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      const toolUses = items.filter((c) => c.type === 'tool_use');
      expect(toolUses).toHaveLength(1);
      expect(toolUses[0]).toEqual({
        type: 'tool_use',
        id: 'tu_1',
        name: 'get_weather',
        input: { city: 'NYC' },
      });
    });

    it('yields message_delta usage and done chunk', async () => {
      mockClient.messages.stream.mockReturnValue(
        asyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, input_tokens: 10 } },
        ]),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      expect(items).toContainEqual({ type: 'start', provider: 'anthropic', model: 'claude-sonnet-4-6' });
      expect(items).toContainEqual({ type: 'done', finishReason: 'end_turn' });
      expect(items).toContainEqual({ type: 'end' });
      // Should have usage chunk
      const usages = items.filter((c) => c.type === 'usage');
      expect(usages).toHaveLength(1);
      expect(usages[0].usage.totalTokens).toBe(15);
    });

    it('yields error on stream exception', async () => {
      mockClient.messages.stream.mockImplementation(() => {
        throw new Error('Stream connection failed');
      });
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      expect(items).toContainEqual({ type: 'error', error: 'Stream connection failed' });
      expect(items).toContainEqual({ type: 'end' });
    });

    it('skips empty text_delta and thinking_delta', async () => {
      mockClient.messages.stream.mockReturnValue(
        asyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Real' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        ]),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      const deltas = items.filter((c) => c.type === 'text_delta' || c.type === 'thinking_delta' || c.type === 'thinking_signature');
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toEqual({ type: 'text_delta', text: 'Real' });
    });

    it('handles tool_use with no name (skips it)', async () => {
      mockClient.messages.stream.mockReturnValue(
        asyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_0' },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        ]),
      );
      const p = new AnthropicDirectProvider(makeEntry());
      const items = await collectStream(p, makeParams());
      const toolUses = items.filter((c) => c.type === 'tool_use');
      expect(toolUses).toHaveLength(0);
    });
  });

  describe('effort integration', () => {
    it('uses effort low for lower max_tokens and temperature', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ effort: 'low' }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.max_tokens).toBeLessThanOrEqual(2000);
      expect(body.temperature).toBe(0.2);
    });

    it('uses effort high for higher temperature', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ effort: 'high' }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.temperature).toBeCloseTo(0.8);
    });

    it('uses effort max for max temperature', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ effort: 'max' }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.temperature).toBeCloseTo(0.9);
    });

    it('respects maxTokens override over effort', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(makeParams({ effort: 'low', maxTokens: 5000 }));
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.max_tokens).toBe(5000);
    });
  });

  describe('message conversion', () => {
    it('converts tool role to user with tool_result block', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(
        makeParams({
          messages: [
            { role: 'user', content: 'What is the weather?' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 72}' },
          ],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.messages[2].role).toBe('user');
      expect(body.messages[2].content[0].type).toBe('tool_result');
      expect(body.messages[2].content[0].tool_use_id).toBe('call_1');
    });

    it('converts assistant tool_calls to tool_use blocks', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(
        makeParams({
          messages: [
            { role: 'user', content: 'Weather?' },
            {
              role: 'assistant',
              content: 'Let me check',
              tool_calls: [
                { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
              ],
            },
          ],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      const assistantMsg = body.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toHaveLength(2); // text + tool_use
      expect(assistantMsg.content[0].type).toBe('text');
      expect(assistantMsg.content[0].text).toBe('Let me check');
      expect(assistantMsg.content[1].type).toBe('tool_use');
      expect(assistantMsg.content[1].name).toBe('get_weather');
      expect(assistantMsg.content[1].input).toEqual({ city: 'NYC' });
    });

    it('includes reasoning_content as thinking block', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(
        makeParams({
          messages: [
            { role: 'user', content: 'Think step by step' },
            {
              role: 'assistant',
              content: 'The answer is 42',
              reasoning_content: 'First, I need to calculate...',
              thinking_signature: 'sig_val',
            },
          ],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      const assistantMsg = body.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      const blocks = assistantMsg.content;
      expect(blocks[0]).toEqual({
        type: 'thinking',
        thinking: 'First, I need to calculate...',
        signature: 'sig_val',
      });
      expect(blocks[1]).toEqual({ type: 'text', text: 'The answer is 42' });
    });

    it('skips system messages in convertMessages', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      await p.send(
        makeParams({
          system: 'System prompt here',
          messages: [
            { role: 'system', content: 'Should be skipped' },
            { role: 'user', content: 'Hi' },
          ],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      // system messages should NOT appear in messages array
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });

    it('passes through user messages with array content', async () => {
      mockClient.messages.create.mockResolvedValue(mockSendResponse());
      const p = new AnthropicDirectProvider(makeEntry());
      const arrayContent = [
        { type: 'text', text: 'Describe this image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ];
      await p.send(
        makeParams({
          messages: [{ role: 'user', content: arrayContent }],
        }),
      );
      const [body] = mockClient.messages.create.mock.calls[0];
      expect(body.messages[0].content).toEqual(arrayContent);
    });
  });
});
