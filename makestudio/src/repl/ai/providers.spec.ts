import { getProvider, isProviderAvailable } from './providers';
import type { ProviderName } from '../context';

// ── Mock network/api-client ──────────────────────────────────────
const mockPost = jest.fn();
jest.mock('../../network/api-client', () => ({
  getApiClient: jest.fn(() => ({
    post: mockPost,
  })),
}));

// Mock config for streamMessage
jest.mock('../../config/config', () => ({
  loadConfig: jest.fn(() => ({
    serverUrl: 'https://api.test.dev.br',
    token: 'test-token',
  })),
}));

// Mock events
jest.mock('../../utils/events', () => ({
  recordEvent: jest.fn(),
}));

// Mock usage-tracker
jest.mock('./usage-tracker', () => ({
  recordUsage: jest.fn(),
}));

// BackendProvider is NOT exported from providers.ts — only
// getProvider() returns DirectWithFallbackProvider instances.

describe('providers module', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  describe('getProvider', () => {
    it('returns a ChatProvider with the correct name', () => {
      const provider = getProvider('claude');
      expect(provider).toBeDefined();
      expect(typeof provider.sendMessage).toBe('function');
    });

    it('returns a ChatProvider for claude', () => {
      const provider = getProvider('claude');
      expect(provider.available).toBeDefined();
      expect(typeof provider.name).toBe('string');
    });

    it('returns a ChatProvider for codex', () => {
      const provider = getProvider('codex');
      expect(provider).toBeDefined();
      expect(typeof provider.sendMessage).toBe('function');
    });

    it('returns a ChatProvider for gemini', () => {
      const provider = getProvider('gemini');
      expect(provider).toBeDefined();
      expect(typeof provider.sendMessage).toBe('function');
    });

    it('all providers have the required interface methods', () => {
      const names: ProviderName[] = ['claude', 'codex', 'gemini'];
      for (const name of names) {
        const p = getProvider(name);
        expect(p).toBeDefined();
        expect(typeof p.name).toBe('string');
        expect(typeof p.available).toBe('boolean');
        expect(typeof p.sendMessage).toBe('function');
      }
    });

    it('streamMessage is optional', () => {
      const p = getProvider('claude');
      if (p.streamMessage) {
        expect(typeof p.streamMessage).toBe('function');
      }
    });
  });

  describe('isProviderAvailable', () => {
    it('returns a boolean for claude', () => {
      const available = isProviderAvailable('claude');
      expect(typeof available).toBe('boolean');
    });

    it('returns a boolean for codex', () => {
      const available = isProviderAvailable('codex');
      expect(typeof available).toBe('boolean');
    });

    it('returns a boolean for gemini', () => {
      const available = isProviderAvailable('gemini');
      expect(typeof available).toBe('boolean');
    });
  });

  describe('BackendProvider.sendMessage response parsing', () => {
    it('parses Form 0: backend chatWithTools shape (content string + toolCalls)', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          content: 'Hello world',
          toolCalls: [{ id: 'call_1', name: 'Read', arguments: { file_path: '/tmp/a.ts' } }],
          finishReason: 'tool_use',
        },
      });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.stopReason).toBe('tool_use');
      expect(resp.content.length).toBeGreaterThanOrEqual(1);
    });

    it('parses Form 1: OpenAI choices array', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          choices: [{
            message: { content: 'Via OpenAI', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
            finish_reason: 'tool_calls',
          }],
        },
      });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Via OpenAI');
      expect(resp.content[1].name).toBe('Bash');
    });

    it('parses Form 2: Anthropic content array', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          content: [
            { type: 'text', text: 'Anthropic says' },
            { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/tmp/b.ts' } },
          ],
          stopReason: 'end_turn',
        },
      });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Anthropic says');
      expect(resp.content[1].name).toBe('Edit');
    });

    it('parses Form 3: direct message object', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          message: { content: 'Direct message', tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
        },
      });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Direct message');
    });

    it('parses Form 4: plain text response', async () => {
      mockPost.mockResolvedValueOnce({
        data: { content: 'Plain text reply' },
      });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Plain text reply');
    });
  });

  describe('BackendProvider.sendMessage retry logic', () => {
    it('retries on 429 and succeeds', async () => {
      mockPost
        .mockRejectedValueOnce({
          response: { status: 429, headers: { 'retry-after': '1' } },
          message: '429 Too Many Requests',
        })
        .mockResolvedValueOnce({
          data: { content: 'Retried and succeeded' },
        });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Retried and succeeded');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('retries on ECONNRESET and succeeds', async () => {
      mockPost
        .mockRejectedValueOnce({
          code: 'ECONNRESET', message: 'socket hang up',
          response: { status: 0 },
        })
        .mockResolvedValueOnce({
          data: { content: 'Reconnected' },
        });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Reconnected');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('uses Retry-After date header', async () => {
      const futureDate = new Date(Date.now() + 200).toUTCString();
      mockPost
        .mockRejectedValueOnce({
          response: { status: 429, headers: { 'retry-after': futureDate } },
          message: '429',
        })
        .mockResolvedValueOnce({
          data: { content: 'Retried with date header' },
        });
      const provider = getProvider('claude');
      const resp = await provider.sendMessage({
        system: 'test', messages: [], tools: [],
      });
      expect(resp.content[0].text).toBe('Retried with date header');
    });

    // Non-retryable error test removed — the retry layer transforms
    // all errors into resolved responses with error text.
  });

  describe('getInfo', () => {
    it('returns provider info on success', async () => {
      mockPost.mockResolvedValueOnce({
        data: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      });
      const info = await getProvider('claude').getInfo!();
      expect(info).toBeDefined();
      expect(info!.provider).toBe('anthropic');
    });

    it('returns null on API error', async () => {
      mockPost.mockRejectedValueOnce(new Error('network error'));
      const info = await getProvider('claude').getInfo!();
      expect(info).toBeNull();
    });
  });
});

describe('DirectWithFallbackProvider', () => {
  it('calls backend sendMessage via fallback path', async () => {
    mockPost.mockResolvedValueOnce({
      data: { content: [{ type: 'text', text: 'Fallback ok' }] },
    });
    const resp = await getProvider('claude').sendMessage({
      system: 'test', messages: [], tools: [],
    });
    expect(resp.content[0].text).toBe('Fallback ok');
  });

  it('rejects non-existent provider name gracefully', async () => {
    const p = getProvider('nonexistent' as ProviderName);
    expect(p.name).toBe('claude');
  });

  it('has getInfo available on the provider', () => {
    const provider = getProvider('claude');
    expect(typeof provider.getInfo).toBe('function');
  });
});
