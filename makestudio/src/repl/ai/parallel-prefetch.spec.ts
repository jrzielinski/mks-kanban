import { maybePrefetchReadOnly, consumePrefetched, clearPrefetchCache, resetParallelPrefetchCache } from './parallel-prefetch';

// Mock executeTool so the spec doesn't need real disk I/O.
jest.mock('./tools', () => ({
  executeTool: jest.fn(async (name: string, input: any) => {
    if (input?.shouldThrow) throw new Error('mock failure: ' + input.shouldThrow);
    return `result of ${name}(${JSON.stringify(input)})`;
  }),
}));

describe('parallel-prefetch', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_PARALLEL_READ;
    resetParallelPrefetchCache();
    jest.clearAllMocks();
  });

  describe('maybePrefetchReadOnly — disabled by default', () => {
    it('does nothing when env var is unset', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
      ];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual([]);
      expect(ctx.__prefetchCache).toBeUndefined();
    });
  });

  describe('maybePrefetchReadOnly — enabled', () => {
    beforeEach(() => {
      process.env.MAKESTUDIO_PARALLEL_READ = '1';
      resetParallelPrefetchCache();
    });

    it('prefetches multiple Read tools and stashes results in cache', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
        { id: 't3', name: 'Read', input: { file_path: '/c' } },
      ];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual(['t1', 't2', 't3']);
      expect(ctx.__prefetchCache.size).toBe(3);
      expect(ctx.__prefetchCache.get('t1').result).toContain('Read');
    });

    it('prefetches Glob and Grep alongside Read', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Glob', input: { pattern: '**/*.ts' } },
        { id: 't2', name: 'Grep', input: { pattern: 'foo' } },
      ];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual(['t1', 't2']);
    });

    it('does NOT prefetch a single tool (no parallelism benefit)', async () => {
      const ctx: any = {};
      const tools = [{ id: 't1', name: 'Read', input: { file_path: '/a' } }];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual([]);
    });

    it('does NOT prefetch mutating tools (Edit/Write/Bash)', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } },
        { id: 't2', name: 'Write', input: { file_path: '/b', content: 'x' } },
        { id: 't3', name: 'Bash', input: { command: 'ls' } },
      ];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual([]);
    });

    it('mixed batch — only read-only subset prefetched', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a' } },
        { id: 't2', name: 'Edit', input: { file_path: '/x', old_string: 'a', new_string: 'b' } },
        { id: 't3', name: 'Glob', input: { pattern: '**/*.ts' } },
      ];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual(['t1', 't3']);
      expect(ctx.__prefetchCache.size).toBe(2);
    });

    it('caches errors so dispatcher can re-throw them', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a', shouldThrow: 'boom' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
      ];
      await maybePrefetchReadOnly(tools, ctx);
      const e1 = ctx.__prefetchCache.get('t1');
      expect(e1.error).toBeDefined();
      expect(String(e1.error.message)).toContain('boom');
      expect(ctx.__prefetchCache.get('t2').result).toBeDefined();
    });

    it('skips tools already in cache (idempotent)', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
      ];
      await maybePrefetchReadOnly(tools, ctx);
      const sizeAfter1 = ctx.__prefetchCache.size;
      await maybePrefetchReadOnly(tools, ctx);
      // Cache stays the same — calls weren't re-prefetched.
      expect(ctx.__prefetchCache.size).toBe(sizeAfter1);
    });

    it('skips MCP-prefixed tools (unknown semantics)', async () => {
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'mcp.read', input: {} },
        { id: 't2', name: 'mcp.search', input: {} },
      ];
      const ids = await maybePrefetchReadOnly(tools, ctx);
      expect(ids).toEqual([]);
    });
  });

  describe('consumePrefetched', () => {
    it('returns and removes the entry', async () => {
      process.env.MAKESTUDIO_PARALLEL_READ = '1';
      resetParallelPrefetchCache();
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
      ];
      await maybePrefetchReadOnly(tools, ctx);
      expect(ctx.__prefetchCache.size).toBe(2);
      const e = consumePrefetched(ctx, 't1');
      expect(e).toBeDefined();
      expect(e?.result).toContain('Read');
      expect(ctx.__prefetchCache.size).toBe(1);
      // Second consume of the same id — miss.
      expect(consumePrefetched(ctx, 't1')).toBeNull();
    });

    it('returns null for unknown id', () => {
      const ctx: any = {};
      expect(consumePrefetched(ctx, 'nope')).toBeNull();
    });

    it('returns null when no cache exists', () => {
      const ctx: any = {};
      expect(consumePrefetched(ctx, 't1')).toBeNull();
    });
  });

  describe('clearPrefetchCache', () => {
    it('empties the cache', async () => {
      process.env.MAKESTUDIO_PARALLEL_READ = '1';
      resetParallelPrefetchCache();
      const ctx: any = {};
      const tools = [
        { id: 't1', name: 'Read', input: { file_path: '/a' } },
        { id: 't2', name: 'Read', input: { file_path: '/b' } },
      ];
      await maybePrefetchReadOnly(tools, ctx);
      clearPrefetchCache(ctx);
      expect(ctx.__prefetchCache.size).toBe(0);
    });

    it('is safe to call when cache does not exist', () => {
      const ctx: any = {};
      expect(() => clearPrefetchCache(ctx)).not.toThrow();
    });
  });
});
