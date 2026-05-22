import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runShell,
  verifyConstraints,
  formatVerifierResults,
} from './session-constraint-verifier';
import { addConstraint, clearConstraints } from './session-constraints';

describe('runShell — language-agnostic exit-code reader', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-shell-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('returns exit 0 for true', () => {
    const r = runShell('true', { cwd: tmp });
    expect(r.exitCode).toBe(0);
  });

  it('returns the actual exit code for non-zero', () => {
    const r = runShell('exit 7', { cwd: tmp });
    expect(r.exitCode).toBe(7);
  });

  it('captures stderr tail when the command fails', () => {
    const r = runShell('echo "boom" 1>&2; exit 1', { cwd: tmp });
    expect(r.exitCode).toBe(1);
    expect(r.stderrTail).toContain('boom');
  });

  it('runs in the cwd it was given', () => {
    fs.writeFileSync(path.join(tmp, 'marker.txt'), 'hi');
    const r = runShell('test -f marker.txt', { cwd: tmp });
    expect(r.exitCode).toBe(0);
  });

  it('does not assume any specific tool — works for whatever the user pinned', () => {
    // The verifier never inspects the command; it just spawns and reads
    // exit code. Any shell line is valid.
    expect(runShell('echo "node-style"', { cwd: tmp }).exitCode).toBe(0);
    expect(runShell('echo "rust-style" && true', { cwd: tmp }).exitCode).toBe(0);
    expect(runShell('false || exit 42', { cwd: tmp }).exitCode).toBe(42);
  });
});

describe('verifyConstraints — dispatch by verifyCommand presence', () => {
  let tmp: string;
  let ctx: any;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-verify-'));
    ctx = { __turnSeq: 1, cwd: tmp };
    clearConstraints(ctx);
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns [] when no constraints are pinned', () => {
    expect(verifyConstraints(ctx)).toEqual([]);
  });

  it('SKIP for constraints without a verifyCommand (model self-verifies)', () => {
    addConstraint(ctx, 'do not commit without permission');
    const r = verifyConstraints(ctx);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('SKIP');
    expect(r[0].detail).toMatch(/no verifyCommand/);
  });

  it('PASS when verifyCommand exits 0', () => {
    addConstraint(ctx, 'tests must pass', 'true');
    const r = verifyConstraints(ctx);
    expect(r[0].status).toBe('PASS');
    expect(r[0].detail).toMatch(/exited 0/);
  });

  it('FAIL when verifyCommand exits non-zero, surfacing exit code and stderr tail', () => {
    addConstraint(ctx, 'tests must pass', 'echo "bad" 1>&2; exit 3');
    const r = verifyConstraints(ctx);
    expect(r[0].status).toBe('FAIL');
    expect(r[0].detail).toMatch(/exited 3/);
    expect(r[0].detail).toMatch(/bad/);
  });

  it('handles MULTIPLE constraints independently — language-agnostic for each', () => {
    addConstraint(ctx, 'rule A', 'true');                   // PASS
    addConstraint(ctx, 'rule B', 'false');                  // FAIL
    addConstraint(ctx, 'rule C');                           // SKIP (no command)
    const r = verifyConstraints(ctx);
    expect(r.map((x) => x.status)).toEqual(['PASS', 'FAIL', 'SKIP']);
  });

  it('uses the ctx.cwd as the working directory for the verify command', () => {
    fs.writeFileSync(path.join(tmp, 'expected.txt'), '');
    addConstraint(ctx, 'file present', 'test -f expected.txt');
    expect(verifyConstraints(ctx)[0].status).toBe('PASS');
    fs.unlinkSync(path.join(tmp, 'expected.txt'));
    expect(verifyConstraints(ctx)[0].status).toBe('FAIL');
  });

  it('does not assume Node/TS — equally happy with cargo / pytest / mvn / go / flutter shells', () => {
    // Use stub commands that ALWAYS exit 0 so the test doesn't depend
    // on the host having those tools — the point is the verifier
    // doesn't inspect the command itself.
    const stubs = [
      ':',
      'true',
      'echo cargo',
      'echo pytest',
      'echo mvn',
      'echo flutter',
      'echo go',
    ];
    stubs.forEach((cmd, i) => addConstraint(ctx, `r${i}`, cmd));
    const r = verifyConstraints(ctx);
    expect(r.every((x) => x.status === 'PASS')).toBe(true);
  });
});

describe('formatVerifierResults', () => {
  it('returns null when no results', () => {
    expect(formatVerifierResults([])).toBeNull();
  });

  it('returns a short PASS line when all constraints passed', () => {
    const out = formatVerifierResults([
      { constraint: 'X', status: 'PASS', detail: '' },
    ]);
    expect(out).toMatch(/all PASS/);
  });

  it('returns a short PASS line when all constraints are SKIP (nothing to nag about)', () => {
    const out = formatVerifierResults([
      { constraint: 'X', status: 'SKIP', detail: 'no verifyCommand' },
    ]);
    expect(out).toMatch(/all PASS/);
  });

  it('lists FAIL constraints with detail', () => {
    const out = formatVerifierResults([
      { constraint: 'X', status: 'PASS', detail: '' },
      { constraint: 'Y', status: 'FAIL', detail: '`cmd` exited 1' },
    ]);
    expect(out).toMatch(/1\/2 unmet/);
    expect(out).toMatch(/✗ FAIL/);
    expect(out).toMatch(/cmd/);
  });
});
