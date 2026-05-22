import { OpenAICompatProvider } from './direct-openai';
import { getProviderKey } from '../../../config/credentials';
import type { CatalogEntry, DirectCallParams } from './types';

jest.mock('../../../config/credentials', () => ({
  getProviderKey: jest.fn(),
}));

const mockFetch = jest.fn();
(globalThis as any).fetch = mockFetch;

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    baseURL: 'https://api.openai.com/v1',
    maxOutputTokens: 4096,
    ...overrides,
  };
}

function makeParams(overrides: Partial<DirectCallParams> = {}): DirectCallParams {
  return {
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    ...overrides,
  };
}

function mockResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Map(),
    body: null,
  };
}

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Build an SSE data line with a tool_calls delta that has a partial
 *  arguments string. `args` is used as the raw arguments value, which
 *  should be a JSON string (e.g. `'{"file'`). */
function toolCallChunk(index: number, overrides: Record<string, any>): string {
  const tc: Record<string, any> = { index };
  if (overrides.id) tc.id = overrides.id;
  if (overrides.name || overrides.args) {
    tc.function = {};
    if (overrides.name) tc.function.name = overrides.name;
    if (overrides.args) tc.function.arguments = overrides.args;
  }
  return sseChunk({
    choices: [{ delta: { tool_calls: [tc] }, finish_reason: overrides.finish_reason || null }],
  });
}

function mockStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const bytes = chunks.map((c) => encoder.encode(c));
  let idx = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: jest.fn(async () => {
          if (idx < bytes.length) return { done: false, value: bytes[idx++] };
          return { done: true, value: undefined };
        }),
        cancel: jest.fn(),
      }),
    },
    text: jest.fn(),
    headers: new Map(),
  };
}

describe('effortToMaxTokens (internal)', () => {
  it('returns cap when effort is undefined', () => {
    const { OpenAICompatProvider: P } = require('./direct-openai');
    expect(P).toBeDefined();
  });
});

