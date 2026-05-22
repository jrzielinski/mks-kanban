import {
  normalizeBashCommand,
  jaccardSimilarity,
  checkRepeatedFailure,
  recordBashFailure,
  isShellLevelFailure,
} from './bash-failure-memory';

describe('normalizeBashCommand', () => {
  it('lowercases', () => {
    expect(normalizeBashCommand('CAT FOO')).toBe('cat foo');
  });

  it('strips quote chars so single↔double rotations match', () => {
    expect(normalizeBashCommand(`echo "hi"`)).toBe('echo hi');
    expect(normalizeBashCommand(`echo 'hi'`)).toBe('echo hi');
    expect(normalizeBashCommand(`echo \`hi\``)).toBe('echo hi');
  });

  it('collapses whitespace', () => {
    expect(normalizeBashCommand('cat   foo\t\nbar')).toBe('cat foo bar');
  });

  it('trims edges', () => {
    expect(normalizeBashCommand('   ls   ')).toBe('ls');
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('a b c', 'a b c')).toBe(1);
  });

  it('returns 0 for fully disjoint token sets', () => {
    expect(jaccardSimilarity('a b', 'x y')).toBe(0);
  });

  it('returns ratio for partial overlap', () => {
    // {a,b,c} ∩ {a,b,d} = {a,b}; union = {a,b,c,d}; sim = 2/4 = 0.5
    expect(jaccardSimilarity('a b c', 'a b d')).toBe(0.5);
  });

  it('handles empty inputs', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
    expect(jaccardSimilarity('a', '')).toBe(0);
  });
});

describe('record + check repeated failures (per-turn ctx state)', () => {
  const makeCtx = (turnSeq = 1): any => ({ __turnSeq: turnSeq });

  it('returns null when no prior failures', () => {
    expect(checkRepeatedFailure(makeCtx(), 'ls')).toBeNull();
  });

  it('blocks a command that is identical to a prior failure', () => {
    const ctx = makeCtx();
    recordBashFailure(ctx, 'cat <<EOF\nhi\nEOF', 'bash: -c: line 1: unexpected EOF');
    const out = checkRepeatedFailure(ctx, 'cat <<EOF\nhi\nEOF');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/100% similar/);
    expect(out!).toMatch(/unexpected EOF/);
  });

  it('blocks a quote-rotated near-duplicate (single→double)', () => {
    const ctx = makeCtx();
    recordBashFailure(
      ctx,
      `python3 -c "import re; re.sub('a','b','aaa')"`,
      'bash: -c: line 1: unexpected EOF',
    );
    const out = checkRepeatedFailure(
      ctx,
      `python3 -c 'import re; re.sub("a","b","aaa")'`,
    );
    expect(out).not.toBeNull();
    expect(out!).toMatch(/Write tool/);
  });

  it('does NOT block on different commands', () => {
    const ctx = makeCtx();
    recordBashFailure(ctx, 'cat <<EOF\nhi\nEOF', 'unexpected EOF');
    expect(checkRepeatedFailure(ctx, 'ls -la')).toBeNull();
    expect(checkRepeatedFailure(ctx, 'git status')).toBeNull();
  });

  it('isolates state per turn (turnSeq change clears history)', () => {
    const ctx: any = { __turnSeq: 1 };
    recordBashFailure(ctx, 'cat <<EOF', 'unexpected EOF');
    expect(checkRepeatedFailure(ctx, 'cat <<EOF')).not.toBeNull();
    ctx.__turnSeq = 2;
    expect(checkRepeatedFailure(ctx, 'cat <<EOF')).toBeNull();
  });

  it('keeps at most 5 most-recent failures', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 10; i++) {
      recordBashFailure(ctx, `cmd-${i}`, 'parse err');
    }
    // The first ones got rotated out — `cmd-0` should not block anymore.
    expect(checkRepeatedFailure(ctx, 'cmd-0')).toBeNull();
    expect(checkRepeatedFailure(ctx, 'cmd-9')).not.toBeNull();
  });

  it('block message includes the previous error so the model sees what failed', () => {
    const ctx = makeCtx();
    recordBashFailure(ctx, 'cat <<EOF', 'bash: line 5: unexpected EOF while looking for matching');
    const out = checkRepeatedFailure(ctx, 'cat <<EOF');
    expect(out!).toMatch(/looking for matching/);
  });
});

describe('isShellLevelFailure', () => {
  it('returns true for unexpected EOF', () => {
    expect(isShellLevelFailure('bash: -c: line 1: unexpected EOF', 2)).toBe(true);
  });

  it('returns true for PT-BR locale message', () => {
    expect(isShellLevelFailure('bash: -c: linha 1: erro', 2)).toBe(true);
  });

  it('returns true for unterminated quoted string', () => {
    expect(isShellLevelFailure('bash: unterminated quoted string', 2)).toBe(true);
  });

  it('returns true for command-not-found (exit 2 + bash: prefix)', () => {
    expect(isShellLevelFailure('bash: foo: command not found', 2)).toBe(true);
  });

  it('returns false for normal program failure (e.g. `false` returning 1)', () => {
    expect(isShellLevelFailure('', 1)).toBe(false);
    expect(isShellLevelFailure('something went wrong', 1)).toBe(false);
  });
});
