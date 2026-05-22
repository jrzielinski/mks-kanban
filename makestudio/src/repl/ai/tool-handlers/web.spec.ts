import { execSync } from 'child_process';

jest.mock('axios', () => ({ get: jest.fn() }));

jest.mock('../web-guard', () => ({
  guardFetchUrl: jest.fn(),
}));

const mockSendSmall = jest.fn();
const mockSendMessage = jest.fn();
jest.mock('../providers', () => ({
  getProvider: jest.fn(() => ({
    sendSmall: mockSendSmall,
    sendMessage: mockSendMessage,
  })),
}));

const mockAxiosGet = require('axios').get as jest.Mock;
const { guardFetchUrl } = jest.mocked(require('../web-guard'));

const makeCtx = (overrides?: Record<string, any>) => ({
  user: { tenantId: 'test-tenant' },
  provider: 'claude',
  ...overrides,
});

describe('web.ts — toolWebSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns error when input.query is missing', async () => {
    const mod = require('./web');
    const result = await mod.toolWebSearch({}, makeCtx());
    expect(JSON.parse(result)).toEqual({ error: 'query is required' });
  });

  it('returns error when input.query is empty string', async () => {
    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: '' }, makeCtx());
    expect(JSON.parse(result)).toEqual({ error: 'query is required' });
  });

  it('performs a search and extracts results from HTML', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=abc">Example Title</a>
      <a class="result__snippet">Example snippet &amp; more</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.com&rut=def">Other Title</a>
      <a class="result__snippet">Other <b>snippet</b> content</a>
    `;
    mockAxiosGet.mockResolvedValueOnce({ data: html });

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test' }, makeCtx());
    const parsed = JSON.parse(result);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://duckduckgo.com/html/?q=test',
      expect.objectContaining({ timeout: 15_000 })
    );
    expect(parsed.count).toBe(2);
    expect(parsed.query).toBe('test');
    expect(parsed.results[0].title).toBe('Example Title');
    expect(parsed.results[0].snippet).toBe('Example snippet & more');
    expect(parsed.results[0].url).toBe('https://example.com');
    expect(parsed.results[1].title).toBe('Other Title');
    expect(parsed.results[1].snippet).toBe('Other snippet content');
  });

  it('filters results by allowed_domains', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
      <a class="result__snippet">Snippet 1</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.net">Other</a>
      <a class="result__snippet">Snippet 2</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsub.example.com">Sub</a>
      <a class="result__snippet">Snippet 3</a>
    `;
    mockAxiosGet.mockResolvedValueOnce({ data: html });

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test', allowed_domains: ['example.com'] }, makeCtx());
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(2); // example.com + sub.example.com
    expect(parsed.results[0].url).toBe('https://example.com');
    expect(parsed.results[1].url).toBe('https://sub.example.com');
  });

  it('filters results by blocked_domains', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
      <a class="result__snippet">Snipper 1</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.com">Bad</a>
      <a class="result__snippet">Snipper 2</a>
    `;
    mockAxiosGet.mockResolvedValueOnce({ data: html });

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test', blocked_domains: ['bad.com'] }, makeCtx());
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.results[0].url).toBe('https://example.com');
  });

  it('handles URL parsing failures in domain filter gracefully', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=invalid-url">Invalid</a>
      <a class="result__snippet">Snippet 1</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvalid.com">Valid</a>
      <a class="result__snippet">Snippet 2</a>
    `;
    mockAxiosGet.mockResolvedValueOnce({ data: html });

    const mod = require('./web');
    // Provide allowed_domains to trigger the filter path
    const result = await mod.toolWebSearch({ query: 'test', allowed_domains: ['valid.com'] }, makeCtx());
    const parsed = JSON.parse(result);

    // Invalid URL filtered out by domain filter (new URL throws), valid one passes
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].url).toBe('https://valid.com');
  });

  it('limits results to 10', async () => {
    const items: string[] = [];
    for (let i = 0; i < 15; i++) {
      items.push(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsite${i}.com">Site ${i}</a>
      <a class="result__snippet">Snippet ${i}</a>`);
    }
    mockAxiosGet.mockResolvedValueOnce({ data: items.join('\n') });

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test' }, makeCtx());
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(10);
    expect(parsed.results.length).toBe(10);
  });

  it('handles HTTP errors gracefully', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('Network error'));

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test' }, makeCtx());
    expect(result).toContain('Web search failed');
  });

  it('handles empty HTML response', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: '' });

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test' }, makeCtx());
    const parsed = JSON.parse(result);
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it('handles HTML with no matching result blocks', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: '<html><body>No results</body></html>' });

    const mod = require('./web');
    const result = await mod.toolWebSearch({ query: 'test' }, makeCtx());
    const parsed = JSON.parse(result);
    expect(parsed.count).toBe(0);
  });
});

describe('web.ts — toolWebFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (guardFetchUrl as jest.Mock).mockResolvedValue({ ok: true });
  });

  it('returns error when input.url is missing', async () => {
    const mod = require('./web');
    const result = await mod.toolWebFetch({}, makeCtx());
    expect(JSON.parse(result)).toEqual({ error: 'url is required' });
  });

  it('returns error for invalid URL scheme', async () => {
    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'ftp://example.com' }, makeCtx());
    expect(JSON.parse(result)).toEqual({ error: 'url must start with http:// or https://' });
  });

  it('returns error when SSRF guard blocks', async () => {
    (guardFetchUrl as jest.Mock).mockResolvedValueOnce({ ok: false, reason: 'blocked by SSRF guard' });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://localhost:3000' }, makeCtx());
    expect(result).toContain('blocked by SSRF guard');
  });

  it('falls through when guard module throws', async () => {
    (guardFetchUrl as jest.Mock).mockRejectedValueOnce(new Error('guard error'));
    mockAxiosGet.mockResolvedValueOnce({ data: 'plain text content' });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());

    // Should proceed despite guard error
    expect(result).toBe('plain text content');
  });

  it('fetches and strips HTML content', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: '<html><head><style>.cls{}</style></head><body><script>alert(1)</script><nav>Menu</nav><header>Header</header><footer>Footer</footer><main>Hello World</main></body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());
    expect(result).toContain('Hello World');
    expect(result).not.toContain('alert(1)');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<style>');
    expect(result).not.toContain('<nav>');
  });

  it('detects HTML by content when no content-type header', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: '<!DOCTYPE html><html><body>Hello</body></html>',
      headers: {},
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());
    expect(result).toContain('Hello');
  });

  it('returns non-HTML content as-is', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: '{"key": "value"}',
      headers: { 'content-type': 'application/json' },
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com/data.json' }, makeCtx());
    expect(result).toContain('key');
  });

  it('handles non-string data by JSON-stringifying', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { key: 'value' },
      headers: { 'content-type': 'application/json' },
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());
    expect(result).toContain('value');
  });

  it('uses prompt-based extraction when prompt is provided', async () => {
    mockSendSmall.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Extracted info' }],
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: '<html><body>Long content here with relevant data</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com', prompt: 'find the data' }, makeCtx());

    expect(mockSendSmall).toHaveBeenCalled();
    expect(result).toBe('Extracted info');
  });

  it('falls back to raw content when prompt extraction fails', async () => {
    mockSendSmall.mockResolvedValueOnce({
      content: [{ type: 'text', text: '' }],
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: '<html><body>Raw fallback content</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com', prompt: 'find data' }, makeCtx());

    expect(result).toContain('Raw fallback content');
  });

  it('falls back when provider has no sendSmall', async () => {
    const { getProvider } = require('../providers');
    (getProvider as jest.Mock).mockReturnValueOnce({
      sendMessage: mockSendMessage,
    });
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Extracted by sendMessage' }],
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: '<html><body>Content</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com', prompt: 'find' }, makeCtx());

    expect(mockSendMessage).toHaveBeenCalled();
    expect(result).toBe('Extracted by sendMessage');
  });

  it('handles HTTP errors gracefully', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('Connection refused'));

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());
    expect(result).toContain('Fetch failed');
    expect(result).toContain('Connection refused');
  });

  it('handles guard throwing and still fetches', async () => {
    (guardFetchUrl as jest.Mock).mockRejectedValueOnce(new Error('guard crashed'));
    mockAxiosGet.mockResolvedValueOnce({ data: 'content after guard crash' });

    const mod = require('./web');
    const result = await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());
    expect(result).toBe('content after guard crash');
  });

  it('respects 5MB max content length via axios config', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: 'small content' });

    const mod = require('./web');
    await mod.toolWebFetch({ url: 'http://example.com/large' }, makeCtx());

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://example.com/large',
      expect.objectContaining({ maxContentLength: 5 * 1024 * 1024 })
    );
  });

  it('limits redirects to 3', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: 'redirected content' });

    const mod = require('./web');
    await mod.toolWebFetch({ url: 'http://example.com' }, makeCtx());

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://example.com',
      expect.objectContaining({ maxRedirects: 3 })
    );
  });
});

describe('WEB_TOOL_HANDLERS', () => {
  it('exports the handlers array', () => {
    const mod = require('./web');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    expect(key).toBeDefined();
    // @ts-ignore
    expect(Array.isArray(mod[key])).toBe(true);
  });

  it('each handler entry has name and function', () => {
    const mod = require('./web');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    // @ts-ignore
    for (const entry of mod[key]) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.handler).toBe('function');
    }
  });

  it('references the actual exported functions', () => {
    const mod = require('./web');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    // @ts-ignore
    const entry = mod[key][0];
    expect(entry.name).toBe('web_search');
    expect(entry.handler).toBe(mod.toolWebSearch);
  });
});
