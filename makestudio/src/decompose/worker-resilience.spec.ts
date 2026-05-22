/**
 * Regression test for the workerLoop resilience pattern.
 *
 * Bug observed: when a range of requirements (e.g. 1..5) was selected,
 * the loop processed only the first one and aborted. Root cause was that
 * `workerLoop` ran `await processOneRequirementTwoPass(...)` without
 * try/catch — any unhandled rejection (API timeout, network error, FS
 * issue, malformed validate-iso response) terminated the worker, which
 * then caused `Promise.all(workerPromises)` to propagate the rejection
 * and abort the entire batch. With the default PARALLEL=1 for makestudio
 * a single failure killed everything past the first requirement.
 *
 * The fix:
 *   1. wrap processOne in try/catch INSIDE the worker loop, push the
 *      failure to `failedRequirements`, and continue with the next item;
 *   2. switch the orchestrator from `Promise.all` to `Promise.allSettled`
 *      so one stray rejection still doesn't poison peer workers.
 *
 * This spec exercises the canonical pattern (extracted into the helper
 * below to mirror what runPerRequirementLoop now does) and asserts:
 *   - every item gets visited even if one throws
 *   - the throwing item ends up in `failures`
 *   - cancellation via signal stops the loop cleanly
 *   - `Promise.allSettled` doesn't reject on a worker exception
 */

interface WorkItem {
  id: string;
  shouldThrow?: boolean;
}

interface RunResult {
  processed: string[];
  failures: Array<{ id: string; reason: string }>;
}

/**
 * Mirror of the workerLoop pattern in per-requirement-loop.ts. Extracted
 * here so we can drive it deterministically in tests without spinning up
 * a full subprocess + telemetry + API stack.
 */
async function runResilientWorkers(
  items: WorkItem[],
  concurrency: number,
  signal?: { aborted: boolean },
): Promise<RunResult> {
  const processed: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  let cursor = 0;

  const workerLoop = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        // Simulated unit of work. May throw to exercise the resilience path.
        await new Promise((r) => setImmediate(r));
        if (item.shouldThrow) throw new Error(`boom-${item.id}`);
        processed.push(item.id);
      } catch (err: any) {
        if (err?.aborted) return;
        failures.push({ id: item.id, reason: err.message || String(err) });
      }
    }
  };

  const promises: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) promises.push(workerLoop());
  // allSettled, not all — peer workers MUST keep going if one rejects.
  await Promise.allSettled(promises);

  return { processed, failures };
}

describe('workerLoop resilience pattern', () => {
  it('processes every item when none throw (sequential — concurrency 1)', async () => {
    const items: WorkItem[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const r = await runResilientWorkers(items, 1);
    expect(r.processed).toEqual(['a', 'b', 'c']);
    expect(r.failures).toEqual([]);
  });

  it('does NOT abort the rest when item 1 throws (concurrency 1)', async () => {
    // This is the exact regression — selecting reqs A..C, A throws,
    // B and C MUST still run. Pre-fix: only A was attempted, then abort.
    const items: WorkItem[] = [
      { id: 'a', shouldThrow: true },
      { id: 'b' },
      { id: 'c' },
    ];
    const r = await runResilientWorkers(items, 1);
    expect(r.processed).toEqual(['b', 'c']);
    expect(r.failures).toEqual([{ id: 'a', reason: 'boom-a' }]);
  });

  it('does NOT abort the rest when a middle item throws', async () => {
    const items: WorkItem[] = [
      { id: 'a' },
      { id: 'b', shouldThrow: true },
      { id: 'c' },
    ];
    const r = await runResilientWorkers(items, 1);
    expect(r.processed).toEqual(['a', 'c']);
    expect(r.failures).toEqual([{ id: 'b', reason: 'boom-b' }]);
  });

  it('handles multiple failures across the queue', async () => {
    const items: WorkItem[] = [
      { id: 'a', shouldThrow: true },
      { id: 'b' },
      { id: 'c', shouldThrow: true },
      { id: 'd' },
    ];
    const r = await runResilientWorkers(items, 1);
    expect(r.processed).toEqual(['b', 'd']);
    expect(r.failures.map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('parallel workers — peer worker keeps going when its sibling fails', async () => {
    const items: WorkItem[] = [
      { id: 'a', shouldThrow: true },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e', shouldThrow: true },
    ];
    const r = await runResilientWorkers(items, 3);
    // Order isn't deterministic with parallel workers — sort and compare.
    expect(r.processed.sort()).toEqual(['b', 'c', 'd']);
    expect(r.failures.map((f) => f.id).sort()).toEqual(['a', 'e']);
  });

  it('signal.aborted exits the worker before the next item', async () => {
    const signal = { aborted: false };
    const items: WorkItem[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    // Flip the signal mid-flight: schedule the abort to run before the
    // worker pulls the second item.
    Promise.resolve().then(() => { signal.aborted = true; });
    const r = await runResilientWorkers(items, 1, signal);
    // The first item is allowed to complete (the abort is checked at the
    // TOP of each loop iteration, not mid-await). After that, the worker
    // bails out — items b and c are NOT processed.
    expect(r.processed.length).toBeLessThan(items.length);
  });

  it('aborted-flagged exception inside processOne also halts cleanly', async () => {
    // Mimic the per-requirement-loop case where processOneRequirementTwoPass
    // throws an Error with `aborted: true`. The helper above bails out of
    // the worker without recording it as a failure (cancellation isn't a
    // requirement-level failure — the user asked to stop).
    let cursor = 0;
    const order: string[] = [];
    const failures: Array<{ id: string; reason: string }> = [];
    const items: WorkItem[] = [{ id: 'a' }, { id: 'b' }];
    const workerLoop = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          if (items[i].id === 'a') {
            throw Object.assign(new Error('cancelled'), { aborted: true });
          }
          order.push(items[i].id);
        } catch (err: any) {
          if (err?.aborted) return;
          failures.push({ id: items[i].id, reason: err.message });
        }
      }
    };
    await Promise.allSettled([workerLoop()]);
    expect(order).toEqual([]);
    expect(failures).toEqual([]);
  });
});
