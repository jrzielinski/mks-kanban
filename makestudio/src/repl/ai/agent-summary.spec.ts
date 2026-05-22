import {
  buildSummaryPrompt,
  sanitizeSummary,
  SUMMARY_INTERVAL_MS,
  startAgentSummarization,
  stopAgentSummarization,
} from './agent-summary';

describe('SUMMARY_INTERVAL_MS', () => {
  it('is 30 seconds', () => {
    expect(SUMMARY_INTERVAL_MS).toBe(30_000);
  });
});

describe('buildSummaryPrompt', () => {
  it('returns prompt without previous when null', () => {
    const prompt = buildSummaryPrompt(null);
    expect(prompt).toContain('3-5 words');
    expect(prompt).toContain('present tense');
    expect(prompt).not.toContain('Previous:');
  });

  it('includes previous summary when provided', () => {
    const prompt = buildSummaryPrompt('Reading runAgent.ts');
    expect(prompt).toContain('Previous:');
    expect(prompt).toContain('Reading runAgent.ts');
    expect(prompt).toContain('say something NEW');
  });

  it('includes good examples', () => {
    const prompt = buildSummaryPrompt(null);
    expect(prompt).toContain('Good:');
    expect(prompt).toContain('"Reading runAgent.ts"');
  });

  it('includes bad examples', () => {
    const prompt = buildSummaryPrompt(null);
    expect(prompt).toContain('Bad (past tense)');
    expect(prompt).toContain('"Analyzed the branch diff"');
  });
});

describe('sanitizeSummary', () => {
  it('returns null for empty input', () => {
    expect(sanitizeSummary('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(sanitizeSummary('   ')).toBeNull();
  });

  it('strips leading quotes', () => {
    expect(sanitizeSummary('"Reading runAgent.ts"')).toBe('Reading runAgent.ts');
  });

  it('strips leading backticks', () => {
    expect(sanitizeSummary('`Reading runAgent.ts`')).toBe('Reading runAgent.ts');
  });

  it('strips single quotes', () => {
    expect(sanitizeSummary("'Reading runAgent.ts'")).toBe('Reading runAgent.ts');
  });

  it('takes first line only', () => {
    const input = 'Reading runAgent.ts\nSome extra text';
    expect(sanitizeSummary(input)).toBe('Reading runAgent.ts');
  });

  it('returns null for text with fewer than 2 words', () => {
    expect(sanitizeSummary('Oops')).toBeNull();
  });

  it('returns null for text with more than 12 words', () => {
    const long = 'a b c d e f g h i j k l m n o';
    expect(sanitizeSummary(long)).toBeNull();
  });

  it('rejects past-tense words starting with Analyzed', () => {
    expect(sanitizeSummary('Analyzed the branch diff')).toBeNull();
  });

  it('rejects past-tense words starting with Reviewed', () => {
    expect(sanitizeSummary('Reviewed the module')).toBeNull();
  });

  it('rejects past-tense words starting with Fixed', () => {
    expect(sanitizeSummary('Fixed the bug')).toBeNull();
  });

  it('rejects past-tense words starting with Added', () => {
    expect(sanitizeSummary('Added new feature')).toBeNull();
  });

  it('rejects branch names with slash', () => {
    expect(sanitizeSummary('adam/background-summary branch diff')).toBeNull();
  });

  it('accepts valid present-continuous summary', () => {
    expect(sanitizeSummary('Reading runAgent.ts')).toBe('Reading runAgent.ts');
  });

  it('accepts "Fixing null check in validate.ts"', () => {
    expect(sanitizeSummary('Fixing null check in validate.ts')).toBe('Fixing null check in validate.ts');
  });

  it('accepts "Running auth module tests"', () => {
    expect(sanitizeSummary('Running auth module tests')).toBe('Running auth module tests');
  });

  it('clamps word count to range [2, 12]', () => {
    // 7 words is OK
    expect(sanitizeSummary('a b c d e f g')).toBe('a b c d e f g');
  });
});

describe('startAgentSummarization / stopAgentSummarization', () => {
  it('start returns a handle with stop and isRunning', () => {
    const ctx: any = { messages: [{ role: 'user', content: 'hi' }], provider: 'anthropic' };
    const handle = startAgentSummarization(ctx);
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.isRunning).toBe('function');
    expect(handle.isRunning()).toBe(true);
    handle.stop();
    expect(handle.isRunning()).toBe(false);
  });

  it('calling start twice returns the same handle', () => {
    const ctx: any = { messages: [{ role: 'user', content: 'hi' }], provider: 'anthropic' };
    const h1 = startAgentSummarization(ctx);
    const h2 = startAgentSummarization(ctx);
    // Same handle reference
    expect(h1).toBe(h2);
    h1.stop();
    stopAgentSummarization(ctx);
  });

  it('stopAgentSummarization stops cleanly', () => {
    const ctx: any = { messages: [{ role: 'user', content: 'hi' }], provider: 'anthropic' };
    const handle = startAgentSummarization(ctx);
    expect(handle.isRunning()).toBe(true);
    stopAgentSummarization(ctx);
    expect(handle.isRunning()).toBe(false);
  });

  it('stopAgentSummarization is idempotent', () => {
    const ctx: any = { messages: [], provider: 'anthropic' };
    expect(() => stopAgentSummarization(ctx)).not.toThrow();
    expect(() => stopAgentSummarization(ctx)).not.toThrow();
  });
});
