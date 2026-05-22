import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  saveLastRun,
  loadLastRun,
  clearLastRun,
  updateLastRun,
  lastRunAgeMinutes,
  LastRunState,
} from './last-run';

function base(state: Partial<LastRunState> = {}): LastRunState {
  const now = new Date().toISOString();
  return {
    version: 1,
    projectId: 'p1',
    cli: 'claude',
    executionMode: 'all',
    startedAt: now,
    lastUpdatedAt: now,
    completedDums: [],
    ...state,
  };
}

describe('last-run', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lastrun-'));
  });

  afterEach(() => {
    try { fs.rmSync(projectPath, { recursive: true, force: true }); } catch {}
  });

  describe('saveLastRun + loadLastRun', () => {
    it('round-trips a state object', () => {
      const s = base({ cli: 'codex', completedDums: ['dum_001'] });
      saveLastRun(projectPath, s);
      const loaded = loadLastRun(projectPath);
      expect(loaded).toEqual(s);
    });

    it('creates .makestudio directory if missing', () => {
      saveLastRun(projectPath, base());
      expect(fs.existsSync(path.join(projectPath, '.makestudio', 'last-run.json'))).toBe(true);
    });

    it('loadLastRun returns null when the file does not exist', () => {
      expect(loadLastRun(projectPath)).toBeNull();
    });

    it('loadLastRun returns null for invalid JSON', () => {
      fs.mkdirSync(path.join(projectPath, '.makestudio'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, '.makestudio', 'last-run.json'), '{not json');
      expect(loadLastRun(projectPath)).toBeNull();
    });

    it('loadLastRun rejects future versions', () => {
      fs.mkdirSync(path.join(projectPath, '.makestudio'), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, '.makestudio', 'last-run.json'),
        JSON.stringify({ version: 2, projectId: 'x', cli: 'claude' }),
      );
      expect(loadLastRun(projectPath)).toBeNull();
    });
  });

  describe('clearLastRun', () => {
    it('removes the file when present', () => {
      saveLastRun(projectPath, base());
      clearLastRun(projectPath);
      expect(loadLastRun(projectPath)).toBeNull();
    });

    it('no-ops when the file is absent', () => {
      // Should not throw
      clearLastRun(projectPath);
      expect(loadLastRun(projectPath)).toBeNull();
    });
  });

  describe('updateLastRun', () => {
    it('merges the patch on top of the existing state and refreshes lastUpdatedAt', async () => {
      const start = base({ lastUpdatedAt: '2020-01-01T00:00:00.000Z' });
      saveLastRun(projectPath, start);
      // Small delay so lastUpdatedAt moves forward.
      await new Promise((r) => setTimeout(r, 10));
      updateLastRun(projectPath, { lastActiveDum: 'dum_005', completedDums: ['dum_001', 'dum_002'] });
      const loaded = loadLastRun(projectPath)!;
      expect(loaded.lastActiveDum).toBe('dum_005');
      expect(loaded.completedDums).toEqual(['dum_001', 'dum_002']);
      expect(new Date(loaded.lastUpdatedAt).getTime()).toBeGreaterThan(new Date(start.lastUpdatedAt).getTime());
    });

    it('no-ops when no prior state exists', () => {
      updateLastRun(projectPath, { lastActiveDum: 'x' });
      expect(loadLastRun(projectPath)).toBeNull();
    });
  });

  describe('lastRunAgeMinutes', () => {
    it('returns null when there is no prior run', () => {
      expect(lastRunAgeMinutes(projectPath)).toBeNull();
    });

    it('returns 0 for a freshly-saved run', () => {
      saveLastRun(projectPath, base());
      const age = lastRunAgeMinutes(projectPath);
      expect(age).not.toBeNull();
      expect(age!).toBeLessThan(2);
    });

    it('returns the rounded age in minutes for older runs', () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      saveLastRun(projectPath, base({ lastUpdatedAt: oneHourAgo }));
      const age = lastRunAgeMinutes(projectPath);
      expect(age).toBeGreaterThanOrEqual(59);
      expect(age!).toBeLessThanOrEqual(61);
    });
  });
});
