import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  planFilePath,
  readPlan,
  buildPlanPrompt,
  ensurePlanFile,
} from './plan-mode';

describe('planFilePath', () => {
  it('returns a slugified path under .makestudio/plans/', () => {
    const p = planFilePath('/project', 'DUM-003');
    expect(p).toContain(path.join('.makestudio', 'plans'));
    expect(p).toContain('dum-003.md');
  });

  it('lowercases and collapses non-alphanumerics in the slug', () => {
    expect(planFilePath('/p', 'DUM_005 — RBAC & Auth!')).toContain('dum-005-rbac-auth-.md');
  });
});

describe('readPlan + ensurePlanFile', () => {
  let projectPath: string;

  beforeEach(() => { projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')); });
  afterEach(() => { try { fs.rmSync(projectPath, { recursive: true, force: true }); } catch {} });

  it('readPlan returns null when no plan file exists', () => {
    expect(readPlan(projectPath, 'DUM-1')).toBeNull();
  });

  it('ensurePlanFile creates the plans/ dir and an empty plan', () => {
    const f = ensurePlanFile(projectPath, 'DUM-1');
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('');
  });

  it('readPlan returns the file content once populated', () => {
    const f = ensurePlanFile(projectPath, 'DUM-2');
    fs.writeFileSync(f, '# Plano!');
    expect(readPlan(projectPath, 'DUM-2')).toBe('# Plano!');
  });

  it('ensurePlanFile is idempotent and preserves existing content', () => {
    const f = ensurePlanFile(projectPath, 'DUM-3');
    fs.writeFileSync(f, '# Plano existente');
    ensurePlanFile(projectPath, 'DUM-3');
    expect(fs.readFileSync(f, 'utf8')).toBe('# Plano existente');
  });
});

describe('buildPlanPrompt', () => {
  const dum = { dumNumber: 'DUM-7', title: 'Contacts', description: 'Add CRUD for contacts.' };
  const tasks = [
    { type: 'feature', title: 'Entity + migration' },
    { type: 'test', title: 'Controller tests' },
  ];

  it('includes DUM number and title', () => {
    const p = buildPlanPrompt(dum, tasks, 'acme', '.makestudio/plans/dum-7.md');
    expect(p).toContain('DUM-7: Contacts');
  });

  it('lists every pending task with its type', () => {
    const p = buildPlanPrompt(dum, tasks, 'acme', '.makestudio/plans/dum-7.md');
    expect(p).toContain('[feature] Entity + migration');
    expect(p).toContain('[test] Controller tests');
  });

  it('handles missing description gracefully', () => {
    const p = buildPlanPrompt({ dumNumber: 'D', title: 'T' }, [], 'x', '.makestudio/plans/d.md');
    expect(p).toContain('(no description)');
  });

  it('handles empty task list', () => {
    const p = buildPlanPrompt(dum, [], 'acme', '.makestudio/plans/dum-7.md');
    expect(p).toContain('(no pending tasks)');
  });

  it('tells the agent to write only the provided plan path', () => {
    const p = buildPlanPrompt(dum, tasks, 'acme', 'plans/my-plan.md');
    expect(p).toContain('plans/my-plan.md');
    expect(p).toContain('Write the plan file now, then stop');
  });

  it('defaults task type to "feature" when missing', () => {
    const p = buildPlanPrompt(dum, [{ title: 'Untyped' }], 'acme', 'x.md');
    expect(p).toContain('[feature] Untyped');
  });
});
