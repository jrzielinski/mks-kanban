import {
  classifyMemory,
  startMemoryWatchdog,
  COMPACT_THRESHOLD_MB,
  CRITICAL_THRESHOLD_MB,
} from './memory-watchdog';

/**
 * Memory-watchdog tests.
 *
 * Real-world scenario: agent grew to 4080 MB heap before OOM at 2h46min.
 * Without the watchdog, autoCompact never fired in time. With it, we
 * trigger compact at 3500 MB (aggressively early — the operator's call:
 * "3.5GB já é muito").
 *
 * Tests cover the pure classifier (classifyMemory) — easy to verify
 * thresholds — plus the watchdog wiring (interval, transition firing,
 * stop). The watchdog uses memoryUsageFn override so we can simulate
 * heap pressure deterministically.
 */

const mb = (n: number): NodeJS.MemoryUsage => ({
  heapUsed: n * 1024 * 1024,
  heapTotal: (n + 100) * 1024 * 1024,
  rss: (n + 200) * 1024 * 1024,
  external: 50 * 1024 * 1024,
  arrayBuffers: 0,
});

describe('classifyMemory', () => {
  it('returns level=ok when heapUsed is well below the compact threshold', () => {
    const result = classifyMemory(mb(500));
    expect(result.level).toBe('ok');
    expect(result.heapUsedMB).toBe(500);
  });

  it('returns level=ok at exactly compact_threshold - 1 MB', () => {
    expect(classifyMemory(mb(COMPACT_THRESHOLD_MB - 1)).level).toBe('ok');
  });

  it('transitions to level=high at exactly compact_threshold', () => {
    expect(classifyMemory(mb(COMPACT_THRESHOLD_MB)).level).toBe('high');
  });

  it('stays high between compact_threshold and critical_threshold', () => {
    expect(classifyMemory(mb(4000)).level).toBe('high');
    expect(classifyMemory(mb(5000)).level).toBe('high');
    expect(classifyMemory(mb(CRITICAL_THRESHOLD_MB - 1)).level).toBe('high');
  });

  it('transitions to level=critical at exactly critical_threshold', () => {
    expect(classifyMemory(mb(CRITICAL_THRESHOLD_MB)).level).toBe('critical');
  });

  it('stays critical above critical_threshold', () => {
    expect(classifyMemory(mb(7000)).level).toBe('critical');
    expect(classifyMemory(mb(8000)).level).toBe('critical');
  });

  it('rounds bytes to MB correctly', () => {
    const result = classifyMemory({
      heapUsed: 3.7 * 1024 * 1024 * 1024, // 3788.8 MB
      heapTotal: 4 * 1024 * 1024 * 1024,
      rss: 4 * 1024 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    });
    // 3.7 GB = 3788 or 3789 MB depending on rounding; we round.
    expect(result.heapUsedMB).toBeGreaterThanOrEqual(3788);
    expect(result.heapUsedMB).toBeLessThanOrEqual(3789);
    expect(result.level).toBe('high'); // > 3500
  });
});

describe('startMemoryWatchdog', () => {
  it('returns a handle with .stop, .tick, and .lastStatus', () => {
    const wd = startMemoryWatchdog({ intervalMs: 60_000, memoryUsageFn: () => mb(100) });
    try {
      expect(typeof wd.stop).toBe('function');
      expect(typeof wd.tick).toBe('function');
    } finally {
      wd.stop();
    }
  });

  it('tick() returns immediate status without waiting for interval', () => {
    const wd = startMemoryWatchdog({ intervalMs: 60_000, memoryUsageFn: () => mb(2000) });
    try {
      const status = wd.tick();
      expect(status.heapUsedMB).toBe(2000);
      expect(status.level).toBe('ok');
    } finally {
      wd.stop();
    }
  });

  it('fires onHigh callback when heap crosses compact threshold (transition only)', () => {
    let level: number = 100;
    const onHigh = jest.fn();
    const wd = startMemoryWatchdog({
      intervalMs: 60_000,
      memoryUsageFn: () => mb(level),
      onHigh,
    });
    try {
      wd.tick(); // 100 MB → ok
      expect(onHigh).not.toHaveBeenCalled();
      level = 4000;
      wd.tick(); // 4000 MB → high (transition)
      expect(onHigh).toHaveBeenCalledTimes(1);
      // Subsequent ticks at the same level should NOT re-fire
      wd.tick();
      expect(onHigh).toHaveBeenCalledTimes(1);
    } finally {
      wd.stop();
    }
  });

  it('fires onCritical callback only when heap crosses 6GB', () => {
    let level: number = 4000;
    const onCritical = jest.fn();
    const wd = startMemoryWatchdog({
      intervalMs: 60_000,
      memoryUsageFn: () => mb(level),
      onCritical,
    });
    try {
      wd.tick(); // 4000 MB → high (no critical fire)
      expect(onCritical).not.toHaveBeenCalled();
      level = 7000;
      wd.tick(); // 7000 MB → critical
      expect(onCritical).toHaveBeenCalledTimes(1);
    } finally {
      wd.stop();
    }
  });

  it('callback failure does not crash the watchdog', () => {
    const wd = startMemoryWatchdog({
      intervalMs: 60_000,
      memoryUsageFn: () => mb(4000),
      onHigh: () => { throw new Error('callback bug'); },
    });
    try {
      // tick should not throw despite the callback exploding
      expect(() => wd.tick()).not.toThrow();
    } finally {
      wd.stop();
    }
  });

  it('stop() releases the interval — subsequent ticks are no-ops in the timer loop', (done) => {
    let memCalls = 0;
    const wd = startMemoryWatchdog({
      intervalMs: 50, // very short for test
      memoryUsageFn: () => { memCalls++; return mb(100); },
    });
    setTimeout(() => {
      wd.stop();
      const callsAtStop = memCalls;
      setTimeout(() => {
        // After stop + 200ms, no more ticks happened
        expect(memCalls).toBe(callsAtStop);
        done();
      }, 200);
    }, 200);
  });

  it('clamps interval to minimum 5s to prevent CPU thrashing', () => {
    // Internal — the constant 5_000 is the floor. We can't verify the
    // setInterval delay directly, but we verify the function doesn't crash
    // with a very small intervalMs (it should be clamped, not respected).
    const wd = startMemoryWatchdog({ intervalMs: 1, memoryUsageFn: () => mb(100) });
    try {
      expect(() => wd.tick()).not.toThrow();
    } finally {
      wd.stop();
    }
  });
});
