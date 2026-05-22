import { formatUsageBlock, UsageBlockData } from './commands';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

const baseData: UsageBlockData = {
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  requests: 12,
  promptTokens: 5000,
  completionTokens: 1500,
  totalTokens: 6500,
  cacheReads: 0,
  cacheWrites: 0,
  cacheMisses: 0,
  costUSD: 0.0234,
  cacheSavingsUSD: 0,
  sessionSeconds: 73,
};

describe('formatUsageBlock — single contiguous block, label-aligned', () => {
  it('opens with the makestudio header and closes with the └── corner', () => {
    const out = stripAnsi(formatUsageBlock(baseData));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/✦ makestudio · usage/);
    expect(lines[lines.length - 1]).toMatch(/└──/);
  });

  it('emits no blank rows between header and corner', () => {
    const out = stripAnsi(formatUsageBlock(baseData));
    for (const line of out.split('\n')) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('aligns the value column across rows', () => {
    const out = stripAnsi(formatUsageBlock(baseData));
    const lines = out.split('\n');
    const providerCol = lines.find((l) => l.includes('provider'))!.indexOf('anthropic');
    const modelCol = lines.find((l) => l.includes('model'))!.indexOf('claude-sonnet-4');
    expect(providerCol).toBe(modelCol);
  });

  it('renders prompt/output/total tokens with thousands separator + "tokens" suffix', () => {
    const out = stripAnsi(formatUsageBlock(baseData));
    // Locale-aware: PT-BR uses '.', en-US uses ','. Accept either.
    expect(out).toMatch(/prompt\s+5[.,]000 tokens/);
    expect(out).toMatch(/output\s+1[.,]500 tokens/);
    expect(out).toMatch(/total\s+6[.,]500 tokens/);
  });

  it('renders cost in USD with 4 decimals when costUSD > 0', () => {
    const out = stripAnsi(formatUsageBlock(baseData));
    expect(out).toMatch(/cost\s+\$0\.0234 USD/);
  });

  it('renders the "(pricing not available)" placeholder when costUSD is null', () => {
    const out = stripAnsi(formatUsageBlock({ ...baseData, costUSD: null }));
    expect(out).toMatch(/cost\s+\(pricing not available/);
  });

  it('renders the "(pricing not available)" placeholder when costUSD is 0', () => {
    const out = stripAnsi(formatUsageBlock({ ...baseData, costUSD: 0 }));
    expect(out).toMatch(/cost\s+\(pricing not available/);
  });

  it('appends cache savings inline with cost when cacheSavingsUSD > 0', () => {
    const out = stripAnsi(formatUsageBlock({ ...baseData, cacheSavingsUSD: 0.0091 }));
    expect(out).toMatch(/cache savings -\$0\.0091/);
  });

  it('hides cache rows entirely when both cacheReads and cacheWrites are 0', () => {
    const out = stripAnsi(formatUsageBlock(baseData));
    expect(out).not.toMatch(/cache r\b/);
    expect(out).not.toMatch(/cache w\b/);
  });

  it('shows cache rows when at least one of reads/writes is > 0', () => {
    const out = stripAnsi(formatUsageBlock({
      ...baseData,
      cacheReads: 10_000,
      cacheWrites: 2_000,
    }));
    expect(out).toMatch(/cache r\s+10[.,]000 tokens/);
    expect(out).toMatch(/cache w\s+2[.,]000 tokens/);
  });

  it('shows cache misses row only when misses > 0', () => {
    const withMisses = stripAnsi(formatUsageBlock({
      ...baseData,
      cacheReads: 100, cacheWrites: 100, cacheMisses: 7,
    }));
    expect(withMisses).toMatch(/cache miss\s+7/);

    const withoutMisses = stripAnsi(formatUsageBlock({
      ...baseData,
      cacheReads: 100, cacheWrites: 100, cacheMisses: 0,
    }));
    expect(withoutMisses).not.toMatch(/cache miss/);
  });

  it('renders session time as Ns when under one minute', () => {
    const out = stripAnsi(formatUsageBlock({ ...baseData, sessionSeconds: 39 }));
    expect(out).toMatch(/session\s+39s/);
  });

  it('renders session time as MmSs when over one minute', () => {
    const out = stripAnsi(formatUsageBlock({ ...baseData, sessionSeconds: 73 }));
    expect(out).toMatch(/session\s+1m13s/);
  });
});
