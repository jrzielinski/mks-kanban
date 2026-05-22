import {
  tokenizeStack,
  scoreBoilerplate,
  pickBestBoilerplate,
} from './boilerplate-registry';

describe('tokenizeStack', () => {
  it('splits by spaces, commas, plus, pipe, slash, backslash, semicolon', () => {
    expect(tokenizeStack('react,vite+tailwind | zustand; postgres/redis')).toEqual(
      ['react', 'vite', 'tailwind', 'zustand', 'postgres', 'redis'],
    );
  });

  it('lowercases input', () => {
    expect(tokenizeStack('NestJS + React')).toEqual(['nestjs', 'react']);
  });

  it('drops single-character tokens', () => {
    expect(tokenizeStack('a nestjs x react z')).toEqual(['nestjs', 'react']);
  });

  it('returns empty array for empty/whitespace input', () => {
    expect(tokenizeStack('')).toEqual([]);
    expect(tokenizeStack('   ')).toEqual([]);
  });
});

describe('scoreBoilerplate', () => {
  const bp = {
    slug: 'api-minimal',
    name: 'API Minimal',
    localPath: '/x',
    stacks: ['express', 'node', 'api', 'rest'],
    difficultyMin: 1,
    difficultyMax: 4,
    description: '',
  } as any;

  it('gives +10 per matching token (substring either way)', () => {
    expect(scoreBoilerplate(bp, ['express'])).toBe(10);
    expect(scoreBoilerplate(bp, ['expressjs'])).toBe(10); // token contains stack
    expect(scoreBoilerplate(bp, ['nod'])).toBe(10); // stack contains token
  });

  it('returns 0 when no token matches', () => {
    expect(scoreBoilerplate(bp, ['flutter', 'dart'])).toBe(0);
  });

  it('sums 10 per distinct match', () => {
    expect(scoreBoilerplate(bp, ['express', 'node', 'rest'])).toBe(30);
  });

  it('adds +20 when difficulty is within range', () => {
    expect(scoreBoilerplate(bp, ['express'], 2)).toBe(30);
    expect(scoreBoilerplate(bp, ['express'], 1)).toBe(30);
    expect(scoreBoilerplate(bp, ['express'], 4)).toBe(30);
  });

  it('subtracts 5 when difficulty is outside range', () => {
    expect(scoreBoilerplate(bp, ['express'], 10)).toBe(5); // 10 - 5
  });

  it('treats missing difficulty bounds as open range', () => {
    const open = { ...bp, difficultyMin: undefined, difficultyMax: undefined };
    expect(scoreBoilerplate(open, ['express'], 99)).toBe(30);
  });
});

describe('pickBestBoilerplate', () => {
  const a = { slug: 'a', name: 'A', localPath: '/a', stacks: ['react'], difficultyMin: 1, difficultyMax: 5, description: '' } as any;
  const b = { slug: 'b', name: 'B', localPath: '/b', stacks: ['react', 'vite'], difficultyMin: 1, difficultyMax: 10, description: '' } as any;

  it('returns null for empty candidate list', () => {
    expect(pickBestBoilerplate([], ['react'])).toBeNull();
  });

  it('returns null when no candidate scores above zero', () => {
    expect(pickBestBoilerplate([a, b], ['dart'])).toBeNull();
  });

  it('picks the highest-scoring candidate', () => {
    const best = pickBestBoilerplate([a, b], ['react', 'vite']);
    expect(best?.slug).toBe('b');
  });

  it('uses difficulty to break ties', () => {
    const best = pickBestBoilerplate([a, b], ['react'], 8);
    // a scores 10-5=5 (out of range), b scores 10+20=30 (within range)
    expect(best?.slug).toBe('b');
  });
});
