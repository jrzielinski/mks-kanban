import { PluginRegistry } from './plugin-registry';

function mkPlugin(name: string, extras: Partial<any> = {}): any {
  return { name, version: '1.0.0', ...extras };
}

describe('PluginRegistry', () => {
  let reg: PluginRegistry;

  beforeEach(() => { reg = new PluginRegistry(); });

  describe('register / unregister / has / count / clear', () => {
    it('registers a new plugin', () => {
      reg.register(mkPlugin('a'));
      expect(reg.has('a')).toBe(true);
      expect(reg.count()).toBe(1);
    });

    it('skips duplicates silently', () => {
      reg.register(mkPlugin('a'));
      reg.register(mkPlugin('a'));
      expect(reg.count()).toBe(1);
    });

    it('unregister removes a plugin by name', () => {
      reg.register(mkPlugin('a'));
      reg.unregister('a');
      expect(reg.has('a')).toBe(false);
    });

    it('clear wipes all plugins', () => {
      reg.register(mkPlugin('a'));
      reg.register(mkPlugin('b'));
      reg.clear();
      expect(reg.count()).toBe(0);
    });
  });

  describe('getAll / contribution queries', () => {
    it('getAll returns only enabled plugins', () => {
      reg.register(mkPlugin('a'));
      reg.register(mkPlugin('b'));
      expect(reg.getAll().map((p) => p.name).sort()).toEqual(['a', 'b']);
    });

    it('getCommands aggregates commands across plugins', () => {
      reg.register(mkPlugin('a', { commands: [{ name: 'foo' }, { name: 'bar' }] }));
      reg.register(mkPlugin('b', { commands: [{ name: 'baz' }] }));
      expect(reg.getCommands().map((c: any) => c.name).sort()).toEqual(['bar', 'baz', 'foo']);
    });

    it('getCLIStrategies aggregates from every plugin', () => {
      reg.register(mkPlugin('a', { cliStrategies: [{ name: 'custom' }] }));
      reg.register(mkPlugin('b'));
      expect(reg.getCLIStrategies().length).toBe(1);
    });

    it('getVerifyChecks aggregates verify checks', () => {
      reg.register(mkPlugin('a', { verifyChecks: [{ name: 'lint', run: async () => ({ passed: true }) }] }));
      expect(reg.getVerifyChecks().length).toBe(1);
    });

    it('getContextProviders aggregates providers', () => {
      reg.register(mkPlugin('a', { contextProviders: [{ name: 'ctx', fetch: async () => '' }] }));
      expect(reg.getContextProviders().length).toBe(1);
    });

    it('returns empty arrays when no plugin contributes', () => {
      reg.register(mkPlugin('a'));
      expect(reg.getCommands()).toEqual([]);
      expect(reg.getCLIStrategies()).toEqual([]);
      expect(reg.getVerifyChecks()).toEqual([]);
      expect(reg.getContextProviders()).toEqual([]);
    });
  });

  describe('runBeforeTaskExec', () => {
    it('chains modifications through plugins in order', async () => {
      reg.register(mkPlugin('a', {
        hooks: { beforeTaskExec: async (t: any) => ({ ...t, prompt: (t.prompt || '') + ' | a' }) },
      }));
      reg.register(mkPlugin('b', {
        hooks: { beforeTaskExec: async (t: any) => ({ ...t, prompt: (t.prompt || '') + ' | b' }) },
      }));
      const out = await reg.runBeforeTaskExec({ taskId: 't', prompt: 'x' } as any);
      expect(out.prompt).toBe('x | a | b');
    });

    it('continues with unmodified task when a hook throws', async () => {
      reg.register(mkPlugin('a', {
        hooks: { beforeTaskExec: async () => { throw new Error('boom'); } },
      }));
      const out = await reg.runBeforeTaskExec({ taskId: 't', prompt: 'original' } as any);
      expect(out.prompt).toBe('original');
    });
  });

  describe('runBeforeGitPush', () => {
    it('returns true when no plugins veto', async () => {
      reg.register(mkPlugin('a', { hooks: { beforeGitPush: async () => true } }));
      expect(await reg.runBeforeGitPush({ repoPath: '/x', branch: 'b', taskId: 't' })).toBe(true);
    });

    it('returns false when ANY plugin returns false', async () => {
      reg.register(mkPlugin('a', { hooks: { beforeGitPush: async () => true } }));
      reg.register(mkPlugin('b', { hooks: { beforeGitPush: async () => false } }));
      expect(await reg.runBeforeGitPush({ repoPath: '/x', branch: 'b', taskId: 't' })).toBe(false);
    });

    it('fails open when a hook throws (push allowed)', async () => {
      reg.register(mkPlugin('a', { hooks: { beforeGitPush: async () => { throw new Error('x'); } } }));
      expect(await reg.runBeforeGitPush({ repoPath: '/x', branch: 'b', taskId: 't' })).toBe(true);
    });
  });

  describe('runOnError', () => {
    it('returns "fail" by default when no plugin handles the error', async () => {
      const r = await reg.runOnError({ taskId: 't' } as any, new Error('x'));
      expect(r).toBe('fail');
    });

    it('first definitive answer wins', async () => {
      reg.register(mkPlugin('a', { hooks: { onError: async () => 'retry' as const } }));
      reg.register(mkPlugin('b', { hooks: { onError: async () => 'fail' as const } }));
      expect(await reg.runOnError({ taskId: 't' } as any, new Error('x'))).toBe('retry');
    });

    it('skips hooks that throw and continues to next plugin', async () => {
      reg.register(mkPlugin('a', { hooks: { onError: async () => { throw new Error('x'); } } }));
      reg.register(mkPlugin('b', { hooks: { onError: async () => 'skip' as const } }));
      expect(await reg.runOnError({ taskId: 't' } as any, new Error('x'))).toBe('skip');
    });
  });
});
