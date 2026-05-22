import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPolicy, evaluate, evaluateWithMode } from './permissions';

describe('permissions — built-in deny rules', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-builtin-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    delete require.cache[require.resolve('./settings')];
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
    delete require.cache[require.resolve('./settings')];
  });

  it('blocks Read of ~/.aws/credentials', () => {
    const policy = loadPolicy();
    const action = evaluate(policy, { tool: 'Read', path: '/home/user/.aws/credentials' });
    expect(action).toBe('deny');
  });

  it('blocks Read of SSH private keys', () => {
    const policy = loadPolicy();
    expect(evaluate(policy, { tool: 'Read', path: '/home/user/.ssh/id_rsa' })).toBe('deny');
    expect(evaluate(policy, { tool: 'Read', path: '/home/user/.ssh/id_ed25519' })).toBe('deny');
  });

  it('blocks Read of kubeconfig and netrc', () => {
    const policy = loadPolicy();
    expect(evaluate(policy, { tool: 'Read', path: '/home/user/.kube/config' })).toBe('deny');
    expect(evaluate(policy, { tool: 'Read', path: '/home/user/.netrc' })).toBe('deny');
  });

  it('blocks Glob enumeration of .ssh directory', () => {
    const policy = loadPolicy();
    expect(evaluate(policy, { tool: 'Glob', path: '/home/user/.ssh/test' })).toBe('deny');
  });

  it('blocks catastrophic Bash patterns', () => {
    const policy = loadPolicy();
    expect(evaluate(policy, { tool: 'Bash', command: 'rm -rf /' })).toBe('deny');
    expect(evaluate(policy, { tool: 'Bash', command: ':() { :|:& };:' })).toBe('deny');
  });

  it('does NOT block ordinary Bash commands', () => {
    const policy = loadPolicy();
    // No deny match → policy default (ask) wins
    const action = evaluate(policy, { tool: 'Bash', command: 'ls -la' });
    expect(action).toBe('ask');
  });

  it('does NOT block Read of ordinary project files', () => {
    const policy = loadPolicy();
    const action = evaluate(policy, { tool: 'Read', path: '/home/user/project/src/index.ts' });
    expect(action).toBe('ask');
  });

  it('built-in denies still apply under bypassPermissions mode', () => {
    const policy = loadPolicy();
    expect(
      evaluateWithMode(policy, 'bypassPermissions', { tool: 'Bash', command: 'rm -rf /' }),
    ).toBe('deny');
    expect(
      evaluateWithMode(policy, 'bypassPermissions', { tool: 'Read', path: '/home/u/.ssh/id_rsa' }),
    ).toBe('deny');
  });

  it('bypassPermissions allows non-blacklisted operations', () => {
    const policy = loadPolicy();
    expect(
      evaluateWithMode(policy, 'bypassPermissions', { tool: 'Read', path: '/home/u/code/app.ts' }),
    ).toBe('allow');
  });

  it('disableBuiltinDenies setting drops the whole list', () => {
    // Mock loadSettings to return { disableBuiltinDenies: true } so the
    // permissions module skips its baked-in deny rules. We deliberately
    // bypass the on-disk settings flow (user/project/managed merging)
    // because the layered cwd-keyed cache in settings.ts makes per-test
    // injection unreliable in the jest worker.
    delete require.cache[require.resolve('./settings')];
    delete require.cache[require.resolve('./permissions')];
    jest.doMock('./settings', () => ({
      loadSettings: () => ({ disableBuiltinDenies: true }),
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadPolicy: lp, evaluate: ev } = require('./permissions');
      const policy = lp();
      const hasBuiltinDeny = policy.rules.some((r: any) =>
        r.command === 'rm -rf /' && r.action === 'deny',
      );
      expect(hasBuiltinDeny).toBe(false);
      const action = ev(policy, { tool: 'Bash', command: 'rm -rf /' });
      expect(action).toBe('ask');
    } finally {
      jest.dontMock('./settings');
      delete require.cache[require.resolve('./settings')];
      delete require.cache[require.resolve('./permissions')];
    }
  });
});
