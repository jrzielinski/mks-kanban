import {
  countAddedConsoleLogs,
  diffContainsPotentialSecret,
  summarizeVerifyResult,
  buildRetryPrompt,
} from './verify-runner';

describe('countAddedConsoleLogs', () => {
  it('returns 0 for null/undefined/empty diff', () => {
    expect(countAddedConsoleLogs(null)).toBe(0);
    expect(countAddedConsoleLogs(undefined)).toBe(0);
    expect(countAddedConsoleLogs('')).toBe(0);
  });

  it('counts added console.log calls', () => {
    const diff = `+  console.log('hello');\n+  console.log(x);\n   doSomething();`;
    expect(countAddedConsoleLogs(diff)).toBe(2);
  });

  it('ignores pre-existing console.log on context (non-plus) lines', () => {
    const diff = `   console.log('old');\n+  x = 1;\n-  console.log('removed');`;
    expect(countAddedConsoleLogs(diff)).toBe(0);
  });

  it('counts one match per added line (greedy regex behaviour)', () => {
    // The regex `+.*console\.log\(` is greedy on `.*` and there is no `m`
    // flag. Multiple logs on the same added line collapse into one match.
    // Documented here so the behaviour is obvious to future readers.
    const diff = `+  console.log(a); console.log(b);`;
    expect(countAddedConsoleLogs(diff)).toBe(1);
  });

  it('counts each added line separately across multiple lines', () => {
    const diff = `+  console.log(a);\n+  console.log(b);\n+  console.log(c);`;
    expect(countAddedConsoleLogs(diff)).toBe(3);
  });
});

describe('diffContainsPotentialSecret', () => {
  it('returns false for empty diff', () => {
    expect(diffContainsPotentialSecret('')).toBe(false);
    expect(diffContainsPotentialSecret(null)).toBe(false);
    expect(diffContainsPotentialSecret(undefined)).toBe(false);
  });

  it('detects api key pattern on added lines', () => {
    const diff = `+ const apiKey = "abcdefghijklmnopqrstuvwx";`;
    expect(diffContainsPotentialSecret(diff)).toBe(true);
  });

  it('detects sk-/pk_live_/AKIA prefixes', () => {
    expect(diffContainsPotentialSecret('+ const k = "sk-abcdef1234567890";')).toBe(true);
    expect(diffContainsPotentialSecret('+ const k = "pk_live_abcdef12345";')).toBe(true);
    expect(diffContainsPotentialSecret('+ const k = "AKIAabcdef1234567890";')).toBe(true);
  });

  it('does not flag existing (context) lines', () => {
    const ctx = `   const existing = "sk-abcdef1234567890";`;
    expect(diffContainsPotentialSecret(ctx)).toBe(false);
  });

  it('does not flag short strings that look like keys but are under threshold', () => {
    expect(diffContainsPotentialSecret('+ const apiKey = "short";')).toBe(false);
    expect(diffContainsPotentialSecret('+ const k = "sk-abc";')).toBe(false);
  });
});

describe('summarizeVerifyResult', () => {
  it('returns "all checks passed" when result.passed is true', () => {
    expect(summarizeVerifyResult({ passed: true, checks: [{ name: 'x', passed: true }] })).toBe('all checks passed');
  });

  it('lists failed check names when some fail', () => {
    const res = {
      passed: false,
      checks: [
        { name: 'compilation', passed: true },
        { name: 'tests', passed: false },
        { name: 'no_console_log', passed: false },
      ],
    };
    const summary = summarizeVerifyResult(res);
    expect(summary).toContain('2 failed');
    expect(summary).toContain('tests');
    expect(summary).toContain('no_console_log');
  });
});

describe('buildRetryPrompt', () => {
  const verifyResult = {
    passed: false,
    checks: [
      { name: 'compilation', passed: true },
      { name: 'tests', passed: false, output: '3 tests failing' },
      { name: 'no_console_log', passed: false, output: '2 console.log found' },
    ],
  };

  it('includes retry counter and max', () => {
    const p = buildRetryPrompt('Original prompt', verifyResult, 2, 5);
    expect(p).toContain('RETRY 2/5');
  });

  it('preserves the original prompt at the top', () => {
    const p = buildRetryPrompt('Original prompt text', verifyResult, 1, 3);
    expect(p.startsWith('Original prompt text')).toBe(true);
  });

  it('lists only failed checks (passed are omitted)', () => {
    const p = buildRetryPrompt('x', verifyResult, 1, 3);
    expect(p).toContain('tests');
    expect(p).toContain('3 tests failing');
    expect(p).toContain('no_console_log');
    expect(p).not.toContain('[compilation]');
  });

  it('falls back to "Failed" when a failed check has no output', () => {
    const result = { passed: false, checks: [{ name: 'lint', passed: false }] };
    const p = buildRetryPrompt('x', result, 1, 3);
    expect(p).toContain('[lint] Failed');
  });
});
