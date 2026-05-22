/**
 * Smoke test for the telemetry logger + summarizer.
 *
 * Doesn't try to validate every shape — just confirms that:
 *   1. record/flush write valid JSONL
 *   2. summarizeJsonl reads it back and produces sensible numbers
 *
 * Used in Fase 0 to validate the end-to-end logging path before we
 * trust the baseline metrics for Fase 1+ comparisons.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createTelemetryLogger,
  summarizeJsonl,
  listTelemetryFiles,
} from './telemetry';

describe('telemetry logger + summary', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-telem-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a valid JSONL file from a complete run', () => {
    const logger = createTelemetryLogger({
      cwd: tmpDir,
      projectId: 'proj-x',
      cli: 'claude',
    });

    logger.record({ type: 'loop-start', totalReqs: 2 });
    logger.record({ type: 'req-start', reqIndex: 0, reqId: 'req-1', reqTitle: 'Login' });
    logger.record({ type: 'cli-spawned', reqIndex: 0, reqId: 'req-1', attempt: 1, promptBytes: 1200 });
    logger.record({ type: 'first-write', reqIndex: 0, reqId: 'req-1', attempt: 1, sinceSpawnMs: 8000, tempId: 'dum_002' });
    logger.record({ type: 'validate-start', reqIndex: 0, reqId: 'req-1', tempId: 'dum_002', setLevel: true });
    logger.record({ type: 'validate-end', reqIndex: 0, reqId: 'req-1', tempId: 'dum_002', passed: true, issuesCount: 0, durationMs: 1500 });
    logger.record({ type: 'save-end', reqIndex: 0, reqId: 'req-1', tempId: 'dum_002', durationMs: 800, success: true });
    logger.record({
      type: 'req-end',
      reqIndex: 0,
      reqId: 'req-1',
      reqTitle: 'Login',
      success: true,
      retryCount: 0,
      dumsSaved: 1,
      timeToFirstWriteMs: 8000,
      timeToValidateMs: 1500,
      timeToSaveMs: 800,
      totalDurationMs: 12000,
    });
    logger.record({ type: 'loop-end', totalReqs: 2, saved: 1, failed: 1, durationMs: 25000 });
    logger.flush();

    const files = listTelemetryFiles(tmpDir);
    expect(files.length).toBe(1);
    const summary = summarizeJsonl(files[0]);

    expect(summary.totalRuns).toBe(1);
    expect(summary.totalRequirements).toBe(1);
    expect(summary.successfulRequirements).toBe(1);
    expect(summary.failedRequirements).toBe(0);
    expect(summary.retryRate).toBe(0);
    expect(summary.avgTotalDurationMs).toBe(12000);
    expect(summary.byCli.get('claude')).toBeDefined();
    expect(summary.byCli.get('claude')?.count).toBe(1);
  });

  it('aggregates retry causes across multiple req-ends', () => {
    const logger = createTelemetryLogger({
      cwd: tmpDir,
      projectId: 'proj-y',
      cli: 'codex',
    });

    for (let i = 0; i < 3; i++) {
      logger.record({
        type: 'req-end',
        reqIndex: i,
        reqId: `req-${i}`,
        reqTitle: `t${i}`,
        success: i !== 2,
        retryCount: i > 0 ? 2 : 0,
        dumsSaved: 1,
        timeToFirstWriteMs: 5000,
        timeToValidateMs: 1000,
        timeToSaveMs: 500,
        totalDurationMs: 7500 + i * 1000,
        causeOfRetry: i > 0 ? 'criterion:complete' : undefined,
      });
    }
    logger.flush();

    const files = listTelemetryFiles(tmpDir);
    const summary = summarizeJsonl(files[0]);

    expect(summary.totalRequirements).toBe(3);
    expect(summary.failedRequirements).toBe(1);
    expect(summary.successfulRequirements).toBe(2);
    expect(summary.retryRate).toBeCloseTo(2 / 3, 2);
    expect(summary.topCausesOfRetry).toEqual([
      { cause: 'criterion:complete', count: 2 },
    ]);
  });

  it('disable() drops in-flight buffer and stops further records', () => {
    const logger = createTelemetryLogger({ cwd: tmpDir, projectId: 'p', cli: 'claude' });
    logger.record({ type: 'loop-start', totalReqs: 1 });
    logger.disable();
    logger.record({ type: 'loop-end', totalReqs: 1, saved: 1, failed: 0, durationMs: 100 });
    // Even flush should not write anything because disable cleared the buffer.
    logger.flush();
    const files = listTelemetryFiles(tmpDir);
    expect(files.length).toBe(0);
  });

  it('skips malformed lines in the JSONL file', () => {
    const filePath = path.join(tmpDir, '.makestudio', 'telemetry', 'decompose-2026-04-29.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({
        ts: new Date().toISOString(),
        runId: 'r1',
        type: 'req-end',
        projectId: 'p',
        cli: 'claude',
        success: true,
        retryCount: 0,
        dumsSaved: 1,
        timeToFirstWriteMs: 5000,
        timeToValidateMs: 1000,
        timeToSaveMs: 500,
        totalDurationMs: 7000,
      }),
      '{ this is not valid json',
      '',
    ].join('\n'));
    const summary = summarizeJsonl(filePath);
    expect(summary.totalRequirements).toBe(1);
  });
});
