import { formatAutoSyncSummary } from './auto-sync';

describe('formatAutoSyncSummary', () => {
  it('builds the no-conflict summary', () => {
    const r = formatAutoSyncSummary('m-abc', 'periodic', {
      pulled: 4,
      applied: [{ outcome: 'inserted' }, { outcome: 'inserted' }, { outcome: 'inserted' }, { outcome: 'inserted' }],
      skipped: 0,
    });
    expect(r.conflicts).toBe(0);
    expect(r.summary).toBe('auto-sync: pulled 4 from m-abc');
  });

  it('builds the conflict summary with the /memory conflicts hint', () => {
    const r = formatAutoSyncSummary('m-abc', 'periodic', {
      pulled: 4,
      applied: [
        { outcome: 'inserted' },
        { outcome: 'conflict' },
        { outcome: 'conflict' },
        { outcome: 'inserted' },
      ],
      skipped: 0,
    });
    expect(r.conflicts).toBe(2);
    expect(r.summary).toBe('auto-sync: pulled 4 from m-abc, 2 conflict(s) — /memory conflicts');
  });

  it('uses [revived] label when reason is revived', () => {
    const r = formatAutoSyncSummary('m-xyz', 'revived', {
      pulled: 1,
      applied: [{ outcome: 'inserted' }],
      skipped: 0,
    });
    expect(r.summary).toMatch(/^auto-sync \[revived\]:/);
  });

  it('counts conflicts even when pulled count is 0', () => {
    // Edge case: every applied entry was a conflict (nothing actually pulled
    // because each one rolled back). We still surface the conflict count.
    const r = formatAutoSyncSummary('m-abc', 'periodic', {
      pulled: 0,
      applied: [{ outcome: 'conflict' }],
      skipped: 0,
    });
    expect(r.conflicts).toBe(1);
    expect(r.summary).toMatch(/0 from m-abc, 1 conflict/);
  });

  it('returns 0 conflicts when applied list is empty', () => {
    const r = formatAutoSyncSummary('m-abc', 'periodic', {
      pulled: 0,
      applied: [],
      skipped: 5,
    });
    expect(r.conflicts).toBe(0);
    expect(r.summary).toBe('auto-sync: pulled 0 from m-abc');
  });
});
