import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  countLines,
  readBeforeAfterCounts,
  formatTurnSummary,
  trackEdit,
  clearTurnEdits,
  loadHookConfig,
  expandHookCommand,
  runPostEditCheck,
} from './post-edit-hooks';

describe('countLines', () => {
  it('returns 0 for empty string', () => {
    expect(countLines('')).toBe(0);
  });

  it('matches `wc -l` for trailing-newline content', () => {
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts a final no-trailing-newline line as a logical line', () => {
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
  });

  it('handles 5000-line files exactly', () => {
    const big = Array(5000).fill('x').join('\n') + '\n';
    expect(countLines(big)).toBe(5000);
  });
});

describe('readBeforeAfterCounts (real git fixture)', () => {
  let tmpRepo: string;
  let absFile: string;
  const REL = 'foo.tsx';

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-hooks-'));
    execSync('git init -q', { cwd: tmpRepo });
    execSync('git config user.email t@t.t', { cwd: tmpRepo });
    execSync('git config user.name t', { cwd: tmpRepo });
    // Commit a 5202-line file.
    const before = Array(5202).fill('line').join('\n') + '\n';
    absFile = path.join(tmpRepo, REL);
    fs.writeFileSync(absFile, before);
    execSync('git add foo.tsx && git commit -q -m initial', { cwd: tmpRepo });
    // Modify down to 4758 lines to mirror the PowerQueryEditor session.
    const after = Array(4758).fill('line').join('\n') + '\n';
    fs.writeFileSync(absFile, after);
  });

  afterAll(() => {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns ground-truth before/after counts from git+fs', () => {
    const r = readBeforeAfterCounts(absFile, REL, tmpRepo);
    expect(r).toEqual({ before: 5202, after: 4758 });
  });

  it('returns null when cwd is missing', () => {
    expect(readBeforeAfterCounts(absFile, REL, undefined)).toBeNull();
  });

  it('returns null when the file is not tracked at HEAD', () => {
    const newPath = path.join(tmpRepo, 'untracked.tsx');
    fs.writeFileSync(newPath, 'hello\n');
    const r = readBeforeAfterCounts(newPath, 'untracked.tsx', tmpRepo);
    expect(r).toBeNull();
  });
});

describe('formatTurnSummary line-count enrichment (fix #1)', () => {
  let tmpRepo: string;
  const REL = 'big.tsx';

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-summary-'));
    execSync('git init -q', { cwd: tmpRepo });
    execSync('git config user.email t@t.t', { cwd: tmpRepo });
    execSync('git config user.name t', { cwd: tmpRepo });
    const original = Array(5202).fill('line').join('\n') + '\n';
    fs.writeFileSync(path.join(tmpRepo, REL), original);
    execSync('git add big.tsx && git commit -q -m initial', { cwd: tmpRepo });
    // Shrink to 4758 lines (matches the PowerQueryEditor case the test
    // suite is named after — the bug-shaped fixture).
    const shrunk = Array(4758).fill('line').join('\n') + '\n';
    fs.writeFileSync(path.join(tmpRepo, REL), shrunk);
  });

  afterEach(() => {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* */ }
  });

  it('includes ground-truth before/after/Δ in the row for tracked files', () => {
    const ctx: any = { cwd: tmpRepo };
    clearTurnEdits(ctx);
    trackEdit(ctx, path.join(tmpRepo, REL));
    const out = formatTurnSummary(ctx);
    expect(out).not.toBeNull();
    // Row format: `  big.tsx  5202 → 4758 (Δ-444; +X -Y)`
    expect(out).toMatch(/big\.tsx\s+5202\s*→\s*4758\s*\(Δ-444/);
  });

  it('falls back to +/- format if git show fails (e.g. binary file)', () => {
    // Track a new file mid-fixture so HEAD doesn't have it. formatTurnSummary
    // will see it as untracked, and emit the "(new, N lines)" branch — same
    // path used when before-counts can't be determined.
    const newRel = 'fresh.tsx';
    fs.writeFileSync(path.join(tmpRepo, newRel), 'a\nb\nc\n');
    const ctx: any = { cwd: tmpRepo };
    clearTurnEdits(ctx);
    trackEdit(ctx, path.join(tmpRepo, newRel));
    const out = formatTurnSummary(ctx);
    expect(out).toMatch(/fresh\.tsx\s+\(new,\s*3\s+lines\)/);
  });
});

