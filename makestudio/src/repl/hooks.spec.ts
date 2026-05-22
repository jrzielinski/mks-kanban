import {
  runHooks,
  loadHooks,
  registerPluginHooks,
  __clearPluginHooksForTests,
  listAsyncHooks,
} from './hooks';

describe('listAsyncHooks', () => {
  it('returns empty array when no hooks running', () => {
    expect(listAsyncHooks()).toEqual([]);
  });
});

describe('registerPluginHooks', () => {
  beforeEach(() => __clearPluginHooksForTests());
  afterEach(() => __clearPluginHooksForTests());

  it('adds entries to event array', () => {
    registerPluginHooks('PreToolUse', [{ type: 'command', command: 'echo test' }]);
    const hooks = loadHooks();
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it('dedupes duplicate entries', () => {
    const entry = { type: 'command', command: 'echo test2' };
    registerPluginHooks('PreToolUse', [entry]);
    registerPluginHooks('PreToolUse', [entry]);
    const hooks = loadHooks();
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it('adds distinct entries separately', () => {
    registerPluginHooks('PreToolUse', [{ type: 'command', command: 'a.sh' }]);
    registerPluginHooks('PostToolUse', [{ type: 'command', command: 'b.sh' }]);
    const hooks = loadHooks();
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
  });
});

describe('runHooks', () => {
  beforeEach(() => __clearPluginHooksForTests());

  it('returns ok for event with no hooks', async () => {
    const result = await runHooks('SessionStart');
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