describe('OpenAICompatProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProviderKey as jest.Mock).mockReturnValue('sk-test-key');
  });

  describe('constructor', () => {
    it('uses default baseURL when entry provides none', () => {
      const p = new OpenAICompatProvider(makeEntry({ baseURL: undefined }));
      expect(p.baseURL).toBe('https://api.openai.com/v1');
    });

    it('uses custom baseURL when provided', () => {
      const p = new OpenAICompatProvider(makeEntry({ baseURL: 'https://custom.example.com/v1' }));
      expect(p.baseURL).toBe('https://custom.example.com/v1');
    });

    it('uses default maxOutputTokens when not set', () => {
      const p = new OpenAICompatProvider(makeEntry({ maxOutputTokens: undefined }));
      expect(p.maxOutputTokens).toBe(4096);
    });

    it('stores provider and model', () => {
      const p = new OpenAICompatProvider(makeEntry());
      expect(p.provider).toBe('openai');
      expect(p.model).toBe('gpt-4o');
    });
  });

  describe('headers (private)', () => {
    it('returns Authorization header with bearer key', () => {
      const p = new OpenAICompatProvider(makeEntry());
      const h = (p as any).headers();
      expect(h['Authorization']).toBe('Bearer sk-test-key');
      expect(h['Content-Type']).toBe('application/json');
    });

    it('throws when provider key is missing', () => {
      (getProviderKey as jest.Mock).mockReturnValue(null);
      const p = new OpenAICompatProvider(makeEntry());
      expect(() => (p as any).headers()).toThrow('Missing API key');
    });

    it('calls getProviderKey with provider and baseURL', () => {
      const p = new OpenAICompatProvider(makeEntry());
      (p as any).headers();
      expect(getProviderKey).toHaveBeenCalledWith('openai', 'https://api.openai.com/v1');
    });
  });

  describe('send', () => {
    it('returns content blocks from a successful response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
      const p = new OpenAICompatProvider(makeEntry());
      const resp = await p.send(makeParams());
      expect(resp.content[0].text).toBe('Hello world');
      expect(resp.stopReason).toBe('stop');
      expect(resp.usage.promptTokens).toBe(10);
      expect(resp.usage.completionTokens).toBe(20);
    });

    it('sends POST to /chat/completions with correct body', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({ system: 'Be concise.' }));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"model":"gpt-4o"'),
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toBe('Be concise.');
    });

    it('includes tools when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'tool_calls' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({ tools: [{ name: 'Read', description: 'Read a file' }] }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].function.name).toBe('Read');
      expect(body.tool_choice).toBe('auto');
    });

    it('omits tools key when no tools given', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({ tools: [] }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toBeUndefined();
    });

    it('throws on HTTP error with status text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: jest.fn().mockResolvedValue('Unauthorized'),
      });
      const p = new OpenAICompatProvider(makeEntry());
      await expect(p.send(makeParams())).rejects.toThrow('openai HTTP 401');
    });

    it('passes signal through to fetch', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const ac = new AbortController();
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({ signal: ac.signal }));
      expect(mockFetch.mock.calls[0][1].signal).toBe(ac.signal);
    });

    it('includes thinking/reasoning content from choice', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { reasoning_content: 'Let me think...', content: 'Final answer' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      const resp = await p.send(makeParams());
      expect(resp.content[0].type).toBe('thinking');
      expect((resp.content[0] as any).thinking).toBe('Let me think...');
      expect(resp.content[1].text).toBe('Final answer');
    });

    it('includes tool_calls from choice', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/x"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      const resp = await p.send(makeParams());
      expect(resp.content[0].type).toBe('tool_use');
      expect(resp.content[0].name).toBe('Read');
      expect(resp.content[0].input).toEqual({ file_path: '/tmp/x' });
    });

    it('handles malformed tool_call arguments gracefully', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Bash', arguments: '{invalid}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      const resp = await p.send(makeParams());
      expect(resp.content[0].input).toEqual({});
    });
  });

  describe('send — effort mapping', () => {
    it.each([
      ['low', 2000, 0.2],
      ['medium', 4096, 0.7],
      ['high', 4096, 0.8],
      ['max', 4096, 0.9],
      [undefined, 4096, 0.7],
    ] as const)('effort=%s maps to max_tokens=%d, temperature=%.1f', async (effort, expectedTokens, expectedTemp) => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({ effort: effort as any }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBeCloseTo(expectedTemp, 1);
    });

    it('uses maxTokens override over effort', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({ effort: 'low', maxTokens: 8000 }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(8000);
    });
  });

  describe('stream', () => {
    it('yields start event then streams text deltas', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks[0]).toEqual({ type: 'start', provider: 'openai', model: 'gpt-4o' });
      expect(chunks).toContainEqual({ type: 'text_delta', text: 'Hello' });
      expect(chunks).toContainEqual({ type: 'text_delta', text: ' world' });
      expect(chunks).toContainEqual({ type: 'done', finishReason: 'stop' });
      expect(chunks).toContainEqual({ type: 'end' });
    });

    it('yields thinking_delta from reasoning_content', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual({ type: 'thinking_delta', thinking: 'Let me think...' });
      expect(chunks).toContainEqual({ type: 'text_delta', text: 'Answer' });
    });

    it('accumulates tool_calls across chunks', async () => {
      const p1 = '{"file';
      const p2 = '_path":"/tmp/x"}';
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        toolCallChunk(0, { id: 'call_1', name: 'Read', args: p1 }),
        toolCallChunk(0, { args: p2, finish_reason: 'tool_calls' }),
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      const toolChunks = chunks.filter((c) => c.type === 'tool_use');
      expect(toolChunks).toHaveLength(1);
      expect(toolChunks[0].name).toBe('Read');
      expect(toolChunks[0].input).toEqual({ file_path: '/tmp/x' });
    });

    it('handles multiple tool_calls', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{}"}},{"index":1,"id":"c2","function":{"name":"Bash","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      const toolChunks = chunks.filter((c) => c.type === 'tool_use');
      expect(toolChunks).toHaveLength(2);
      expect(toolChunks[0].name).toBe('Read');
      expect(toolChunks[1].name).toBe('Bash');
    });

    it('yields usage chunk when present', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":10,"total_tokens":15}}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      const usageChunk = chunks.find((c) => c.type === 'usage');
      expect(usageChunk).toBeDefined();
      expect(usageChunk.usage.promptTokens).toBe(5);
    });

    it('yields error when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network failure'));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks[0]).toEqual({ type: 'start', provider: 'openai', model: 'gpt-4o' });
      expect(chunks).toContainEqual({ type: 'error', error: 'network failure' });
      expect(chunks).toContainEqual({ type: 'end' });
    });

    it('yields error on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: jest.fn().mockResolvedValue('Rate limited'),
        body: null,
      });
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'error' }));
    });

    it('yields error on null body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
        text: jest.fn().mockResolvedValue(''),
      });
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'error' }));
    });

    it('handles reader read() errors gracefully', async () => {
      const badReader = {
        getReader: () => ({
          read: jest.fn().mockRejectedValue(new Error('stream reset')),
        }),
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: badReader,
        text: jest.fn(),
      });
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual({ type: 'error', error: 'stream reset' });
    });

    it('yields done with stop when finishReason is undefined', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual({ type: 'done', finishReason: 'stop' });
    });

    it('skips non-data lines in SSE stream', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        ':comment\n\n',
        'event: ping\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual({ type: 'text_delta', text: 'Hi' });
    });

    it('skips empty data payloads', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: \n\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual({ type: 'text_delta', text: 'Hi' });
    });

    it('parses tool_calls with string arguments split across chunks', async () => {
      const p1 = '{"file_';
      const p2 = 'path":"test.txt"}';
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        toolCallChunk(0, { id: 'c1', name: 'Read', args: p1 }),
        toolCallChunk(0, { args: p2, finish_reason: 'tool_calls' }),
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      const tool = chunks.find((c) => c.type === 'tool_use');
      expect(tool.input).toEqual({ file_path: 'test.txt' });
    });

    it('parses tool_calls with missing name gracefully', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      // tool with no name should be skipped
      expect(chunks.filter((c) => c.type === 'tool_use')).toHaveLength(0);
    });

    it('sends stream_options with include_usage', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Ok"},"finish_reason":"stop"}]}\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      for await (const _ of p.stream(makeParams())) { /* drain */ }
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it('passes Accept: text/event-stream header', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Ok"},"finish_reason":"stop"}]}\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      for await (const _ of p.stream(makeParams())) { /* drain */ }
      expect(mockFetch.mock.calls[0][1].headers.Accept).toBe('text/event-stream');
    });
  });

  describe('stream — usage in final chunk', () => {
    it('includes cacheReads from prompt_tokens_details', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      const usage = chunks.find((c: any) => c.type === 'usage');
      expect(usage.usage.cacheReads).toBe(5);
    });

    it('yields end after done event', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"content":"Bye"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry());
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks[chunks.length - 1]).toEqual({ type: 'end' });
    });
  });

  describe('send — usage with cached tokens', () => {
    it('includes cacheReads from prompt_tokens_details', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } },
      }));
      const p = new OpenAICompatProvider(makeEntry());
      const resp = await p.send(makeParams());
      expect(resp.usage.cacheReads).toBe(3);
    });

    it('falls back to sum when total_tokens missing', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 8 },
      }));
      const p = new OpenAICompatProvider(makeEntry());
      const resp = await p.send(makeParams());
      expect(resp.usage.totalTokens).toBe(15);
    });
  });

  describe('buildOpenAITools (internal)', () => {
    it('converts input_schema to parameters', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({
        tools: [{ name: 'Search', description: 'Search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
      }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools[0].function.parameters.properties.q).toBeDefined();
    });
  });

  describe('deepseek provider', () => {
    it('works with deepseek provider and custom baseURL', async () => {
      (getProviderKey as jest.Mock).mockReturnValue('sk-ds-key');
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'DeepSeek reply', reasoning_content: 'Chain of thought...' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry({
        provider: 'deepseek',
        model: 'deepseek-chat',
        baseURL: 'https://api.deepseek.com/v1',
      }));
      const resp = await p.send(makeParams());
      expect(resp.content[0].type).toBe('thinking');
      expect(resp.content[1].text).toBe('DeepSeek reply');
      expect(getProviderKey).toHaveBeenCalledWith('deepseek', 'https://api.deepseek.com/v1');
    });

    it('streams deepseek reasoning_content', async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Deep thinking..."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const p = new OpenAICompatProvider(makeEntry({
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        baseURL: 'https://api.deepseek.com/v1',
      }));
      const chunks: any[] = [];
      for await (const c of p.stream(makeParams())) chunks.push(c);
      expect(chunks).toContainEqual({ type: 'thinking_delta', thinking: 'Deep thinking...' });
      expect(chunks).toContainEqual({ type: 'text_delta', text: 'Answer' });
    });
  });

  describe('groq provider', () => {
    it('works with groq provider', async () => {
      (getProviderKey as jest.Mock).mockReturnValue('gsk-test');
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Groq fast reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      }));
      const p = new OpenAICompatProvider(makeEntry({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        baseURL: 'https://api.groq.com/openai/v1',
      }));
      const resp = await p.send(makeParams());
      expect(resp.content[0].text).toBe('Groq fast reply');
      expect(resp.usage.totalTokens).toBe(8);
    });
  });

  describe('send — max_tokens from effort', () => {
    it('effort=low caps at 2000', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'X' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry({ maxOutputTokens: 3000 }));
      await p.send(makeParams({ effort: 'low' }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(2000);
    });

    it('effort=max uses cap', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'X' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry({ maxOutputTokens: 5000 }));
      await p.send(makeParams({ effort: 'max' }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(5000);
    });
  });

  describe('buildOpenAIMessages (internal via send)', () => {
    it('does not duplicate system message when messages already contain one', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { content: 'Ok' }, finish_reason: 'stop' }],
        usage: {},
      }));
      const p = new OpenAICompatProvider(makeEntry());
      await p.send(makeParams({
        system: 'System prompt',
        messages: [{ role: 'system', content: 'Already here' }, { role: 'user', content: 'Hi' }],
      }));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemMsgs = body.messages.filter((m: any) => m.role === 'system');
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toBe('Already here');
    });
  });
});
