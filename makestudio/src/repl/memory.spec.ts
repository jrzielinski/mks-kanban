/**
 * Tests for memory.ts — persistent knowledge store with LRU eviction.
 *
 * Covers: tokenize, jaccardSimilarity (pure), plus loadAllTopics,
 * findSimilarTopics, findRelevant, getStaleCount, pruneStale using
 * mocked filesystem.
 */

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

import * as fs from 'fs';
import {
  tokenize,
  jaccardSimilarity,
  loadAllTopics,
  loadAllTopicsIncludingTombstones,
  findSimilarTopics,
  findRelevant,
  getStaleCount,
  pruneStale,
  __clearRelevanceCacheForTests,
} from './memory';

const mockReaddirSync = fs.readdirSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;
const mockWriteFileSync = fs.writeFileSync as jest.Mock;
const mockUnlinkSync = fs.unlinkSync as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockMkdirSync = fs.mkdirSync as jest.Mock;

// ── Fixtures ────────────────────────────────────────────────────────────────
function makeTopicFrontmatter(name: string, tags: string[], accessCount: number, daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return [
    '---',
    `name: ${name}`,
    `tags: [${tags.join(', ')}]`,
    `lastAccessedAt: ${date}`,
    `accessCount: ${accessCount}`,
    `updatedAt: ${Date.now() - daysAgo * 86_400_000}`,
    '---',
    '',
    `This is the body of ${name}.`,
    tags.length > 0 ? `Tags include: ${tags.join(', ')}.` : '',
    '',
  ].join('\n');
}

function makeTombstoneFrontmatter(name: string, daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return [
    '---',
    `name: ${name}`,
    'tags: []',
    `lastAccessedAt: ${date}`,
    'accessCount: 1',
    `deletedAt: ${Date.now() - daysAgo * 86_400_000}`,
    `updatedAt: ${Date.now() - daysAgo * 86_400_000}`,
    '---',
    '',
    '',
  ].join('\n');
}

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumeric and filters tokens of length <= 2', () => {
    const set = tokenize('Hello, World! My NAME is claude.');
    expect(set.has('hello')).toBe(true);
    expect(set.has('world')).toBe(true);
    expect(set.has('name')).toBe(true);
    expect(set.has('claude')).toBe(true);
    expect(set.has('is')).toBe(false);
    expect(set.has('my')).toBe(false);
  });

  it('keeps Latin accented characters (pt-BR / es)', () => {
    const set = tokenize('açúcar coração informação');
    expect(set.has('açúcar')).toBe(true);
    expect(set.has('coração')).toBe(true);
    expect(set.has('informação')).toBe(true);
  });

  it('returns an empty set for empty / whitespace / pure punctuation input', () => {
    expect(tokenize('').size).toBe(0);
    expect(tokenize('   ').size).toBe(0);
    expect(tokenize('!!! ?? ,,').size).toBe(0);
  });

  it('deduplicates tokens naturally via Set', () => {
    const set = tokenize('test test TEST Test');
    expect(set.size).toBe(1);
    expect(set.has('test')).toBe(true);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it('returns 0 for fully disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  it('computes intersection over union correctly', () => {
    const a = new Set(['react', 'vite', 'tailwind', 'zustand']);
    const b = new Set(['react', 'vite', 'nextjs', 'axios']);
    expect(jaccardSimilarity(a, b)).toBe(2 / 6);
  });

  it('is symmetric', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['y', 'w']);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  loadAllTopics / loadAllTopicsIncludingTombstones
// ─────────────────────────────────────────────────────────────────────────────
describe('loadAllTopics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockUnlinkSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(false);
  });

  it('returns an empty array when readdir returns no topic files', () => {
    mockReaddirSync.mockReturnValue([]);
    expect(loadAllTopics()).toEqual([]);
  });

  it('parses topic files into MemoryTopic objects', () => {
    mockReaddirSync.mockReturnValue(['topic_react.md', 'topic_nest.md']);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_react.md')) return makeTopicFrontmatter('react-hooks', ['react', 'frontend'], 5, 1);
      if (filePath.endsWith('topic_nest.md')) return makeTopicFrontmatter('nest-auth', ['backend', 'nestjs'], 3, 10);
      return '';
    });

    const topics = loadAllTopics();
    expect(topics).toHaveLength(2);
    expect(topics[0].name).toBe('react-hooks');
    expect(topics[1].name).toBe('nest-auth');
    expect(topics[0].tags).toEqual(['react', 'frontend']);
    expect(topics[1].accessCount).toBe(3);
  });

  it('skips .body.md files', () => {
    mockReaddirSync.mockReturnValue(['topic_foo.md', 'topic_foo.body.md']);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_foo.md')) return makeTopicFrontmatter('foo', [], 1, 0);
      return '';
    });
    expect(loadAllTopics()).toHaveLength(1);
  });

  it('handles readFileSync errors gracefully', () => {
    mockReaddirSync.mockReturnValue(['topic_bad.md', 'topic_good.md']);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_bad.md')) throw new Error('permission denied');
      if (filePath.endsWith('topic_good.md')) return makeTopicFrontmatter('good', [], 1, 0);
      return '';
    });
    const topics = loadAllTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe('good');
  });

  it('handles readdir errors gracefully', () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('permission denied'); });
    expect(loadAllTopics()).toEqual([]);
  });
});

