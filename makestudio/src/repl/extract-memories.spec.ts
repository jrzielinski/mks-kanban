/**
 * Tests for extract-memories.ts — auto-memory extraction with threshold
 * checks, LLM-based extraction, and JSON parsing helpers.
 *
 * Covers: shouldExtractMemory, markMemExtractionDone, extractAndSaveMemories.
 * Internal helpers (extractJson, isValidMemory, looksLikeMemoryWorthy,
 * escapeYaml, buildFrontmatter) are tested indirectly via
 * extractAndSaveMemories.
 */

const mockGetProvider = jest.fn();

jest.mock('./memory', () => ({
  findRelevant: jest.fn(),
  saveTopic: jest.fn(),
}));

jest.mock('./ai/providers', () => ({
  getProvider: mockGetProvider,
}));

import {
  shouldExtractMemory,
  markMemExtractionDone,
  extractAndSaveMemories,
} from './extract-memories';
import { findRelevant, saveTopic } from './memory';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    usage: { totalTokens: 0 },
    stats: { toolCallsOk: 0 },
    messages: [],
    provider: 'claude',
    ...overrides,
  } as any;
}

function makeChatMessage(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

// ─────────────────────────────────────────────────────────────────────────────
//  shouldExtractMemory
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldExtractMemory', () => {
  it('returns false when no snapshot exists and tokens below init threshold', () => {
    const ctx = makeCtx({ usage: { totalTokens: 5000 } });
    expect(shouldExtractMemory(ctx)).toBe(false);
  });

  it('returns true when no snapshot exists and tokens above init threshold', () => {
    const ctx = makeCtx({ usage: { totalTokens: 15000 } });
    expect(shouldExtractMemory(ctx)).toBe(true);
  });

  it('returns true when no snapshot exists and tokens at exactly threshold', () => {
    const ctx = makeCtx({ usage: { totalTokens: 10000 } });
    expect(shouldExtractMemory(ctx)).toBe(true);
  });

  it('returns false when token growth below threshold regardless of tool calls', () => {
    const ctx = makeCtx({ usage: { totalTokens: 12000 }, stats: { toolCallsOk: 10 } });
    (ctx as any).__lastMemExtract = { totalTokens: 11000, toolCallsOk: 5, ts: Date.now() };
    expect(shouldExtractMemory(ctx)).toBe(false);
  });

  it('returns true when token growth above and tool call growth above threshold', () => {
    const ctx = makeCtx({ usage: { totalTokens: 20000 }, stats: { toolCallsOk: 10 } });
    (ctx as any).__lastMemExtract = { totalTokens: 10000, toolCallsOk: 5, ts: Date.now() };
    expect(shouldExtractMemory(ctx)).toBe(true);
  });

  it('returns true when token growth above and last turn had no tool calls', () => {
    const ctx = makeCtx({ usage: { totalTokens: 20000 }, stats: { toolCallsOk: 5 } });
    (ctx as any).__lastMemExtract = { totalTokens: 10000, toolCallsOk: 5, ts: Date.now() };
    expect(shouldExtractMemory(ctx)).toBe(true);
  });

  it('returns false when token growth above but tool call growth between 0 and threshold', () => {
    const ctx = makeCtx({ usage: { totalTokens: 20000 }, stats: { toolCallsOk: 6 } });
    (ctx as any).__lastMemExtract = { totalTokens: 10000, toolCallsOk: 5, ts: Date.now() };
    expect(shouldExtractMemory(ctx)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  markMemExtractionDone
// ─────────────────────────────────────────────────────────────────────────────
describe('markMemExtractionDone', () => {
  it('sets snapshot with current usage and stats', () => {
    const ctx = makeCtx({ usage: { totalTokens: 50000 }, stats: { toolCallsOk: 42 } });
    markMemExtractionDone(ctx);
    expect(ctx.__lastMemExtract).toBeDefined();
    expect(ctx.__lastMemExtract.totalTokens).toBe(50000);
    expect(ctx.__lastMemExtract.toolCallsOk).toBe(42);
    expect(typeof ctx.__lastMemExtract.ts).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  extractAndSaveMemories
// ─────────────────────────────────────────────────────────────────────────────
describe('extractAndSaveMemories', () => {
  beforeEach(() => {
    mockGetProvider.mockClear();
    (findRelevant as jest.Mock).mockClear();
    (saveTopic as jest.Mock).mockClear();
  });

  it('returns [] when ctx.messages has fewer than 4 entries', async () => {
    const ctx = makeCtx({ messages: [makeChatMessage('user', 'hi')] });
    const result = await extractAndSaveMemories(ctx);
    expect(result).toEqual([]);
  });

  it('returns [] when user text has no memory-worthy signals', async () => {
    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'hello'),
        makeChatMessage('assistant', 'hi there'),
        makeChatMessage('user', 'how are you?'),
        makeChatMessage('assistant', 'good'),
        makeChatMessage('user', 'great weather today'),
      ],
    });
    const result = await extractAndSaveMemories(ctx);
    expect(result).toEqual([]);
  });

  it('returns [] when provider is not available', async () => {
    mockGetProvider.mockReturnValue(null);
    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'rule: always use lowercase'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'prefer short names'),
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'never use tabs'),
      ],
    });
    const result = await extractAndSaveMemories(ctx);
    expect(result).toEqual([]);
  });

  it('returns [] when provider sendMessage returns null', async () => {
    const mockProvider = { sendMessage: jest.fn().mockResolvedValue(null) };
    mockGetProvider.mockReturnValue(mockProvider);
    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'never do deploy without asking'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'hey remember this rule'),
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'always use lowercase branches'),
      ],
    });
    (findRelevant as jest.Mock).mockReturnValue([]);
    const result = await extractAndSaveMemories(ctx);
    expect(result).toEqual([]);
  });

  it('successfully extracts and saves memories', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: '```json\n{"memories":[{"name":"test_rule","description":"Always lowercase branches","type":"feedback","body":"**Why:** user preference\\n**How to apply:** use lowercase"}]}\n```',
        }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);
    (saveTopic as jest.Mock).mockReturnValue(undefined);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'never do deploy without asking'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'hey remember this rule'),
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'always use lowercase branches'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test_rule');
    expect(saveTopic).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test_rule' }),
    );
  });

  it('extracts from naked JSON (no code fences)', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: '{"memories":[{"name":"naked_json","description":"Falls through to naked parser","type":"project","body":"**Why:** test\\n**How to apply:** check"}]}',
        }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);
    (saveTopic as jest.Mock).mockReturnValue(undefined);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'remember this rule always'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'yes'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'use always the same port'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('naked_json');
  });

  it('skips duplicate memories that already exist', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: '{"memories":[{"name":"existing_rule","description":"Already known","type":"feedback","body":"**Why:** test\\n**How to apply:** test"}]}',
        }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([{ name: 'existing_rule', body: 'already there' }]);
    (saveTopic as jest.Mock).mockReturnValue(undefined);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'please remember this rule'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'another message'),
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'test 123'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(result).toHaveLength(0);
    expect(saveTopic).not.toHaveBeenCalled();
  });

  it('skips invalid memory entries from LLM response', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: '{"memories":[{"name":"valid_rule","description":"A valid rule","type":"feedback","body":"**Why:** test\\n**How to apply:** test"},{"name":"","description":"Invalid name","type":"feedback","body":"**Why:** test"}]}',
        }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);
    (saveTopic as jest.Mock).mockReturnValue(undefined);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'remember this one please'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'yes'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'always test before deploy'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid_rule');
  });

  it('handles sendMessage rejection gracefully', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockRejectedValue(new Error('API error')),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'remember this rule please'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'yes'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'always foo'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(result).toEqual([]);
  });

  it('handles non-string message content in transcript building', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"memories":[]}' }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);

    const ctx = makeCtx({
      messages: [
        { role: 'user', content: { parts: ['remember this rule'] } },
        makeChatMessage('assistant', 'ok'),
        { role: 'user', content: ['array content'] },
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'always use lowercase'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles message content longer than 800 chars', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"memories":[]}' }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'x'.repeat(1000)),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'always remember this important rule about code quality'),
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'prefer simplicity'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  it('saves multiple valid memories from LLM response', async () => {
    const mockProvider = {
      sendMessage: jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: '{"memories":[{"name":"rule_one","description":"First rule","type":"feedback","body":"**Why:** test\\n**How to apply:** one"},{"name":"rule_two","description":"Second rule","type":"project","body":"**Why:** test\\n**How to apply:** two"}]}',
        }],
      }),
    };
    mockGetProvider.mockReturnValue(mockProvider);
    (findRelevant as jest.Mock).mockReturnValue([]);
    (saveTopic as jest.Mock).mockReturnValue(undefined);

    const ctx = makeCtx({
      messages: [
        makeChatMessage('user', 'never do X'),
        makeChatMessage('assistant', 'ok'),
        makeChatMessage('user', 'always do Y'),
        makeChatMessage('assistant', 'sure'),
        makeChatMessage('user', 'remember both rules'),
      ],
    });

    const result = await extractAndSaveMemories(ctx);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('rule_one');
    expect(result[1].name).toBe('rule_two');
    expect(saveTopic).toHaveBeenCalledTimes(2);
  });
});
