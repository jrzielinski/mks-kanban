import {
  estimateContextWindow,
  compactThresholdTokens,
  estimateContextPct,
  estimateTokens,
  isAtBlockingLimit,
} from './token-estimation';

describe('estimateContextWindow', () => {
  it('claude → 200K', () => {
    expect(estimateContextWindow('claude-opus-4')).toBe(200_000);
    expect(estimateContextWindow('claude-sonnet-4-6')).toBe(200_000);
  });
  it('gemini-1.5-pro / 2.x → 1M', () => {
    expect(estimateContextWindow('gemini-1.5-pro')).toBe(1_000_000);
    expect(estimateContextWindow('gemini-2.5-pro')).toBe(1_000_000);
  });
  it('plain gemini → 128K', () => {
    expect(estimateContextWindow('gemini-flash')).toBe(128_000);
  });
  it('gpt-4.1 → 1M', () => {
    expect(estimateContextWindow('gpt-4.1')).toBe(1_000_000);
  });
  it('gpt-4o / o1 / o3 / o4 → 128K', () => {
    expect(estimateContextWindow('gpt-4o')).toBe(128_000);
    expect(estimateContextWindow('o1-mini')).toBe(128_000);
  });
  it('qwen-3 variants → 131K', () => {
    expect(estimateContextWindow('qwen-3-235b')).toBe(131_072);
    expect(estimateContextWindow('qwen-3-32b')).toBe(131_072);
  });
  it('deepseek → 128K', () => {
    expect(estimateContextWindow('deepseek-v3')).toBe(128_000);
  });
  it('unknown / empty → 128K default', () => {
    expect(estimateContextWindow('')).toBe(128_000);
    expect(estimateContextWindow('something-new')).toBe(128_000);
  });
});

describe('compactThresholdTokens', () => {
  it('reserves min(20K, 10% of window) + 13K buffer', () => {
    // 200K window: reserve = min(20K, 20K) = 20K, buffer = 13K → 200K - 33K = 167K
    expect(compactThresholdTokens('claude-opus-4')).toBe(167_000);
    // 128K window: reserve = min(20K, 12.8K) = 12.8K → 128K - 12.8K - 13K = 102.2K
    expect(compactThresholdTokens('gpt-4o')).toBe(128_000 - 12_800 - 13_000);
  });
});

describe('estimateContextPct', () => {
  it('factors system prompt + every message body', () => {
    const ctx = {
      providerInfo: { model: 'gpt-4o' },
      messages: [
        { role: 'user', content: 'a'.repeat(400) },        // ~100 tokens
        { role: 'assistant', content: 'b'.repeat(800) },   // ~200 tokens
      ],
    };
    const pct = estimateContextPct(ctx, 'sys '.repeat(100)); // ~100 tokens
    // Total ~400 tokens of 128K → ~0.31%
    expect(pct).toBeGreaterThan(0.2);
    expect(pct).toBeLessThan(0.5);
  });
  it('JSON-stringifies non-string content', () => {
    const ctx = {
      providerInfo: { model: 'gpt-4o' },
      messages: [{ role: 'user', content: { foo: 'x'.repeat(100) } }],
    };
    expect(estimateContextPct(ctx, '')).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('CJK / emoji → ~1.5 chars per token', () => {
    const cjk = '中文文本中文文本中文文本中文文本中文文本';
    const t = estimateTokens(cjk);
    expect(t).toBeGreaterThan(cjk.length / 2);
    expect(t).toBeLessThanOrEqual(Math.ceil(cjk.length / 1.5));
  });
  it('JSON shape → ~3.5 chars per token', () => {
    const json = '{"foo":"bar","count":1,"items":[1,2,3]}';
    const t = estimateTokens(json);
    expect(t).toBe(Math.ceil(json.length / 3.5));
  });
  it('code-shape → ~3 chars per token', () => {
    const code = 'function foo() { return [1, 2, 3].map(x => x * 2); }';
    const t = estimateTokens(code);
    expect(t).toBe(Math.ceil(code.length / 3));
  });
  it('natural text → ~4 chars per token', () => {
    const text = 'The quick brown fox jumps over the lazy dog repeatedly today.';
    const t = estimateTokens(text);
    expect(t).toBe(Math.ceil(text.length / 4));
  });
});

describe('isAtBlockingLimit', () => {
  it('returns false for tiny context', () => {
    const ctx = { providerInfo: { model: 'gpt-4o' }, messages: [] };
    expect(isAtBlockingLimit(ctx, 'small')).toBe(false);
  });
  it('returns true when usage exceeds window minus 3K buffer', () => {
    // gpt-4o has 128K window. With a 200K-char message body (~50K tokens
    // estimate) plus a 100K-char system prompt (~25K tokens), still within
    // budget. Push to ~127K total to cross.
    const big = 'x'.repeat(126_000 * 4); // ~126K tokens
    const ctx = {
      providerInfo: { model: 'gpt-4o' },
      messages: [{ role: 'user', content: big }],
    };
    expect(isAtBlockingLimit(ctx, '')).toBe(true);
  });
  it('returns false on malformed ctx (defensive try/catch)', () => {
    expect(isAtBlockingLimit(null as any, 'sys')).toBe(false);
    expect(isAtBlockingLimit({} as any, 'sys')).toBe(false);
  });
});
