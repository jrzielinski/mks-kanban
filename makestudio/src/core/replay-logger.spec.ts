import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  startReplaySession,
  endReplaySession,
  logReplay,
  logToolCall,
  logFileChange,
  logGitOp,
  logCost,
  logVerify,
  logRetry,
  getReplaySessionFile,
  setReplayDir,
  getReplayDir,
  cleanupOldReplays,
} from './replay-logger';

function readJsonl(file: string) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('replay-logger', () => {
  let tmp: string;
  let prev: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
    prev = setReplayDir(tmp);
  });

  afterEach(() => {
    endReplaySession();
    setReplayDir(prev);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('setReplayDir / getReplayDir round-trip', () => {
    expect(getReplayDir()).toBe(tmp);
  });

  it('writes a session_start entry when starting a new session', () => {
    startReplaySession('sess-1');
    const file = getReplaySessionFile()!;
    expect(file).toBe(path.join(tmp, 'sess-1.jsonl'));
    const entries = readJsonl(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('session_start');
    expect(entries[0].data.sessionId).toBe('sess-1');
  });

  it('ends previous session automatically when a new one starts', () => {
    startReplaySession('a');
    startReplaySession('b');
    const aFile = path.join(tmp, 'a.jsonl');
    const entriesA = readJsonl(aFile);
    expect(entriesA.map((e) => e.type)).toEqual(['session_start', 'session_end']);
    expect(getReplaySessionFile()).toBe(path.join(tmp, 'b.jsonl'));
  });

  it('endReplaySession writes a session_end entry', () => {
    startReplaySession('sess-x');
    const file = getReplaySessionFile()!;
    endReplaySession();
    const entries = readJsonl(file);
    expect(entries.map((e) => e.type)).toEqual(['session_start', 'session_end']);
    expect(getReplaySessionFile()).toBeNull();
  });

  it('logReplay is a no-op when no session is active', () => {
    logReplay('anything');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('logs every helper type with the right shape', () => {
    startReplaySession('helpers');
    logToolCall('t1', 'Read', 'src/a.ts');
    logFileChange('t1', 'src/b.ts', 'modified');
    logGitOp('t1', 'commit', '1 commit');
    logCost('t1', 0.25, 'claude');
    logVerify('t1', true);
    logRetry('t1', 2, 'compile');

    const file = getReplaySessionFile()!;
    const entries = readJsonl(file);
    const types = entries.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('file_change');
    expect(types).toContain('git_op');
    expect(types).toContain('cost');
    expect(types).toContain('verify');
    expect(types).toContain('retry');
    expect(entries.every((e) => e.taskId === 't1' || e.type.startsWith('session'))).toBe(true);
  });

  it('logVerify truncates large output to 500 chars', () => {
    startReplaySession('trunc');
    const big = 'x'.repeat(2000);
    logVerify('tt', false, big);
    const file = getReplaySessionFile()!;
    const entries = readJsonl(file);
    const verify = entries.find((e) => e.type === 'verify')!;
    expect(verify.data.output.length).toBe(500);
  });

  it('cleanupOldReplays keeps the newest 50 files', () => {
    endReplaySession();
    // Create 55 fake replay files with staggered mtimes.
    const now = Date.now();
    for (let i = 0; i < 55; i++) {
      const name = path.join(tmp, `sess-${i}.jsonl`);
      fs.writeFileSync(name, '');
      fs.utimesSync(name, (now - i * 1000) / 1000, (now - i * 1000) / 1000);
    }
    cleanupOldReplays();
    const remaining = fs.readdirSync(tmp).filter((f) => f.endsWith('.jsonl'));
    expect(remaining.length).toBe(50);
    // The 5 oldest (highest i) must be gone.
    for (let i = 50; i < 55; i++) {
      expect(remaining).not.toContain(`sess-${i}.jsonl`);
    }
  });
});
