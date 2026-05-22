import {
  extractRepoName,
  tokenizeProjectName,
  scoreFolderNameMatch,
} from './workspace-resolver';

describe('extractRepoName', () => {
  it('returns empty string for undefined/empty url', () => {
    expect(extractRepoName()).toBe('');
    expect(extractRepoName('')).toBe('');
  });

  it('extracts the repo segment from a GitHub https URL', () => {
    expect(extractRepoName('https://github.com/user/bingo-mania.git')).toBe('bingo-mania');
  });

  it('extracts the repo segment from a GitHub ssh URL', () => {
    expect(extractRepoName('git@github.com:user/bingo-mania.git')).toBe('bingo-mania');
  });

  it('drops .git suffix when present', () => {
    expect(extractRepoName('https://gitlab.com/team/foo.git')).toBe('foo');
    expect(extractRepoName('https://gitlab.com/team/foo')).toBe('foo');
  });

  it('lowercases the result', () => {
    expect(extractRepoName('https://github.com/User/MyRepo.git')).toBe('myrepo');
  });
});

describe('tokenizeProjectName', () => {
  it('splits by any non-alphanumeric character', () => {
    expect(tokenizeProjectName('Bingo Mania - 75 e 90')).toEqual(['bingo', 'mania']);
  });

  it('filters out tokens of length <= 2', () => {
    expect(tokenizeProjectName('abc ab a')).toEqual(['abc']);
  });

  it('returns empty array for empty input', () => {
    expect(tokenizeProjectName('')).toEqual([]);
    expect(tokenizeProjectName('   ')).toEqual([]);
  });

  it('lowercases before splitting', () => {
    expect(tokenizeProjectName('NestJS-API')).toEqual(['nestjs', 'api']);
  });
});

describe('scoreFolderNameMatch', () => {
  it('returns null when no tokens match', () => {
    expect(scoreFolderNameMatch('my-project', ['bingo', 'mania'])).toBeNull();
  });

  it('returns 10 for a single token match when project has exactly one token', () => {
    expect(scoreFolderNameMatch('bingo-game', ['bingo'])).toBe(10);
  });

  it('requires >= 2 matches when project has multiple tokens', () => {
    expect(scoreFolderNameMatch('bingo-game', ['bingo', 'mania'])).toBeNull();
    expect(scoreFolderNameMatch('bingo-mania-ext', ['bingo', 'mania'])).toBe(20);
  });

  it('counts one match per distinct token (10 each)', () => {
    expect(scoreFolderNameMatch('bingo-mania-75-90', ['bingo', 'mania', '75', '90'])).toBe(40);
  });

  it('handles empty token arrays gracefully', () => {
    expect(scoreFolderNameMatch('anything', [])).toBeNull();
  });
});
