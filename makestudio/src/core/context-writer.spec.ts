import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatRequirements,
  formatStack,
  formatExistingDums,
  ensureGitignore,
  cleanupContextFiles,
} from './context-writer';

describe('formatRequirements', () => {
  it('splits into functional vs audit sections by source', () => {
    const md = formatRequirements([
      { id: 'R1', title: 'Login', type: 'feature', priority: 'high', description: 'JWT login.', source: undefined } as any,
      { id: 'R2', title: 'Fix typo', type: 'bug_fix', priority: 'low', description: 'Typo.', source: 'audit' } as any,
    ]);
    expect(md).toContain('Functional Requirements (1)');
    expect(md).toContain('Audit Requirements — Technical Corrections (1)');
    expect(md).toContain('[R1] Login');
    expect(md).toContain('[R2] Fix typo');
  });

  it('lists acceptance criteria when present', () => {
    const md = formatRequirements([
      { id: 'R1', title: 'Login', type: 'feature', priority: 'high', description: 'x',
        acceptanceCriteria: ['Returns 200', 'Rejects 401'] } as any,
    ]);
    expect(md).toContain('Returns 200');
    expect(md).toContain('Rejects 401');
  });

  it('defaults tag to "mixed" when missing', () => {
    const md = formatRequirements([
      { id: 'R1', title: 'x', type: 'feature', priority: 'low', description: '.' } as any,
    ]);
    expect(md).toContain('**Tag:** mixed');
  });

  it('returns only the header when input is empty', () => {
    const md = formatRequirements([]);
    expect(md).toContain('# Requirements');
    expect(md).not.toContain('Functional Requirements');
    expect(md).not.toContain('Audit Requirements');
  });
});

describe('formatStack', () => {
  it('returns null for empty/missing stack', () => {
    expect(formatStack(undefined)).toBeNull();
    expect(formatStack({})).toBeNull();
  });

  it('includes each non-empty layer', () => {
    const md = formatStack({
      backend: ['nestjs'], frontend: ['react'], database: ['postgresql'],
    } as any);
    expect(md).toContain('## Backend');
    expect(md).toContain('nestjs');
    expect(md).toContain('## Frontend');
    expect(md).toContain('react');
    expect(md).toContain('## Database');
    expect(md).toContain('postgresql');
    expect(md).not.toContain('## Mobile');
  });

  it('skips layers that are empty arrays', () => {
    const md = formatStack({ backend: ['nest'], frontend: [] } as any);
    expect(md).toContain('## Backend');
    expect(md).not.toContain('## Frontend');
  });
});

describe('formatExistingDums', () => {
  it('returns a truthy block mentioning the DUMs provided', () => {
    const out = formatExistingDums([
      { id: '1', title: 'Auth', dumNumber: 'dum_001', description: 'JWT', tasks: ['task A', 'task B'] },
    ] as any);
    expect(out).toContain('dum_001');
    expect(out).toContain('Auth');
  });

  it('handles empty input gracefully', () => {
    const out = formatExistingDums([] as any);
    // Accept any non-undefined result — content may vary; key is no throw.
    expect(typeof out).toBe('string');
  });
});

describe('ensureGitignore / cleanupContextFiles', () => {
  let repo: string;
  beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxw-')); });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('ensureGitignore creates .gitignore with the makestudio entry when missing', () => {
    ensureGitignore(repo);
    const raw = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    expect(raw).toContain('.makestudio/');
  });

  it('ensureGitignore is idempotent on repeated calls', () => {
    ensureGitignore(repo);
    ensureGitignore(repo);
    const raw = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const occurrences = raw.split('\n').filter((l) => l.trim() === '.makestudio/').length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('cleanupContextFiles removes the .makestudio/context directory', () => {
    const ctx = path.join(repo, '.makestudio', 'context');
    fs.mkdirSync(ctx, { recursive: true });
    fs.writeFileSync(path.join(ctx, 'x.md'), 'x');
    cleanupContextFiles(repo);
    expect(fs.existsSync(ctx)).toBe(false);
  });

  it('cleanupContextFiles no-ops when directory does not exist', () => {
    cleanupContextFiles(repo);
    // No throw, no error
    expect(fs.existsSync(path.join(repo, '.makestudio'))).toBe(false);
  });
});
