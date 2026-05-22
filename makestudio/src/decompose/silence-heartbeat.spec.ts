import { startSilenceHeartbeat } from './silence-heartbeat';

describe('startSilenceHeartbeat', () => {
  // Drive time + ticks deterministically with fake timers + injected clock.
  // The implementation reads `Date.now` AND uses `setInterval`; we control
  // both so the test doesn't sleep.
  let captured: string[];
  let fakeNow: number;

  beforeEach(() => {
    jest.useFakeTimers();
    captured = [];
    fakeNow = 1_000_000;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function makeHb(opts: { threshold?: number; interval?: number } = {}) {
    return startSilenceHeartbeat({
      prefix: 'P:',
      threshold: opts.threshold ?? 5_000,
      interval: opts.interval ?? 5_000,
      hintAfterSeconds: 20,
      write: (s) => captured.push(s),
      now: () => fakeNow,
    });
  }

  it('does NOT fire while silence is below threshold', () => {
    const hb = makeHb();
    fakeNow += 4_000;
    jest.advanceTimersByTime(4_000);
    expect(captured).toEqual([]);
    hb.stop();
  });

  it('fires once after the threshold elapses without activity', () => {
    const hb = makeHb({ threshold: 5_000, interval: 5_000 });
    fakeNow += 6_000;
    jest.advanceTimersByTime(6_000);
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('aguardando resposta do LLM');
    expect(captured[0]).toContain('6s');
    hb.stop();
  });

  it('fires repeatedly while silence persists', () => {
    const hb = makeHb({ threshold: 5_000, interval: 5_000 });
    fakeNow += 6_000;
    jest.advanceTimersByTime(6_000);
    fakeNow += 5_000;
    jest.advanceTimersByTime(5_000);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    hb.stop();
  });

  it('resets on markActivity — no heartbeat after a chunk arrives', () => {
    const hb = makeHb({ threshold: 5_000, interval: 5_000 });
    fakeNow += 4_000; // not yet at threshold
    jest.advanceTimersByTime(4_000);
    hb.markActivity();
    fakeNow += 4_000; // total 8s but only 4 since markActivity
    jest.advanceTimersByTime(4_000);
    expect(captured).toEqual([]);
    hb.stop();
  });

  it('appends Ctrl+C hint after hintAfterSeconds', () => {
    const hb = startSilenceHeartbeat({
      prefix: 'P:',
      threshold: 1_000,
      interval: 1_000,
      hintAfterSeconds: 10,
      write: (s) => captured.push(s),
      now: () => fakeNow,
    });
    // First heartbeat at 5s — below hint window
    fakeNow += 5_000;
    jest.advanceTimersByTime(5_000);
    expect(captured.some((s) => s.includes('Ctrl+C'))).toBe(false);
    // Now go past 10s — next heartbeat should include hint
    fakeNow += 10_000;
    jest.advanceTimersByTime(10_000);
    expect(captured.some((s) => s.includes('Ctrl+C'))).toBe(true);
    hb.stop();
  });

  it('stop() prevents further heartbeats and is idempotent', () => {
    const hb = makeHb({ threshold: 1_000, interval: 1_000 });
    fakeNow += 2_000;
    jest.advanceTimersByTime(2_000);
    const countAfterFirst = captured.length;
    hb.stop();
    hb.stop(); // second stop should not throw
    fakeNow += 5_000;
    jest.advanceTimersByTime(5_000);
    expect(captured.length).toBe(countAfterFirst);
    expect(hb.isActive()).toBe(false);
  });
});
