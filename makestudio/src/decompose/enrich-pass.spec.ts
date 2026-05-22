/**
 * Tests for enrich-pass.ts — Phase 3 Pass 2: enriches a single DUM
 * structure into a full DUM JSON.
 *
 * Covers: cache reset, happy path, re-engage, abort, invalid file,
 * API section map fetch, spawn env/heartbeat behavior.
 */
import type { DumStructure } from './structure-pass';
import { EventEmitter } from 'events';

// ── Module-level mocks ──────────────────────────────────────────────
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: mockSpawn }));

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(() => ({ write: jest.fn(), end: jest.fn() })),
}));

let mockHbInstance = { markActivity: jest.fn(), stop: jest.fn(), isActive: jest.fn(() => true) };
jest.mock('./silence-heartbeat', () => ({
  startSilenceHeartbeat: jest.fn(() => mockHbInstance),
}));

jest.mock('./jsonl-stream-formatter', () => ({
  JsonlStreamReader: jest.fn(() => ({ push: jest.fn(() => []), flush: jest.fn(() => []) })),
  dimC: jest.fn((s: string) => s),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runEnrichPass, _resetEnrichSectionCache } = require('./enrich-pass') as {
  runEnrichPass: (structure: DumStructure, opts: any) => Promise<any>;
  _resetEnrichSectionCache: () => void;
};

// ── Helpers ─────────────────────────────────────────────────────────
function makeFakeProc() {
  const p = new EventEmitter() as any;
  p.kill = jest.fn();
  p.stdin = { write: jest.fn(), end: jest.fn() };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}

function makeStruct(overrides: Partial<DumStructure> = {}): DumStructure {
  return { tempId: 'dum-test-001', title: 'Test', type: 'feature', summary: 'x', dependsOn: [], requirementIds: ['r1'], ...overrides };
}

function makeOpts(overrides: Record<string, any> = {}) {
  return { cwd: '/tmp/test', cliCommand: 'echo', cliArgs: ['hello'], ...overrides };
}

/** Emit close AFTER returning the promise so handlers are registered. */
async function complete(proc: any, promise: Promise<any>): Promise<any> {
  await new Promise(setImmediate);
  proc.emit('close', 0);
  return promise;
}

// ── Tests ───────────────────────────────────────────────────────────

test('_resetEnrichSectionCache is idempotent', () => {
  _resetEnrichSectionCache();
  _resetEnrichSectionCache();
});

describe('runEnrichPass', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockHbInstance = { markActivity: jest.fn(), stop: jest.fn(), isActive: jest.fn(() => true) };
    _resetEnrichSectionCache();
  });

  test('success: returns written=true for valid DUM file', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const r = await complete(proc, runEnrichPass(makeStruct(), makeOpts()));
    expect(r.written).toBe(true);
    expect(r.dumPath).toContain('dum-test-001.json');
  });

  test('re-engage: spawns again when file missing', async () => {
    const p1 = makeFakeProc(), p2 = makeFakeProc();
    mockSpawn.mockReturnValueOnce(p1).mockReturnValueOnce(p2);
    mockExistsSync.mockReturnValue(false);

    const resultP = runEnrichPass(makeStruct(), makeOpts());
    await new Promise(setImmediate);
    p1.emit('close', 0);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    p2.emit('close', 0);
    const r = await resultP;

    expect(r.written).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test('re-engage: salvages when second spawn writes file', async () => {
    const p1 = makeFakeProc(), p2 = makeFakeProc();
    mockSpawn.mockReturnValueOnce(p1).mockReturnValueOnce(p2);
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts());
    await new Promise(setImmediate);
    p1.emit('close', 0);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    p2.emit('close', 0);
    const r = await resultP;

    expect(r.written).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test('re-engage: skipped on abort', async () => {
    const ac = new AbortController();
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(false);

    const resultP = runEnrichPass(makeStruct(), makeOpts({ signal: ac.signal }));
    ac.abort();
    await new Promise(setImmediate);
    proc.emit('close', 0);
    const r = await resultP;

    expect(r.written).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test('re-engage: spawn error does not crash', async () => {
    const p1 = makeFakeProc();
    mockSpawn.mockReturnValueOnce(p1);
    const p2 = makeFakeProc();
    mockSpawn.mockReturnValueOnce(p2);
    mockExistsSync.mockReturnValue(false);

    const resultP = runEnrichPass(makeStruct(), makeOpts());
    await new Promise(setImmediate);
    p1.emit('close', 0);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    p2.emit('error', new Error('ENOENT'));
    await new Promise(setImmediate);
    const r = await resultP;

    expect(r.written).toBe(false);
  });

  test('invalid: bad JSON returns written=false', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');

    const r = await complete(proc, runEnrichPass(makeStruct(), makeOpts()));
    expect(r.written).toBe(false);
    expect(r.dumPath).not.toBeNull();
  });

  test('invalid: missing required fields returns written=false', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'x' }));

    const r = await complete(proc, runEnrichPass(makeStruct(), makeOpts()));
    expect(r.written).toBe(false);
  });

  test('abort: kills subprocess on signal', async () => {
    const ac = new AbortController();
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts({ signal: ac.signal }));
    await new Promise(setImmediate);
    ac.abort();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    proc.emit('close', 0);
    const r = await resultP;
    expect(r.written).toBe(true);
  });

  test('api: fetches section map from backend', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { sectionsByType: { feature: ['A'] }, typeAliases: {} },
    });
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts({ api: { get } }));
    await new Promise(setImmediate);
    proc.emit('close', 0);
    await resultP;
    expect(get).toHaveBeenCalledWith('/dark-factory/projects/quality-contract/sections', expect.any(Object));
  });

  test('api: failure does not block enrichment', async () => {
    const get = jest.fn().mockRejectedValue(new Error('fail'));
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts({ api: { get } }));
    await new Promise(setImmediate);
    proc.emit('close', 0);
    const r = await resultP;
    expect(r.written).toBe(true);
  });

  test('spawn: passes decomp env vars', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts({ cliCommand: 'makestudio', cliArgs: ['--json', 'x'] }));
    await new Promise(setImmediate);
    proc.emit('close', 0);
    await resultP;
    const env = mockSpawn.mock.calls[0][2].env;
    expect(env.MAKESTUDIO_DECOMPOSITION_TEMPID).toBe('dum-test-001');
    expect(env.MAKESTUDIO_DECOMPOSITION_TYPE).toBe('feature');
  });

  test('spawn: starts heartbeat and stops on close', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts());
    await new Promise(setImmediate);
    proc.emit('close', 0);
    await resultP;
    expect(mockHbInstance.stop).toHaveBeenCalled();
  });

  test('spawn: stdout data marks heartbeat activity', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tempId: 'dum-test-001', title: 'T', tasks: [] }));

    const resultP = runEnrichPass(makeStruct(), makeOpts());
    await new Promise(setImmediate);
    proc.stdout.emit('data', Buffer.from('hello'));
    proc.emit('close', 0);
    await resultP;
    expect(mockHbInstance.markActivity).toHaveBeenCalled();
  });
});
