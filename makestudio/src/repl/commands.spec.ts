import {
  parseSlashArgs,
  printHelp,
  handleProjectSelect,
  handleProjectsList,
  handleCostCommand,
  handleCtxCommand,
  handleProviderSwitch,
  handleModelCommand,
} from './commands';

// ── Mock console.log ────────────────────────────────────────────────
let logLines: string[] = [];
const origLog = console.log;
beforeEach(() => { logLines = []; console.log = jest.fn((...args: any[]) => { logLines.push(args.join(' ')); }); });
afterEach(() => { console.log = origLog; });

function makeMockCtx(overrides: any = {}): any {
  return {
    activeProject: null,
    provider: 'claude',
    usage: {
      promptTokens: 500,
      completionTokens: 200,
      totalTokens: 700,
      cacheReads: 0,
      cacheWrites: 0,
      cacheMisses: 0,
      requestCount: 5,
      sessionStartedAt: Date.now() - 60000,
    },
    providerInfo: { provider: 'anthropic', model: 'claude-sonnet-4' },
    messages: [],
    fetchProjects: jest.fn().mockResolvedValue([]),
    setActiveProject: jest.fn(),
    buildSystemPrompt: jest.fn().mockReturnValue('system prompt content'),
    lastUserMessage: '',
    ...overrides,
  };
}

// ── Mock dynamic requires ──────────────────────────────────────────
jest.mock('../core/plugin-registry', () => ({
  pluginRegistry: {
    getCommands: jest.fn().mockReturnValue([]),
  },
}), { virtual: true });

jest.mock('./memory', () => ({
  findRelevant: jest.fn().mockReturnValue([]),
}), { virtual: true });

jest.mock('./ai/tools', () => ({
  toolDefinitions: [],
}), { virtual: true });

jest.mock('./ai/providers/catalog', () => ({
  fetchCatalog: jest.fn().mockResolvedValue({
    fast: { provider: 'groq', model: 'llama-4-scout-17b' },
    default: { provider: 'anthropic', model: 'claude-sonnet-4' },
    image: { provider: 'anthropic', model: 'claude-sonnet-4' },
  }),
  getCatalog: jest.fn().mockReturnValue({
    fast: { provider: 'groq', model: 'llama-4-scout-17b' },
    default: { provider: 'anthropic', model: 'claude-sonnet-4' },
    image: { provider: 'anthropic', model: 'claude-sonnet-4' },
  }),
  tierAvailable: jest.fn().mockReturnValue(true),
  overrideEntry: jest.fn(),
}), { virtual: true });

// ────────────────────────────────────────────────────────────────────
describe('parseSlashArgs', () => {
  it('returns empty object when no flags', () => {
    expect(parseSlashArgs('/cmd some positional args')).toEqual({});
  });

  it('parses --key value', () => {
    expect(parseSlashArgs('--strategy claude-code')).toEqual({ strategy: 'claude-code' });
  });

  it('parses multiple flags', () => {
    expect(parseSlashArgs('/execute --mode fast --cli claude --retries 3'))
      .toEqual({ mode: 'fast', cli: 'claude', retries: '3' });
  });

  it('treats bare --flag as "true"', () => {
    expect(parseSlashArgs('/cmd --verbose --dry-run')).toEqual({ verbose: 'true', dryRun: 'true' });
  });

  it('converts kebab-case to camelCase', () => {
    expect(parseSlashArgs('--skip-review x')).toEqual({ skipReview: 'x' });
  });

  it('does not consume next flag as value', () => {
    expect(parseSlashArgs('--a --b')).toEqual({ a: 'true', b: 'true' });
  });

  it('handles extra whitespace', () => {
    expect(parseSlashArgs('   /cmd    --mode    fast   ')).toEqual({ mode: 'fast' });
  });
});

