import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beginTurn, recordFileSnapshot, diffTurns } from './rewind';
import { bindSessionFile } from './sessions';

/**
 * Set up an in-process REPL ctx with the minimum surface that the
 * rewind module reads. The session file MUST be bound via bindSessionFile
 * so currentSessionFile() can locate it (it's tracked on a WeakMap, not
 * directly on ctx).
 */
function makeCtx(tmpHome: string, sessionId = 'test-session') {
  const sessionDir = path.join(tmpHome, '.makestudio', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, '', 'utf8');
  const ctx = {
    sessionFile,
    messages: [],
    currentTurnNum: 0,
    cwd: tmpHome,
  };
  bindSessionFile(ctx as any, sessionFile);
  return ctx;
}

describe('rewind.diffTurns', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let testSessionId: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-diff-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Use a unique session id per test so the rewind module's
    // ~/.makestudio/checkpoints/<sid>/ directory is isolated even if
    // jest's runtime ends up resolving os.homedir() to the real
    // user home rather than our tmpHome (Node sometimes reads
    // userInfo() instead of HOME in worker contexts).
    testSessionId = 'rwd-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
    // Belt-and-braces cleanup: also remove the checkpoint dir under
    // the REAL home, in case homedir() bypassed our HOME override.
    try {
      const realCheckpointDir = path.join(os.homedir(), '.makestudio', 'checkpoints', testSessionId);
      fs.rmSync(realCheckpointDir, { recursive: true, force: true });
    } catch { /* */ }
  });

  it('returns empty when no checkpoints exist', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    expect(diffTurns(ctx as any, 1, 5)).toEqual([]);
  });

  it('reports created status for newly authored files', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    const target = path.join(tmpHome, 'new-file.txt');
    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, target);
    fs.writeFileSync(target, 'hello world', 'utf8');

    const diff = diffTurns(ctx as any, 1, 1);
    expect(diff).toHaveLength(1);
    expect(diff[0].status).toBe('created');
    expect(diff[0].after).toBe('hello world');
    expect(diff[0].before).toBe('');
  });

  it('reports modified status when content changes', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    const target = path.join(tmpHome, 'mod.txt');
    fs.writeFileSync(target, 'original', 'utf8');

    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, target);
    fs.writeFileSync(target, 'updated', 'utf8');

    const diff = diffTurns(ctx as any, 1, 1);
    expect(diff).toHaveLength(1);
    expect(diff[0].status).toBe('modified');
    expect(diff[0].before).toBe('original');
    expect(diff[0].after).toBe('updated');
  });

  it('reports deleted status when file was removed after snapshot', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    const target = path.join(tmpHome, 'del.txt');
    fs.writeFileSync(target, 'doomed', 'utf8');

    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, target);
    fs.unlinkSync(target);

    const diff = diffTurns(ctx as any, 1, 1);
    expect(diff).toHaveLength(1);
    expect(diff[0].status).toBe('deleted');
    expect(diff[0].before).toBe('doomed');
    expect(diff[0].after).toBe('');
  });

  it('reports unchanged when file was touched but content reverted', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    const target = path.join(tmpHome, 'revert.txt');
    fs.writeFileSync(target, 'same', 'utf8');

    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, target);
    // Don't change content — still 'same' at end of range.

    const diff = diffTurns(ctx as any, 1, 1);
    expect(diff).toHaveLength(1);
    expect(diff[0].status).toBe('unchanged');
  });

  it('uses the EARLIEST snapshot in range as the before state', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    const target = path.join(tmpHome, 'multi.txt');
    fs.writeFileSync(target, 'v0', 'utf8');

    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, target);
    fs.writeFileSync(target, 'v1', 'utf8');

    beginTurn(ctx as any, 'turn 2');
    recordFileSnapshot(ctx as any, target);
    fs.writeFileSync(target, 'v2', 'utf8');

    const diff = diffTurns(ctx as any, 1, 2);
    expect(diff).toHaveLength(1);
    expect(diff[0].before).toBe('v0'); // earliest snapshot
    expect(diff[0].after).toBe('v2');  // current state
    expect(diff[0].turns).toEqual([1, 2]);
  });

  it('respects from-to range exclusively', () => {
    const ctx = makeCtx(tmpHome, testSessionId);
    const target = path.join(tmpHome, 'range.txt');

    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, target);
    fs.writeFileSync(target, 'after-1', 'utf8');

    beginTurn(ctx as any, 'turn 2');
    fs.writeFileSync(target, 'after-2', 'utf8');

    // Diff turn 2 only — file wasn't snapshotted in turn 2 (we
    // didn't call recordFileSnapshot), so it should not appear.
    const diff = diffTurns(ctx as any, 2, 2);
    expect(diff).toEqual([]);
  });

  it('sorts results: created → modified → deleted → unchanged', () => {
    const ctx = makeCtx(tmpHome, testSessionId);

    const created = path.join(tmpHome, 'a-created.txt');
    const modified = path.join(tmpHome, 'b-modified.txt');
    fs.writeFileSync(modified, 'orig', 'utf8');

    beginTurn(ctx as any, 'turn 1');
    recordFileSnapshot(ctx as any, modified);
    recordFileSnapshot(ctx as any, created);
    fs.writeFileSync(modified, 'changed', 'utf8');
    fs.writeFileSync(created, 'new', 'utf8');

    const diff = diffTurns(ctx as any, 1, 1);
    expect(diff[0].status).toBe('created');
    expect(diff[1].status).toBe('modified');
  });
});
