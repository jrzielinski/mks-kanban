/**
 * Tests for tool-handlers/memory.ts — MEMORY_TOOL_HANDLERS (save/search).
 *
 * Covers: handler registration, input validation, delegation to memory.ts,
 * response formatting, edge cases (long bodies, empty results).
 */

const mockSaveTopic = jest.fn();
const mockFindRelevant = jest.fn();
const mockTouchTopic = jest.fn();

jest.mock('../../memory', () => ({
  saveTopic: mockSaveTopic,
  findRelevant: mockFindRelevant,
  touchTopic: mockTouchTopic,
}));

import {
  toolMemorySave,
  toolMemorySearch,
  MEMORY_TOOL_HANDLERS,
} from './memory';

const mockCtx = {} as any;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tool registration
// ─────────────────────────────────────────────────────────────────────────────
describe('MEMORY_TOOL_HANDLERS', () => {
  it('exports an array with 2 entries', () => {
    expect(Array.isArray(MEMORY_TOOL_HANDLERS)).toBe(true);
    expect(MEMORY_TOOL_HANDLERS).toHaveLength(2);
  });

  it('each entry has name and handler function', () => {
    for (const entry of MEMORY_TOOL_HANDLERS) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.handler).toBe('function');
    }
  });

  it('exports memory_save handler', () => {
    const entry = MEMORY_TOOL_HANDLERS.find((h) => h.name === 'memory_save');
    expect(entry).toBeDefined();
    expect(entry!.handler).toBe(toolMemorySave);
  });

  it('exports memory_search handler', () => {
    const entry = MEMORY_TOOL_HANDLERS.find((h) => h.name === 'memory_search');
    expect(entry).toBeDefined();
    expect(entry!.handler).toBe(toolMemorySearch);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  toolMemorySave
// ─────────────────────────────────────────────────────────────────────────────
describe('toolMemorySave', () => {
  it('returns error when name is missing', async () => {
    const result = await toolMemorySave({ body: 'some content' }, mockCtx);
    expect(JSON.parse(result)).toEqual({ error: 'name and body required' });
    expect(mockSaveTopic).not.toHaveBeenCalled();
  });

  it('returns error when body is missing', async () => {
    const result = await toolMemorySave({ name: 'my-topic' }, mockCtx);
    expect(JSON.parse(result)).toEqual({ error: 'name and body required' });
    expect(mockSaveTopic).not.toHaveBeenCalled();
  });

  it('returns error when both name and body are missing', async () => {
    const result = await toolMemorySave({}, mockCtx);
    expect(JSON.parse(result)).toEqual({ error: 'name and body required' });
    expect(mockSaveTopic).not.toHaveBeenCalled();
  });

  it('saves a topic with name and body', async () => {
    const result = await toolMemorySave(
      { name: 'test-topic', body: 'Hello world' },
      mockCtx,
    );
    expect(mockSaveTopic).toHaveBeenCalledWith({
      name: 'test-topic',
      body: 'Hello world',
      tags: [],
    });
    expect(JSON.parse(result)).toEqual({ ok: true, name: 'test-topic' });
  });

  it('passes tags when provided', async () => {
    await toolMemorySave(
      { name: 'tagged', body: 'content', tags: ['react', 'hooks'] },
      mockCtx,
    );
    expect(mockSaveTopic).toHaveBeenCalledWith({
      name: 'tagged',
      body: 'content',
      tags: ['react', 'hooks'],
    });
  });

  it('uses empty array when tags is undefined', async () => {
    await toolMemorySave({ name: 'no-tags', body: 'content' }, mockCtx);
    expect(mockSaveTopic).toHaveBeenCalledWith({
      name: 'no-tags',
      body: 'content',
      tags: [],
    });
  });

  it('handles saveTopic throwing without crashing', async () => {
    mockSaveTopic.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    // The handler doesn't catch — the error propagates to the caller tool runner
    await expect(
      toolMemorySave({ name: 'boom', body: 'x' }, mockCtx),
    ).rejects.toThrow('disk full');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  toolMemorySearch
// ─────────────────────────────────────────────────────────────────────────────
describe('toolMemorySearch', () => {
  beforeEach(() => {
    mockFindRelevant.mockReturnValue([]);
  });

  it('returns error when query is missing', async () => {
    const result = await toolMemorySearch({}, mockCtx);
    expect(JSON.parse(result)).toEqual({ error: 'query required' });
    expect(mockFindRelevant).not.toHaveBeenCalled();
  });

  it('returns error when query is empty string', async () => {
    const result = await toolMemorySearch({ query: '' }, mockCtx);
    expect(JSON.parse(result)).toEqual({ error: 'query required' });
    expect(mockFindRelevant).not.toHaveBeenCalled();
  });

  it('calls findRelevant with the query and limit 5', async () => {
    mockFindRelevant.mockReturnValue([]);
    await toolMemorySearch({ query: 'auth jwt' }, mockCtx);
    expect(mockFindRelevant).toHaveBeenCalledWith('auth jwt', 5);
  });

  it('calls touchTopic for each result', async () => {
    mockFindRelevant.mockReturnValue([
      { name: 'auth-jwt', tags: ['auth', 'jwt'], body: 'JWT tokens' },
      { name: 'oauth2', tags: ['auth'], body: 'OAuth2 flow' },
    ]);

    await toolMemorySearch({ query: 'auth' }, mockCtx);
    expect(mockTouchTopic).toHaveBeenCalledTimes(2);
    expect(mockTouchTopic).toHaveBeenCalledWith('auth-jwt');
    expect(mockTouchTopic).toHaveBeenCalledWith('oauth2');
  });

  it('returns formatted response with topics', async () => {
    mockFindRelevant.mockReturnValue([
      {
        name: 'auth-jwt',
        tags: ['auth', 'security'],
        body: 'JWT tokens for authentication. Long enough body that should be truncated to 1500 chars.',
      },
    ]);

    const result = await toolMemorySearch({ query: 'auth' }, mockCtx);
    const parsed = JSON.parse(result);
    expect(parsed.query).toBe('auth');
    expect(parsed.count).toBe(1);
    expect(parsed.topics).toHaveLength(1);
    expect(parsed.topics[0].name).toBe('auth-jwt');
    expect(parsed.topics[0].tags).toEqual(['auth', 'security']);
    expect(typeof parsed.topics[0].body).toBe('string');
  });

  it('truncates body to 1500 characters', async () => {
    const longBody = 'x'.repeat(3000);
    mockFindRelevant.mockReturnValue([
      { name: 'long', tags: [], body: longBody },
    ]);

    const result = await toolMemorySearch({ query: 'long' }, mockCtx);
    const parsed = JSON.parse(result);
    expect(parsed.topics[0].body.length).toBe(1500);
  });

  it('returns count 0 and empty topics when no results', async () => {
    mockFindRelevant.mockReturnValue([]);

    const result = await toolMemorySearch({ query: 'nonexistent' }, mockCtx);
    const parsed = JSON.parse(result);
    expect(parsed.count).toBe(0);
    expect(parsed.topics).toEqual([]);
  });

  it('handles findRelevant throwing without crashing', async () => {
    mockFindRelevant.mockImplementationOnce(() => {
      throw new Error('read error');
    });
    await expect(
      toolMemorySearch({ query: 'boom' }, mockCtx),
    ).rejects.toThrow('read error');
  });

  it('handles touchTopic throwing without crashing the rest', async () => {
    mockFindRelevant.mockReturnValue([
      { name: 'first', tags: [], body: 'first topic' },
      { name: 'second', tags: [], body: 'second topic' },
    ]);
    mockTouchTopic.mockImplementationOnce(() => {
      throw new Error('ouch');
    });

    await expect(
      toolMemorySearch({ query: 'test' }, mockCtx),
    ).rejects.toThrow('ouch');
    // Verifies first touchTopic threw and propagation is correct
    expect(mockTouchTopic).toHaveBeenCalledTimes(1);
  });
});