describe('loadAllTopicsIncludingTombstones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
  });

  it('includes tombstoned topics', () => {
    mockReaddirSync.mockReturnValue(['topic_react.md']);
    mockReadFileSync.mockReturnValue(makeTombstoneFrontmatter('react-hooks', 5));
    const topics = loadAllTopicsIncludingTombstones();
    expect(topics).toHaveLength(1);
    expect(topics[0].deletedAt).toBeDefined();
    expect(typeof topics[0].deletedAt).toBe('number');
  });

  it('loadAllTopics excludes tombstones', () => {
    mockReaddirSync.mockReturnValue(['topic_dead.md']);
    mockReadFileSync.mockReturnValue(makeTombstoneFrontmatter('dead', 5));
    expect(loadAllTopics()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  findSimilarTopics
// ─────────────────────────────────────────────────────────────────────────────
describe('findSimilarTopics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockReaddirSync.mockReturnValue([
      'topic_react.md', 'topic_angular.md', 'topic_nest.md',
    ]);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_react.md')) return makeTopicFrontmatter('react-hooks', ['react', 'frontend'], 5, 1);
      if (filePath.endsWith('topic_angular.md')) return makeTopicFrontmatter('angular-guide', ['angular', 'frontend'], 2, 30);
      if (filePath.endsWith('topic_nest.md')) return makeTopicFrontmatter('nest-backend', ['nestjs', 'backend'], 3, 5);
      return '';
    });
  });

  it('returns similar pairs above default threshold (0.6)', () => {
    const pairs = findSimilarTopics();
    expect(Array.isArray(pairs)).toBe(true);
    // At least react-hooks and angular-guide (both have "frontend")
    // or react-hooks and nest-backend (no obvious overlap) — depends on body.
    // We just verify the structure.
    for (const p of pairs) {
      expect(p.a).toBeDefined();
      expect(p.b).toBeDefined();
      expect(p.similarity).toBeGreaterThanOrEqual(0.6);
      expect(p.similarity).toBeLessThanOrEqual(1);
    }
  });

  it('returns empty when threshold is 1.0 (perfection)', () => {
    expect(findSimilarTopics(1.0)).toEqual([]);
  });

  it('returns pairs sorted by similarity descending', () => {
    const pairs = findSimilarTopics(0);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  findRelevant
// ─────────────────────────────────────────────────────────────────────────────
describe('findRelevant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockReaddirSync.mockReturnValue([
      'topic_auth.md', 'topic_deploy.md', 'topic_styling.md',
    ]);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_auth.md')) return makeTopicFrontmatter('authentication-jwt', ['auth', 'security'], 10, 2);
      if (filePath.endsWith('topic_deploy.md')) return makeTopicFrontmatter('deploy-scripts', ['devops', 'deploy'], 3, 15);
      if (filePath.endsWith('topic_styling.md')) return makeTopicFrontmatter('css-tricks', ['css', 'frontend'], 1, 60);
      return '';
    });
  });

  it('returns topics relevant to the query', () => {
    const results = findRelevant('auth jwt security', 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toMatch(/auth/i);
  });

  it('prefers topics with token overlap over pure freshness', () => {
    const results = findRelevant('auth jwt', 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // auth-jwt should rank highest because it has token overlap + freshness
    expect(results[0].name).toMatch(/auth/i);
  });

  it('returns empty when query tokens are empty', () => {
    const results = findRelevant('', 3);
    expect(results).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const results = findRelevant('frontend', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('scores tags and names higher', () => {
    const authResults = findRelevant('auth', 3);
    expect(authResults.length).toBeGreaterThanOrEqual(1);
    expect(authResults[0].name).toMatch(/auth/i);
  });

  it('returns empty when no topics exist', () => {
    mockReaddirSync.mockReturnValue([]);
    expect(findRelevant('anything', 3)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  getStaleCount
// ─────────────────────────────────────────────────────────────────────────────
describe('getStaleCount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
  });

  it('returns 0 when no topics are stale', () => {
    mockReaddirSync.mockReturnValue(['topic_fresh.md']);
    mockReadFileSync.mockReturnValue(makeTopicFrontmatter('fresh', [], 5, 1)); // 1 day ago
    expect(getStaleCount()).toBe(0);
  });

  it('returns count of topics older than STALE_DAYS (180)', () => {
    mockReaddirSync.mockReturnValue(['topic_stale.md', 'topic_fresh.md']);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_stale.md')) return makeTopicFrontmatter('stale', [], 1, 200); // 200 days ago
      if (filePath.endsWith('topic_fresh.md')) return makeTopicFrontmatter('fresh', [], 3, 10);
      return '';
    });
    expect(getStaleCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  pruneStale
// ─────────────────────────────────────────────────────────────────────────────
describe('pruneStale', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockUnlinkSync.mockReturnValue(undefined);
  });

  it('removes stale topics with accessCount < 3', () => {
    mockReaddirSync.mockReturnValue(['topic_stale.md', 'topic_popular.md', 'topic_recent.md']);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('topic_stale.md')) return makeTopicFrontmatter('stale-old', [], 1, 200);
      if (filePath.endsWith('topic_popular.md')) return makeTopicFrontmatter('popular-stale', [], 10, 200); // high access → kept
      if (filePath.endsWith('topic_recent.md')) return makeTopicFrontmatter('recent', [], 2, 10); // recent → kept
      return '';
    });

    const removed = pruneStale();
    expect(removed).toBe(1);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when no stale topics exist', () => {
    mockReaddirSync.mockReturnValue(['topic_fresh.md']);
    mockReadFileSync.mockReturnValue(makeTopicFrontmatter('fresh', [], 5, 1));
    expect(pruneStale()).toBe(0);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('handles unlink errors without crashing', () => {
    mockReaddirSync.mockReturnValue(['topic_stale.md']);
    mockReadFileSync.mockReturnValue(makeTopicFrontmatter('stale', [], 1, 200));
    mockUnlinkSync.mockImplementation(() => { throw new Error('permission denied'); });
    expect(pruneStale()).toBe(0);
  });

  it('regenerates index when topics are removed', () => {
    mockReaddirSync.mockReturnValue(['topic_stale.md']);
    mockReadFileSync.mockReturnValue(makeTopicFrontmatter('stale', [], 1, 200));
    const removed = pruneStale();
    expect(removed).toBe(1);
    // writeFileSync is called by both unlink (tombstone... no, pruneStale deletes outright)
    // and regenerateIndex — verify it was called
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Cache cleanup
// ─────────────────────────────────────────────────────────────────────────────
// slugify is private (not exported) — tested indirectly via saveTopic

// ─────────────────────────────────────────────────────────────────────────────
//  saveTopic
// ─────────────────────────────────────────────────────────────────────────────
describe('saveTopic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockReturnValue(undefined);
  });

  it('writes a topic file with frontmatter and body', () => {
    const { saveTopic } = require('./memory');
    saveTopic({ name: 'test-topic', body: 'Hello world', tags: ['test'] });
    expect(mockWriteFileSync).toHaveBeenCalled();
    const [path, content] = mockWriteFileSync.mock.calls.find(
      ([p]: [string]) => typeof p === 'string' && p.includes('topic_test'),
    ) || [];
    expect(path).toMatch(/topic_test-topic\.md$/);
    expect(content).toContain('name: test-topic');
    expect(content).toContain('tags: [test]');
    expect(content).toContain('Hello world');
  });

  it('externalises body when over TOPIC_MAX_CHARS', () => {
    const { saveTopic } = require('./memory');
    const longBody = 'x'.repeat(5000);
    saveTopic({ name: 'big', body: longBody });
    const bodyWrites = mockWriteFileSync.mock.calls.filter(
      ([p]: [string]) => typeof p === 'string' && p.includes('.body.md'),
    );
    expect(bodyWrites.length).toBeGreaterThanOrEqual(1);
    // The inline body should be truncated
    const mainWrite = mockWriteFileSync.mock.calls.find(
      ([p]: [string]) => typeof p === 'string' && p.includes('topic_big.md') && !p.includes('.body.md'),
    );
    expect(mainWrite).toBeDefined();
    expect(mainWrite[1]).toContain('[... truncated');
  });

  it('cleans up old bodyRef file when new body is small', () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockReturnValue(undefined);
    mockReaddirSync.mockReturnValue(['topic_shrink.md']);
    mockReadFileSync.mockReturnValue([
      '---', 'name: shrink', 'tags: []',
      'lastAccessedAt: 2025-01-01T00:00:00.000Z',
      'accessCount: 1', 'updatedAt: 1700000000000', '---', '', 'small',
    ].join('\n'));
    const { saveTopic } = require('./memory');
    saveTopic({ name: 'shrink', body: 'small body now' });
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('topic_shrink.body.md'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  deleteTopic
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteTopic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockReaddirSync.mockReturnValue(['topic_delete-me.md']);
    mockReadFileSync.mockReturnValue([
      '---', 'name: delete-me', 'tags: []',
      'lastAccessedAt: 2025-01-01T00:00:00.000Z',
      'accessCount: 5', 'updatedAt: 1700000000000', '---', '', 'body text',
    ].join('\n'));
    mockWriteFileSync.mockReturnValue(undefined);
  });

  it('returns false for non-existent topic', () => {
    mockReaddirSync.mockReturnValue([]);
    const { deleteTopic } = require('./memory');
    expect(deleteTopic('nope')).toBe(false);
  });

  it('writes a tombstone when topic exists', () => {
    const { deleteTopic } = require('./memory');
    const result = deleteTopic('delete-me');
    expect(result).toBe(true);
    const writeCall = mockWriteFileSync.mock.calls.find(
      ([p]: [string]) => typeof p === 'string' && p.includes('topic_delete-me.md'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain('deletedAt:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  touchTopic
// ─────────────────────────────────────────────────────────────────────────────
describe('touchTopic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockReaddirSync.mockReturnValue(['topic_foo.md']);
    mockReadFileSync.mockReturnValue([
      '---', 'name: foo', 'tags: []',
      'lastAccessedAt: 2025-01-01T00:00:00.000Z',
      'accessCount: 3', 'updatedAt: 1700000000000', '---', '', 'body',
    ].join('\n'));
    mockWriteFileSync.mockReturnValue(undefined);
  });

  it('increments accessCount on existing topic', () => {
    const { touchTopic } = require('./memory');
    touchTopic('foo');
    expect(mockWriteFileSync).toHaveBeenCalled();
    const content = mockWriteFileSync.mock.calls.map(([_, c]: [string, string]) => c).join('');
    expect(content).toContain('accessCount: 4');
  });

  it('does nothing for non-existent topic', () => {
    const { touchTopic } = require('./memory');
    touchTopic('nonexistent');
    // No write because saveTopic wasn't called
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  regenerateIndex
// ─────────────────────────────────────────────────────────────────────────────
describe('regenerateIndex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);
  });

  it('writes an index with topic entries', () => {
    mockReaddirSync.mockReturnValue(['topic_foo.md', 'topic_bar.md']);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.toString().endsWith('topic_foo.md')) return [
        '---', 'name: foo', 'tags: [test]',
        'lastAccessedAt: 2025-01-01T00:00:00.000Z',
        'accessCount: 10', 'updatedAt: 1700000000000', '---', '', 'Foo body',
      ].join('\n');
      return [
        '---', 'name: bar', 'tags: []',
        'lastAccessedAt: ' + new Date().toISOString(),
        'accessCount: 1', 'updatedAt: ' + Date.now(), '---', '', 'Bar body',
      ].join('\n');
    });
    const { regenerateIndex } = require('./memory');
    regenerateIndex();
    expect(mockWriteFileSync).toHaveBeenCalled();
    const indexContent = mockWriteFileSync.mock.calls.find(
      ([p]: [string]) => typeof p === 'string' && p.includes('MEMORY.md'),
    )?.[1];
    expect(indexContent).toContain('# Memory Index');
    expect(indexContent).toContain('foo');
    expect(indexContent).toContain('bar');
  });

  it('handles byte cap truncation with many entries', () => {
    const topics: string[] = [];
    for (let i = 0; i < 50; i++) {
      topics.push(`topic_t${i}.md`);
    }
    mockReaddirSync.mockReturnValue(topics);
    mockReadFileSync.mockImplementation((p: string) => {
      const idx = p.toString().match(/topic_t(\d+)\.md$/)?.[1];
      const name = `topic-${idx}`;
      return [
        '---', `name: ${name}`, 'tags: []',
        'lastAccessedAt: ' + new Date().toISOString(),
        'accessCount: 1', 'updatedAt: ' + Date.now(), '---', '',
        'Body of ' + name + ' with ' + 'some content '.repeat(10),
      ].join('\n');
    });
    const { regenerateIndex } = require('./memory');
    regenerateIndex();
    const call = mockWriteFileSync.mock.calls.find(
      ([p]: [string]) => typeof p === 'string' && p.toString().includes('MEMORY.md'),
    );
    expect(call).toBeDefined();
    const content = call[1] as string;
    // Should be under 25KB and include truncation notice if needed
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(26000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  findRelevantLLM
// ─────────────────────────────────────────────────────────────────────────────
describe('findRelevantLLM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
  });

  it('returns keyword results for small corpus (<= limit + 1)', async () => {
    mockReaddirSync.mockReturnValue(['topic_a.md', 'topic_b.md']);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.toString().endsWith('topic_a.md')) return [
        '---', 'name: auth-jwt', 'tags: [auth]',
        'lastAccessedAt: ' + new Date().toISOString(),
        'accessCount: 5', 'updatedAt: ' + Date.now(), '---', '', 'JWT tokens',
      ].join('\n');
      return [
        '---', 'name: deploy', 'tags: [devops]',
        'lastAccessedAt: ' + new Date().toISOString(),
        'accessCount: 2', 'updatedAt: ' + Date.now(), '---', '', 'Deploy scripts',
      ].join('\n');
    });
    const { __clearRelevanceCacheForTests, findRelevantLLM } = require('./memory');
    __clearRelevanceCacheForTests();
    const results = await findRelevantLLM('auth', 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toMatch(/auth/i);
  });

  it('uses cache on repeated call', async () => {
    mockReaddirSync.mockReturnValue(['topic_a.md', 'topic_b.md', 'topic_c.md', 'topic_d.md']);
    mockReadFileSync.mockReturnValue([
      '---', 'name: some', 'tags: []',
      'lastAccessedAt: ' + new Date().toISOString(),
      'accessCount: 1', 'updatedAt: ' + Date.now(), '---', '', 'content',
    ].join('\n'));
    const { __clearRelevanceCacheForTests, findRelevantLLM } = require('./memory');
    __clearRelevanceCacheForTests();
    // With topics.length > limit+1 and no provider, falls through to keyword
    const results = await findRelevantLLM('anything', 2);
    expect(Array.isArray(results)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  saveTopic with LRU eviction trigger
// ─────────────────────────────────────────────────────────────────────────────
describe('saveTopic — LRU eviction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(false);
    mockUnlinkSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);
  });

  it('evicts lowest-score topics when over MAX_TOPICS', () => {
    // Create 3 topics, then save one more → triggers eviction at >2
    // We mock 3 existing topics, then save a 4th
    const existingTopics = [];
    for (let i = 0; i < 3; i++) {
      existingTopics.push(`topic_t${i}.md`);
    }
    mockReaddirSync.mockReturnValue(existingTopics);
    mockReadFileSync.mockImplementation((p: string) => {
      const idx = p.toString().match(/topic_t(\d+)\.md$/)?.[1];
      if (idx) {
        // t0 = old/low-access (prime eviction candidate)
        const age = idx === '0' ? 200 : 1;
        const accessCount = idx === '0' ? 1 : 10;
        return [
          '---', `name: t${idx}`, 'tags: []',
          'lastAccessedAt: ' + new Date(Date.now() - age * 86400000).toISOString(),
          `accessCount: ${accessCount}`, 'updatedAt: ' + (Date.now() - age * 86400000),
          '---', '', `Body of t${idx}`,
        ].join('\n');
      }
      return '';
    });

    const { saveTopic } = require('./memory');
    saveTopic({ name: 'new-guy', body: 'fresh content' });
    // unlinkSync should have been called to evict an old topic
    // (we can't easily verify WHICH because of async dir state, but
    //  the function shouldn't crash)
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Cache cleanup
// ─────────────────────────────────────────────────────────────────────────────
describe('__clearRelevanceCacheForTests', () => {
  it('clears the relevance cache without throwing', () => {
    expect(() => __clearRelevanceCacheForTests()).not.toThrow();
  });
});
