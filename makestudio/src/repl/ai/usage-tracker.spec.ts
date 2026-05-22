import { recordUsage, drainPending, peekPending } from './usage-tracker';

describe('recordUsage and drainPending', () => {
  beforeEach(() => {
    drainPending(); // reset state
  });

  it('records a usage sample', () => {
    recordUsage({
      provider: 'anthropic',
      model: 'claude-3',
      usage: { promptTokens: 100, completionTokens: 50 },
    });
    const pending = peekPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].provider).toBe('anthropic');
    expect(pending[0].promptTokens).toBe(100);
    expect(pending[0].completionTokens).toBe(50);
  });

  it('returns an empty array when nothing recorded', () => {
    expect(drainPending()).toEqual([]);
  });

  it('clears the pending list after drain', () => {
    recordUsage({ provider: 'openai', model: 'gpt-4', usage: { promptTokens: 10, completionTokens: 5 } });
    drainPending();
    expect(peekPending()).toEqual([]);
  });

  it('accumulates multiple records', () => {
    recordUsage({ provider: 'a', model: 'm1', usage: { promptTokens: 10, completionTokens: 5 } });
    recordUsage({ provider: 'b', model: 'm2', usage: { promptTokens: 20, completionTokens: 10 } });
    expect(drainPending()).toHaveLength(2);
  });

  it('stores cache reads and writes', () => {
    recordUsage({
      provider: 'anthropic',
      model: 'claude-3',
      usage: { promptTokens: 100, completionTokens: 50, cacheReads: 10, cacheWrites: 20 },
    });
    const sample = drainPending()[0];
    expect(sample.cacheReads).toBe(10);
    expect(sample.cacheWrites).toBe(20);
  });

  it('stores timestamp', () => {
    const before = Date.now();
    recordUsage({ provider: 'x', model: 'y', usage: { promptTokens: 1, completionTokens: 1 } });
    const sample = drainPending()[0];
    expect(sample.at).toBeGreaterThanOrEqual(before);
    expect(sample.at).toBeLessThanOrEqual(Date.now());
  });

  it('does nothing when usage is undefined', () => {
    recordUsage({ provider: 'x', model: 'y' } as any);
    expect(peekPending()).toEqual([]);
  });

  it('does nothing when both token counts are 0/undefined', () => {
    recordUsage({ provider: 'x', model: 'y', usage: { promptTokens: 0, completionTokens: 0 } });
    expect(peekPending()).toEqual([]);
  });

  it('supports optional tier field', () => {
    recordUsage({ provider: 'x', model: 'y', tier: 'fast', usage: { promptTokens: 1, completionTokens: 1 } });
    expect(drainPending()[0].tier).toBe('fast');
  });
});
