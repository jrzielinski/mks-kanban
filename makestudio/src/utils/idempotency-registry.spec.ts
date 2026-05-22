import { IdempotencyRegistry } from './idempotency-registry';

describe('IdempotencyRegistry', () => {
  let registry: IdempotencyRegistry;

  beforeEach(() => {
    registry = new IdempotencyRegistry({ maxEntries: 100, ttlMs: 5000 });
  });

  afterEach(() => {
    registry.clear();
  });

  describe('buildKey', () => {
    it('produces deterministic keys for same tool+input', () => {
      const a = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' });
      const b = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' });
      expect(a).toBe(b);
    });

    it('produces different keys for different tools', () => {
      const a = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts' });
      const b = IdempotencyRegistry.buildKey('Bash', { command: 'rm x.ts' });
      expect(a).not.toBe(b);
    });

    it('produces different keys for different inputs', () => {
      const a = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts', old_string: 'a' });
      const b = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts', old_string: 'b' });
      expect(a).not.toBe(b);
    });

    it('is stable regardless of key order in input object', () => {
      const a = IdempotencyRegistry.buildKey('Edit', { new_string: 'b', file_path: 'x.ts', old_string: 'a' });
      const b = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' });
      expect(a).toBe(b);
    });

    it('handles empty input', () => {
      const key = IdempotencyRegistry.buildKey('Read', {});
      expect(key).toHaveLength(64); // SHA-256 hex
    });
  });

  describe('isSideEffectTool', () => {
    it('returns true for Edit', () => {
      expect(IdempotencyRegistry.isSideEffectTool('Edit')).toBe(true);
    });

    it('returns true for Write', () => {
      expect(IdempotencyRegistry.isSideEffectTool('Write')).toBe(true);
    });

    it('returns true for MultiEdit', () => {
      expect(IdempotencyRegistry.isSideEffectTool('MultiEdit')).toBe(true);
    });

    it('returns true for Bash', () => {
      expect(IdempotencyRegistry.isSideEffectTool('Bash')).toBe(true);
    });

    it('returns true for shell_run', () => {
      expect(IdempotencyRegistry.isSideEffectTool('shell_run')).toBe(true);
    });

    it('returns true for ask_user_question', () => {
      expect(IdempotencyRegistry.isSideEffectTool('ask_user_question')).toBe(true);
    });

    it('returns false for Read', () => {
      expect(IdempotencyRegistry.isSideEffectTool('Read')).toBe(false);
    });

    it('returns false for Glob', () => {
      expect(IdempotencyRegistry.isSideEffectTool('Glob')).toBe(false);
    });

    it('returns false for Grep', () => {
      expect(IdempotencyRegistry.isSideEffectTool('Grep')).toBe(false);
    });

    it('returns false for unknown tools', () => {
      expect(IdempotencyRegistry.isSideEffectTool('FooBar')).toBe(false);
    });
  });

  describe('get/set', () => {
    it('returns stored result', () => {
      const key = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts' });
      registry.set(key, 'success');
      expect(registry.get(key)).toBe('success');
    });

    it('returns undefined for missing key', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('deduplicates — second call returns cached result', () => {
      const key = IdempotencyRegistry.buildKey('Bash', { command: 'git push' });
      registry.set(key, 'already pushed');
      expect(registry.get(key)).toBe('already pushed');
    });

    it('expires entries after TTL', async () => {
      const fastRegistry = new IdempotencyRegistry({ maxEntries: 100, ttlMs: 10 });
      const key = IdempotencyRegistry.buildKey('Edit', { file_path: 'y.ts' });
      fastRegistry.set(key, 'cached');
      expect(fastRegistry.get(key)).toBe('cached');
      await new Promise((r) => setTimeout(r, 20));
      expect(fastRegistry.get(key)).toBeUndefined();
      fastRegistry.clear();
    });

    it('updates timestamp on re-set', () => {
      const key = IdempotencyRegistry.buildKey('Edit', { file_path: 'z.ts' });
      registry.set(key, 'v1');
      registry.set(key, 'v2');
      expect(registry.get(key)).toBe('v2');
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when over capacity', () => {
      const small = new IdempotencyRegistry({ maxEntries: 3, ttlMs: 60000 });
      small.set('a', '1');
      small.set('b', '2');
      small.set('c', '3');
      expect(small.size).toBe(3);
      small.set('d', '4');
      // 'a' should be evicted
      expect(small.size).toBe(3);
      expect(small.get('a')).toBeUndefined();
      // 'b', 'c', 'd' should still be there
      expect(small.get('b')).toBe('2');
      expect(small.get('c')).toBe('3');
      expect(small.get('d')).toBe('4');
      small.clear();
    });

    it('bumps key on access (LRU promotion)', () => {
      const small = new IdempotencyRegistry({ maxEntries: 3, ttlMs: 60000 });
      small.set('a', '1');
      small.set('b', '2');
      small.set('c', '3');
      // Access 'a' — it should be promoted
      small.get('a');
      small.set('d', '4');
      // 'b' should be evicted (oldest now), 'a' promoted
      expect(small.get('a')).toBe('1');
      expect(small.get('b')).toBeUndefined();
      expect(small.get('c')).toBe('3');
      expect(small.get('d')).toBe('4');
      small.clear();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const key = IdempotencyRegistry.buildKey('Edit', { file_path: 'x.ts' });
      registry.set(key, 'data');
      expect(registry.size).toBe(1);
      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.get(key)).toBeUndefined();
    });
  });

  describe('singleton', () => {
    it('idempotencyRegistry is importable', () => {
      const { idempotencyRegistry } = require('./idempotency-registry');
      expect(idempotencyRegistry).toBeDefined();
      expect(idempotencyRegistry.size).toBe(0);
    });
  });
});
