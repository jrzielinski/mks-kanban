import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { persistToolCall, loadToolCallRecords, resetToolResultPersistCache } from './tool-result-persist';

/**
 * The persistence module reads os.homedir() to decide where to write.
 * Jest's worker context sometimes resolves homedir() to the real user
 * dir even when HOME is overridden, so we cleanup BOTH the test
 * tmpHome and the real-home subdirectory after each test.
 */
function persistDirsToCleanup(): string[] {
  return [
    path.join(process.env.HOME || '', '.makestudio', 'tool-results'),
    path.join(os.homedir(), '.makestudio', 'tool-results'),
  ].filter(Boolean);
}

describe('tool-result-persist', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let testSid: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-persist-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    testSid = 'persist-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    delete process.env.MAKESTUDIO_TOOL_PERSIST;
    resetToolResultPersistCache();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    delete process.env.MAKESTUDIO_TOOL_PERSIST;
    resetToolResultPersistCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
    // Clean up the per-test session file in BOTH possible homedirs
    // so we don't leak into the user's real ~/.makestudio.
    for (const dir of persistDirsToCleanup()) {
      try {
        const f = path.join(dir, `${testSid}.jsonl`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* */ }
    }
  });

  function makeCtxWithSession(): any {
    // Bind a session file that maps to our test sid so the
    // persistence module uses our isolated session id and doesn't
    // collide with other tests.
    const sessionsDir = path.join(os.homedir(), '.makestudio', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, `${testSid}.jsonl`);
    fs.writeFileSync(sessionFile, '', 'utf8');
    const ctx: any = { messages: [], cwd: tmpHome };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bindSessionFile } = require('../sessions');
    bindSessionFile(ctx, sessionFile);
    return ctx;
  }

  it('is a no-op when persistence is disabled (default)', () => {
    const ctx = makeCtxWithSession();
    persistToolCall(ctx, 'Read', { file_path: '/tmp/x' }, 'output', true, 12);
    const records = loadToolCallRecords(testSid);
    expect(records).toEqual([]);
  });

  it('writes a JSONL record when MAKESTUDIO_TOOL_PERSIST=1', () => {
    process.env.MAKESTUDIO_TOOL_PERSIST = '1';
    resetToolResultPersistCache();
    const ctx = makeCtxWithSession();

    persistToolCall(ctx, 'Read', { file_path: '/tmp/x' }, 'sample output', true, 42);

    const records = loadToolCallRecords(testSid);
    expect(records.length).toBe(1);
    expect(records[0].tool).toBe('Read');
    expect(records[0].output).toBe('sample output');
    expect(records[0].ok).toBe(true);
    expect(records[0].durationMs).toBe(42);
  });

  it('truncates very long outputs', () => {
    process.env.MAKESTUDIO_TOOL_PERSIST = '1';
    resetToolResultPersistCache();
    const ctx = makeCtxWithSession();

    const huge = 'X'.repeat(50_000);
    persistToolCall(ctx, 'Bash', { command: 'echo' }, huge, true, 5);

    const records = loadToolCallRecords(testSid);
    expect(records[records.length - 1].output.length).toBeLessThan(huge.length);
    expect(records[records.length - 1].output).toMatch(/truncated at \d+ chars/);
  });

  it('records the failure flag on errors', () => {
    process.env.MAKESTUDIO_TOOL_PERSIST = '1';
    resetToolResultPersistCache();
    const ctx = makeCtxWithSession();

    persistToolCall(ctx, 'Edit', { file_path: '/x' }, 'error: something', false, 1);

    const records = loadToolCallRecords(testSid);
    expect(records[records.length - 1].ok).toBe(false);
  });

  it('returns [] for unknown session ids', () => {
    expect(loadToolCallRecords('nonexistent-sid')).toEqual([]);
  });

  it('appends across multiple calls in a single session', () => {
    process.env.MAKESTUDIO_TOOL_PERSIST = '1';
    resetToolResultPersistCache();
    const ctx = makeCtxWithSession();

    for (let i = 0; i < 5; i++) {
      persistToolCall(ctx, 'Read', { file_path: `/f${i}` }, 'r' + i, true, i);
    }

    const records = loadToolCallRecords(testSid);
    expect(records.length).toBe(5);
    expect(records.map((r) => r.output)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});