describe('loadHookConfig — reads <project>/.makestudio/post-edit-hooks.json', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-cfg-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('returns {} when project root is empty/unset', () => {
    expect(loadHookConfig('')).toEqual({});
  });

  it('returns {} when the config file does not exist', () => {
    expect(loadHookConfig(tmp)).toEqual({});
  });

  it('parses a well-formed config — works for ANY language the user wires up', () => {
    fs.mkdirSync(path.join(tmp, '.makestudio'));
    const cfg = {
      '.ts':   'npx tsc --noEmit {file}',
      '.dart': 'dart analyze {file}',
      '.py':   'python -m py_compile {file}',
      '.rs':   'cargo check',
      '.go':   'go vet ./...',
      '.java': 'mvn -q test-compile',
    };
    fs.writeFileSync(path.join(tmp, '.makestudio', 'post-edit-hooks.json'), JSON.stringify(cfg));
    expect(loadHookConfig(tmp)).toEqual(cfg);
  });

  it('normalises extension keys without leading dot (accepts both "ts" and ".ts")', () => {
    fs.mkdirSync(path.join(tmp, '.makestudio'));
    fs.writeFileSync(
      path.join(tmp, '.makestudio', 'post-edit-hooks.json'),
      JSON.stringify({ ts: 'a', '.tsx': 'b', PY: 'c' }),
    );
    expect(loadHookConfig(tmp)).toEqual({ '.ts': 'a', '.tsx': 'b', '.py': 'c' });
  });

  it('returns {} on malformed JSON without throwing', () => {
    fs.mkdirSync(path.join(tmp, '.makestudio'));
    fs.writeFileSync(path.join(tmp, '.makestudio', 'post-edit-hooks.json'), '{not json');
    expect(loadHookConfig(tmp)).toEqual({});
  });

  it('returns {} when the JSON is the wrong shape (array, primitive)', () => {
    fs.mkdirSync(path.join(tmp, '.makestudio'));
    const cfgPath = path.join(tmp, '.makestudio', 'post-edit-hooks.json');
    fs.writeFileSync(cfgPath, '[]');
    expect(loadHookConfig(tmp)).toEqual({});
    fs.writeFileSync(cfgPath, '"a string"');
    expect(loadHookConfig(tmp)).toEqual({});
    fs.writeFileSync(cfgPath, '42');
    expect(loadHookConfig(tmp)).toEqual({});
  });

  it('drops entries with non-string values or empty values', () => {
    fs.mkdirSync(path.join(tmp, '.makestudio'));
    fs.writeFileSync(
      path.join(tmp, '.makestudio', 'post-edit-hooks.json'),
      JSON.stringify({ '.ts': 'good', '.py': '', '.rs': null, '.go': 42, '.java': '   ' }),
    );
    expect(loadHookConfig(tmp)).toEqual({ '.ts': 'good' });
  });
});

describe('expandHookCommand — language-agnostic template substitution', () => {
  const values = { file: 'src/foo.ts', absFile: '/abs/src/foo.ts', project: '/abs' };

  it('substitutes {file}, {absFile}, {project}', () => {
    expect(expandHookCommand('npx tsc --noEmit {file}', values)).toBe('npx tsc --noEmit src/foo.ts');
    expect(expandHookCommand('cat {absFile}', values)).toBe('cat /abs/src/foo.ts');
    expect(expandHookCommand('cd {project} && build', values)).toBe('cd /abs && build');
  });

  it('substitutes ALL occurrences of each placeholder', () => {
    const r = expandHookCommand('cp {file} {project}/backup/{file}', values);
    expect(r).toBe('cp src/foo.ts /abs/backup/src/foo.ts');
  });

  it('leaves the template unchanged when no placeholders are present', () => {
    expect(expandHookCommand('cargo check', values)).toBe('cargo check');
  });
});

describe('runPostEditCheck — config-driven, language-agnostic dispatch', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-run-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  function writeConfig(map: Record<string, string>): void {
    fs.mkdirSync(path.join(tmp, '.makestudio'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.makestudio', 'post-edit-hooks.json'), JSON.stringify(map));
  }

  it('returns ok when no config file exists (default: agnostic, zero behaviour)', () => {
    fs.writeFileSync(path.join(tmp, 'foo.ts'), '// anything goes');
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'foo.ts') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('returns ok when the file extension has no hook configured', () => {
    writeConfig({ '.ts': 'true' }); // only .ts has a hook
    fs.writeFileSync(path.join(tmp, 'foo.py'), 'print(1)');
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'foo.py') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('runs the hook command when one is configured for the extension — passes when exit==0', () => {
    writeConfig({ '.ts': 'true' }); // /usr/bin/true: always exit 0
    fs.writeFileSync(path.join(tmp, 'foo.ts'), '');
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'foo.ts') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('reports failure with stderr tail when exit != 0', () => {
    writeConfig({ '.dart': 'echo "lint error: missing semicolon" 1>&2; exit 2' });
    fs.writeFileSync(path.join(tmp, 'app.dart'), '');
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'app.dart') }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/app\.dart/);
    expect(r.message).toMatch(/exit 2/);
    expect(r.message).toMatch(/missing semicolon/);
  });

  it('substitutes {file} so the hook receives the relative path', () => {
    writeConfig({ '.py': 'test "$1" = "src/main.py" || exit 7' });
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'main.py'), '');
    // Wrap the hook so $1 becomes the {file} arg via bash positional.
    writeConfig({ '.py': 'bash -c \'test "$0" = "src/main.py" || exit 7\' {file}' });
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'src', 'main.py') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('skips for non-edit tools', () => {
    writeConfig({ '.ts': 'exit 1' }); // would fail if it ran
    fs.writeFileSync(path.join(tmp, 'foo.ts'), '');
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Read', { file_path: path.join(tmp, 'foo.ts') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('skips when the file does not exist on disk', () => {
    writeConfig({ '.ts': 'exit 1' });
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'gone.ts') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('is case-insensitive on extension match (.TS vs .ts)', () => {
    writeConfig({ '.ts': 'exit 5' });
    fs.writeFileSync(path.join(tmp, 'F.TS'), '');
    const ctx: any = { cwd: tmp };
    const r = runPostEditCheck('Edit', { file_path: path.join(tmp, 'F.TS') }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/exit 5/);
  });
});