// ────────────────────────────────────────────────────────────────────
describe('printHelp', () => {
  it('prints help with expected sections', () => {
    printHelp();
    const joined = logLines.join(' ');
    expect(joined).toContain('Comandos disponiveis');
    expect(joined).toContain('/help');
    expect(joined).toContain('/quit');
  });

  it('includes plugin commands when pluginRegistry has them', () => {
    const { pluginRegistry } = require('../core/plugin-registry');
    pluginRegistry.getCommands.mockReturnValueOnce([
      { name: 'myplugin', description: 'A plugin command' },
    ]);
    printHelp();
    const joined = logLines.join(' ');
    expect(joined).toContain('Comandos de Plugins');
    expect(joined).toContain('/myplugin');
  });

  it('handles pluginRegistry not being loaded', () => {
    jest.resetModules();
    printHelp();
    expect(logLines.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('handleProjectSelect', () => {
  it('shows current project when no argument', async () => {
    const ctx = makeMockCtx({ activeProject: { id: 'abc123', name: 'Test' } });
    await handleProjectSelect('/project', ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('Projeto ativo');
    expect(joined).toContain('Test');
  });

  it('prompts to select when no active project and no arg', async () => {
    await handleProjectSelect('/project', makeMockCtx());
    const joined = logLines.join(' ');
    expect(joined).toContain('Nenhum projeto selecionado');
  });

  it('shows warning when no projects found', async () => {
    const ctx = makeMockCtx({ fetchProjects: jest.fn().mockResolvedValue([]) });
    await handleProjectSelect('/project 1', ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('Nenhum projeto encontrado');
  });

  it('selects by numeric index', async () => {
    const projects = [{ id: 'proj-1', name: 'Alpha' }, { id: 'proj-2', name: 'Beta' }];
    const ctx = makeMockCtx({ fetchProjects: jest.fn().mockResolvedValue(projects) });
    await handleProjectSelect('/project 2', ctx);
    expect(ctx.setActiveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'proj-2' }));
    const joined = logLines.join(' ');
    expect(joined).toContain('Beta');
  });

  it('selects by id prefix', async () => {
    const projects = [{ id: 'abcd-1234', name: 'Gamma' }];
    const ctx = makeMockCtx({ fetchProjects: jest.fn().mockResolvedValue(projects) });
    await handleProjectSelect('/project abc', ctx);
    expect(ctx.setActiveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'abcd-1234' }));
  });

  it('selects by name substring', async () => {
    const projects = [{ id: 'p-1', name: 'MyProject' }];
    const ctx = makeMockCtx({ fetchProjects: jest.fn().mockResolvedValue(projects) });
    await handleProjectSelect('/project project', ctx);
    expect(ctx.setActiveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
  });

  it('shows not-found when nothing matches', async () => {
    const projects = [{ id: 'p-1', name: 'Alpha' }];
    const ctx = makeMockCtx({ fetchProjects: jest.fn().mockResolvedValue(projects) });
    await handleProjectSelect('/project nonexistent', ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('nao encontrado');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('handleProjectsList', () => {
  it('shows no projects found', async () => {
    await handleProjectsList(makeMockCtx());
    const joined = logLines.join(' ');
    expect(joined).toContain('Nenhum projeto encontrado');
  });

  it('lists projects with numbers', async () => {
    const projects = [
      { id: 'aaa-bbb', name: 'ProjA', status: 'active' },
      { id: 'ccc-ddd', name: 'ProjB', status: 'paused' },
    ];
    const ctx = makeMockCtx({ fetchProjects: jest.fn().mockResolvedValue(projects) });
    await handleProjectsList(ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('ProjA');
    expect(joined).toContain('ProjB');
    expect(joined).toContain('Use /project');
  });

  it('marks active project', async () => {
    const projects = [{ id: 'p-1', name: 'ActiveOne', status: 'active' }];
    const ctx = makeMockCtx({
      activeProject: { id: 'p-1', name: 'ActiveOne' },
      fetchProjects: jest.fn().mockResolvedValue(projects),
    });
    await handleProjectsList(ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('*');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('handleCostCommand', () => {
  it('displays usage with known model', () => {
    const ctx = makeMockCtx();
    handleCostCommand(ctx);
    const joined = logLines.join(' ');
    // Block header for /cost — matches the SlashOutputCard convention
    // ("/cmd — descrição") used by /trust and friends.
    expect(joined).toMatch(/\/cost.*sess/i);
    expect(joined).toContain('anthropic');
    expect(joined).toContain('claude-sonnet-4');
    expect(joined).toContain('500'); // prompt tokens
    expect(joined).toContain('200'); // output tokens
    expect(joined).toContain('$'); // cost
  });

  it('shows "pricing not available" for unknown model', () => {
    const ctx = makeMockCtx({ providerInfo: { provider: 'unknown', model: 'custom-model' } });
    handleCostCommand(ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('pricing not available');
  });

  it('shows cache rows + cache savings when cache reads > 0', () => {
    const ctx = makeMockCtx({
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cacheReads: 10000,
        cacheWrites: 2000,
        cacheMisses: 1,
        requestCount: 3,
        sessionStartedAt: Date.now() - 120000,
      },
    });
    handleCostCommand(ctx);
    const joined = logLines.join(' ');
    expect(joined).toMatch(/cache r/i);
    expect(joined).toMatch(/cache w/i);
    expect(joined).toMatch(/cache savings/i);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('handleProviderSwitch', () => {
  it('shows current provider when no arg', () => {
    const ctx = makeMockCtx({ provider: 'codex' });
    handleProviderSwitch('/ai', ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('codex');
    expect(joined).toContain('claude');
    expect(joined).toContain('gemini');
  });

  it('switches to a valid provider', () => {
    const ctx = makeMockCtx();
    handleProviderSwitch('/ai gemini', ctx);
    expect(ctx.provider).toBe('gemini');
    const joined = logLines.join(' ');
    expect(joined).toContain('gemini');
  });

  it('ignores invalid provider and shows options', () => {
    const ctx = makeMockCtx({ provider: 'claude' });
    handleProviderSwitch('/ai invalid', ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('claude');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('handleModelCommand', () => {
  it('refreshes catalog on /model or /model refresh', async () => {
    const { fetchCatalog } = require('./ai/providers/catalog');
    await handleModelCommand('/model', makeMockCtx());
    expect(fetchCatalog).toHaveBeenCalledWith({ force: true });
    const joined = logLines.join(' ');
    expect(joined).toContain('fast');
    expect(joined).toContain('default');
    expect(joined).toContain('image');
  });

  it('shows usage on invalid format', async () => {
    await handleModelCommand('/model blabla', makeMockCtx());
    const joined = logLines.join(' ');
    expect(joined).toContain('Uso');
  });

  it('inspects a single tier', async () => {
    await handleModelCommand('/model fast', makeMockCtx());
    const joined = logLines.join(' ');
    expect(joined).toContain('fast');
    expect(joined).toContain('groq');
  });

  it('sets model for a tier', async () => {
    const { overrideEntry } = require('./ai/providers/catalog');
    const ctx = makeMockCtx({ providerInfo: { provider: 'anthropic', model: 'claude-sonnet-4', visionProvider: '', visionModel: '' } });
    await handleModelCommand('/model fast groq:llama-3.3-70b', ctx);
    expect(overrideEntry).toHaveBeenCalledWith('fast', { provider: 'groq', model: 'llama-3.3-70b' });
    const joined = logLines.join(' ');
    expect(joined).toContain('alterado');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('handleCtxCommand', () => {
  it('displays context breakdown', () => {
    handleCtxCommand(makeMockCtx());
    const joined = logLines.join(' ');
    expect(joined).toMatch(/\/ctx.*context/i);
    expect(joined).toContain('System prompt');
    expect(joined).toContain('Model limit');
  });

  it('shows warning when context > 80%', () => {
    // Create enough fake messages to push context high
    const longMsg = 'x'.repeat(400000);
    const ctx = makeMockCtx({
      messages: [
        { role: 'user', content: longMsg },
        { role: 'assistant', content: longMsg },
      ],
    });
    handleCtxCommand(ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('getting full');
  });

  it('shows memory and tool tokens when available', () => {
    const { findRelevant } = require('./memory');
    findRelevant.mockReturnValueOnce([
      { body: 'x'.repeat(3200) },
      { body: 'y'.repeat(1600) },
    ]);
    const ctx = makeMockCtx({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: '{ "result": "ok" }' },
      ],
      lastUserMessage: 'hello',
    });
    handleCtxCommand(ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('Memory prefetch');
    expect(joined).toContain('Tool results');
  });

  it('handles memory/tools import failure gracefully', () => {
    // Reset modules and re-import to get fresh mocks
    jest.resetModules();
    const ctx = makeMockCtx();
    handleCtxCommand(ctx);
    const joined = logLines.join(' ');
    expect(joined).toContain('System prompt');
  });
});
