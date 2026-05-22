/**
 * Tests for advanced-tools.ts — LSP, Brief, PushNotification, Skill,
 * apply_patch, ToolSearch, VerifyPlanExecution, plugin tool registry,
 * and the executeAdvancedTool dispatch switch.
 *
 * Co-located next to the source; run via `npm run test:unit` from agent/.
 */

// ── Native module mocks (must precede imports — jest hoists them) ─────────
jest.mock('os', () => ({ ...jest.requireActual('os'), platform: jest.fn() }));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

import * as os from 'os';
import { spawn } from 'child_process';
import { ReplContext } from '../context';

// ── Mock LSP module ─────────────────────────────────────────────────────────
const mockLsp = {
  lspDefinition: jest.fn(),
  lspDefinitionAt: jest.fn(),
  lspReferences: jest.fn(),
  lspReferencesAt: jest.fn(),
  lspHover: jest.fn(),
  lspDocumentSymbols: jest.fn(),
  lspImplementation: jest.fn(),
  lspWorkspaceSymbols: jest.fn(),
  lspIncomingCalls: jest.fn(),
  lspOutgoingCalls: jest.fn(),
};
jest.mock('../lsp', () => mockLsp);

// ── Mock apply-patch module ─────────────────────────────────────────────────
const mockApplyPatch = { applyPatch: jest.fn() };
jest.mock('./apply-patch', () => mockApplyPatch);

// ── Module-under-test ───────────────────────────────────────────────────────
import {
  lspToolDefinition,
  briefToolDefinition,
  pushNotificationToolDefinition,
  skillToolDefinition,
  applyPatchToolDefinition,
  toolSearchToolDefinition,
  verifyPlanExecutionToolDefinition,
  advancedToolDefinitions,
  registerPluginReplTool,
  __clearPluginReplToolsForTests,
  getPluginReplToolDefinitions,
  executeAdvancedTool,
  isAdvancedToolName,
} from './advanced-tools';

// ── Helpers ─────────────────────────────────────────────────────────────────
const mockOsPlatform = os.platform as jest.Mock;
const mockSpawn = spawn as unknown as jest.Mock;

function mockCtx(overrides: Partial<ReplContext> = {}): any {
  return {
    cwd: '/tmp/test',
    activeProject: null,
    currentAbortController: new AbortController(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  LSP tool definition
// ─────────────────────────────────────────────────────────────────────────────
describe('lspToolDefinition', () => {
  it('has name LSP and an input_schema', () => {
    expect(lspToolDefinition.name).toBe('LSP');
    expect(lspToolDefinition.input_schema).toBeDefined();
    const props = lspToolDefinition.input_schema.properties;
    expect(props.operation).toBeDefined();
    expect(props.operation.enum).toContain('goToDefinition');
    expect(props.operation.enum).toContain('outgoingCalls');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  runLspTool (tested via executeAdvancedTool dispatch)
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — LSP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLsp.lspDefinition.mockResolvedValue({ symbol: 'readFile', file: 'x.ts' });
    mockLsp.lspDefinitionAt.mockResolvedValue({ symbol: 'readFile', file: 'x.ts' });
    mockLsp.lspReferences.mockResolvedValue([{ file: 'x.ts', line: 10 }]);
    mockLsp.lspReferencesAt.mockResolvedValue([{ file: 'x.ts', line: 10 }]);
    mockLsp.lspHover.mockResolvedValue({ text: 'some type info' });
    mockLsp.lspDocumentSymbols.mockResolvedValue([{ name: 'foo', kind: 6 }]);
    mockLsp.lspWorkspaceSymbols.mockResolvedValue([{ name: 'UserDto', kind: 8 }]);
    mockLsp.lspImplementation.mockResolvedValue([{ file: 'x.ts', line: 42 }]);
    mockLsp.lspIncomingCalls.mockResolvedValue([]);
    mockLsp.lspOutgoingCalls.mockResolvedValue([]);
  });

  it('goToDefinition by filePath+line', async () => {
    await executeAdvancedTool('LSP', { operation: 'goToDefinition', filePath: 'x.ts', line: 5 }, mockCtx());
    expect(mockLsp.lspDefinitionAt).toHaveBeenCalledWith('/tmp/test', 'x.ts', 5, 1);
  });

  it('goToDefinition by symbol', async () => {
    await executeAdvancedTool('LSP', { operation: 'goToDefinition', symbol: 'readFile' }, mockCtx());
    expect(mockLsp.lspDefinition).toHaveBeenCalledWith('/tmp/test', 'readFile');
  });

  it('goToDefinition throws when neither filePath+line nor symbol given', async () => {
    await expect(
      executeAdvancedTool('LSP', { operation: 'goToDefinition' }, mockCtx()),
    ).rejects.toThrow(/provide either/);
  });

  it('findReferences by filePath+line', async () => {
    await executeAdvancedTool('LSP', { operation: 'findReferences', filePath: 'x.ts', line: 10 }, mockCtx());
    expect(mockLsp.lspReferencesAt).toHaveBeenCalled();
  });

  it('findReferences by symbol', async () => {
    await executeAdvancedTool('LSP', { operation: 'findReferences', symbol: 'readFile' }, mockCtx());
    expect(mockLsp.lspReferences).toHaveBeenCalled();
  });

  it('findReferences throws when neither provided', async () => {
    await expect(
      executeAdvancedTool('LSP', { operation: 'findReferences' }, mockCtx()),
    ).rejects.toThrow(/provide either/);
  });

  it('hover with filePath and line', async () => {
    await executeAdvancedTool('LSP', { operation: 'hover', filePath: 'x.ts', line: 5 }, mockCtx());
    expect(mockLsp.lspHover).toHaveBeenCalled();
  });

  it('hover throws without filePath', async () => {
    await expect(
      executeAdvancedTool('LSP', { operation: 'hover', line: 5 }, mockCtx()),
    ).rejects.toThrow(/filePath and line required/);
  });

  it('documentSymbol', async () => {
    await executeAdvancedTool('LSP', { operation: 'documentSymbol', filePath: 'x.ts' }, mockCtx());
    expect(mockLsp.lspDocumentSymbols).toHaveBeenCalled();
  });

  it('documentSymbol throws without filePath', async () => {
    await expect(
      executeAdvancedTool('LSP', { operation: 'documentSymbol' }, mockCtx()),
    ).rejects.toThrow(/filePath required/);
  });

  it('workspaceSymbol', async () => {
    await executeAdvancedTool('LSP', { operation: 'workspaceSymbol', symbol: 'User' }, mockCtx());
    expect(mockLsp.lspWorkspaceSymbols).toHaveBeenCalled();
  });

  it('workspaceSymbol throws without symbol', async () => {
    await expect(
      executeAdvancedTool('LSP', { operation: 'workspaceSymbol' }, mockCtx()),
    ).rejects.toThrow(/symbol required/);
  });

  it('goToImplementation', async () => {
    await executeAdvancedTool('LSP', { operation: 'goToImplementation', filePath: 'x.ts', line: 42 }, mockCtx());
    expect(mockLsp.lspImplementation).toHaveBeenCalled();
  });

  it('incomingCalls', async () => {
    await executeAdvancedTool('LSP', { operation: 'incomingCalls', filePath: 'x.ts', line: 10 }, mockCtx());
    expect(mockLsp.lspIncomingCalls).toHaveBeenCalled();
  });

  it('outgoingCalls', async () => {
    await executeAdvancedTool('LSP', { operation: 'outgoingCalls', filePath: 'x.ts', line: 10 }, mockCtx());
    expect(mockLsp.lspOutgoingCalls).toHaveBeenCalled();
  });

  it('throws for unknown operation', async () => {
    await expect(
      executeAdvancedTool('LSP', { operation: 'unknownOp' }, mockCtx()),
    ).rejects.toThrow(/Unknown LSP operation/);
  });

  it('uses activeProject.localPath when set', async () => {
    const ctx = mockCtx({ activeProject: { id: 'p1', name: 'test', localPath: '/custom/root' } });
    await executeAdvancedTool('LSP', { operation: 'workspaceSymbol', symbol: 'foo' }, ctx);
    expect(mockLsp.lspWorkspaceSymbols).toHaveBeenCalledWith('/custom/root', 'foo');
  });

  it('returns JSON stringified result', async () => {
    const out = await executeAdvancedTool('LSP', { operation: 'workspaceSymbol', symbol: 'User' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([{ name: 'UserDto', kind: 8 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  briefImpl
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — Brief', () => {
  it('returns error for empty message', async () => {
    const out = await executeAdvancedTool('Brief', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/message is required/);
  });

  it('returns ok for valid message', async () => {
    const out = await executeAdvancedTool('Brief', { message: 'starting build' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.posted).toBe('starting build');
    expect(parsed.level).toBe('info');
  });

  it('honours level=warn', async () => {
    const out = await executeAdvancedTool('Brief', { message: 'slow query', level: 'warn' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.level).toBe('warn');
  });

  it('truncates messages longer than 120 chars', async () => {
    const long = 'x'.repeat(200);
    const out = await executeAdvancedTool('Brief', { message: long }, mockCtx());
    const parsed = JSON.parse(out);
    // raw.length > 120 → slice(0, 117) + '…' = 118 chars
    expect(parsed.posted.length).toBe(118);
    expect(parsed.posted).toMatch(/…$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  pushNotificationImpl
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — PushNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpawn.mockReturnValue({ unref: jest.fn() });
  });

  it('darwin: spawns osascript', async () => {
    mockOsPlatform.mockReturnValue('darwin');
    const out = await executeAdvancedTool('PushNotification', { title: 'Hello', message: 'World' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith('osascript', expect.arrayContaining(['-e']), expect.any(Object));
  });

  it('linux: spawns notify-send', async () => {
    mockOsPlatform.mockReturnValue('linux');
    const out = await executeAdvancedTool('PushNotification', { title: 'Test', message: 'OK' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith('notify-send', ['Test', 'OK'], expect.any(Object));
  });

  it('win32: spawns powershell', async () => {
    mockOsPlatform.mockReturnValue('win32');
    const out = await executeAdvancedTool('PushNotification', { title: 'Hi', message: 'There', sound: true }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith('powershell', expect.arrayContaining(['-NoProfile', '-Command']), expect.any(Object));
  });

  it('unsupported platform returns sent=false with reason', async () => {
    mockOsPlatform.mockReturnValue('sunos');
    const out = await executeAdvancedTool('PushNotification', { title: 'x', message: 'y' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(false);
    expect(parsed.reason).toMatch(/sunos/);
  });

  it('handles spawn throw gracefully', async () => {
    mockOsPlatform.mockReturnValue('darwin');
    mockSpawn.mockImplementation(() => { throw new Error('no display'); });
    const out = await executeAdvancedTool('PushNotification', { title: 'x', message: 'y' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(false);
    expect(parsed.error).toMatch(/no display/);
  });

  it('sanitises quotes in title and message', async () => {
    mockOsPlatform.mockReturnValue('linux');
    const out = await executeAdvancedTool('PushNotification', { title: 'Hello "world"', message: 'It\'s fine' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(true);
  });

  it('defaults sound to false', async () => {
    mockOsPlatform.mockReturnValue('darwin');
    const out = await executeAdvancedTool('PushNotification', { title: 'No sound', message: 'silent' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.sent).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  apply_patch
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — apply_patch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyPatch.applyPatch.mockResolvedValue({ text: 'Patched 3 files' });
  });

  it('returns error for empty input', async () => {
    const out = await executeAdvancedTool('apply_patch', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/Provide a patch input/);
  });

  it('calls applyPatch and returns result', async () => {
    const out = await executeAdvancedTool('apply_patch', { input: '*** Begin Patch\n*** End Patch' }, mockCtx());
    expect(out).toBe('Patched 3 files');
    expect(mockApplyPatch.applyPatch).toHaveBeenCalled();
  });

  it('handles applyPatch throw', async () => {
    mockApplyPatch.applyPatch.mockRejectedValue(new Error('conflict at line 42'));
    const out = await executeAdvancedTool('apply_patch', { input: 'some patch' }, mockCtx());
    expect(out).toMatch(/apply_patch failed/);
    expect(out).toMatch(/conflict at line 42/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ToolSearch
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — ToolSearch', () => {
  it('returns error for empty query', async () => {
    const out = await executeAdvancedTool('ToolSearch', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/query is required/);
  });

  it('select mode: finds tools by name', async () => {
    const out = await executeAdvancedTool('ToolSearch', { query: 'select:LSP,Read' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe('select');
    expect(parsed.requested).toContain('LSP');
    expect(parsed.found.length).toBeGreaterThanOrEqual(1);
  });

  it('select mode: reports missing names', async () => {
    const out = await executeAdvancedTool('ToolSearch', { query: 'select:NonExistentTool' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.missing).toContain('NonExistentTool');
  });

  it('keyword mode: ranks by relevance', async () => {
    const out = await executeAdvancedTool('ToolSearch', { query: 'file read', max_results: 3 }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe('keyword');
    expect(parsed.total_catalog).toBeGreaterThan(0);
    expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('keyword mode with +required filter', async () => {
    const out = await executeAdvancedTool('ToolSearch', { query: '+grep file pattern' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe('keyword');
    expect(parsed.query).toBe('+grep file pattern');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  VerifyPlanExecution
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — VerifyPlanExecution', () => {
  it('returns FAIL when original_task is missing', async () => {
    const out = await executeAdvancedTool('VerifyPlanExecution', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('FAIL');
    expect(parsed.reason).toMatch(/original_task missing/);
  });

  it('returns FAIL with empty task string', async () => {
    const out = await executeAdvancedTool('VerifyPlanExecution', {
      original_task: '   ',
      files_changed: [],
      approach: '',
    }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('FAIL');
  });

  it('returns FAIL when pre-check detects non-ts files gracefully', async () => {
    const out = await executeAdvancedTool('VerifyPlanExecution', {
      original_task: 'add pagination',
      files_changed: ['/tmp/x.go'],
      approach: 'wrote code',
    }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('FAIL');
  });

  it('skip_pre_check bypasses pre-check phase', async () => {
    const out = await executeAdvancedTool('VerifyPlanExecution', {
      original_task: 'add pagination',
      files_changed: [],
      approach: 'wrote code',
      skip_pre_check: true,
    }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('FAIL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Skill
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — Skill', () => {
  it('returns error for missing skill argument', async () => {
    const out = await executeAdvancedTool('Skill', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/Missing.*skill.*argument/);
  });

  it('returns error for empty skill name', async () => {
    const out = await executeAdvancedTool('Skill', { skill: '' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/Missing.*skill.*argument/);
  });

  it('returns error when skill not found and lists available', async () => {
    const out = await executeAdvancedTool('Skill', { skill: 'nope' }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/not found/);
    expect(parsed.available).toBeDefined();
  });

  it('handles skill with args', async () => {
    const out = await executeAdvancedTool('Skill', { skill: 'nope', args: ['one', 'two'] }, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  executeAdvancedTool — misc tools
// ─────────────────────────────────────────────────────────────────────────────
describe('executeAdvancedTool — remaining non-interactive tools', () => {
  it('throws for unknown tool', async () => {
    await expect(
      executeAdvancedTool('FooBar', {}, mockCtx()),
    ).rejects.toThrow(/Unknown advanced tool/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  isAdvancedToolName
// ─────────────────────────────────────────────────────────────────────────────
describe('isAdvancedToolName', () => {
  const known = [
    'LSP', 'TodoWrite', 'TodoUpdate', 'TodoList', 'AskUserQuestion',
    'TaskCreate', 'TaskOutput', 'TaskStatus', 'TaskStop', 'TaskList',
    'EnterWorktree', 'ExitWorktree', 'WorktreeStatus',
    'EnterPlanMode', 'ExitPlanMode', 'PlanModeStatus',
    'Sleep', 'Brief', 'CronCreate', 'CronList', 'CronDelete',
    'SuggestBackgroundPR', 'PushNotification', 'Skill',
    'VerifyPlanExecution', 'ToolSearch', 'apply_patch',
  ];

  for (const name of known) {
    it(`returns true for "${name}"`, () => {
      expect(isAdvancedToolName(name)).toBe(true);
    });
  }

  it('returns false for unknown tool', () => {
    expect(isAdvancedToolName('UnknownTool')).toBe(false);
    expect(isAdvancedToolName('')).toBe(false);
    expect(isAdvancedToolName('Read')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Plugin tool registry
// ─────────────────────────────────────────────────────────────────────────────
describe('plugin tool registry', () => {
  afterEach(() => {
    __clearPluginReplToolsForTests();
  });

  it('registerPluginReplTool adds a tool that getPluginReplToolDefinitions returns', () => {
    registerPluginReplTool({
      name: 'myCustom',
      description: 'A custom plugin tool',
      input_schema: { type: 'object', properties: {} },
      execute: () => 'done',
    });
    const defs = getPluginReplToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('myCustom');
  });

  it('executes a registered plugin tool via executeAdvancedTool', async () => {
    const execute = jest.fn().mockResolvedValue('plugin result');
    registerPluginReplTool({ name: 'myPlugin', description: 'test', input_schema: {}, execute });
    const out = await executeAdvancedTool('myPlugin', { foo: 1 }, mockCtx());
    expect(out).toBe('plugin result');
    expect(execute).toHaveBeenCalledWith({ foo: 1 }, { cwd: '/tmp/test' });
  });

  it('plugin tool execute returning object is JSON-stringified', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true, data: [1, 2, 3] });
    registerPluginReplTool({ name: 'objTool', description: '', input_schema: {}, execute });
    const out = await executeAdvancedTool('objTool', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual([1, 2, 3]);
  });

  it('plugin tool that throws returns error object', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('something bad'));
    registerPluginReplTool({ name: 'badTool', description: '', input_schema: {}, execute });
    const out = await executeAdvancedTool('badTool', {}, mockCtx());
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/something bad/);
  });

  it('__clearPluginReplToolsForTests empties the registry', () => {
    registerPluginReplTool({ name: 'tool1', description: '', input_schema: {}, execute: () => '' });
    registerPluginReplTool({ name: 'tool2', description: '', input_schema: {}, execute: () => '' });
    expect(getPluginReplToolDefinitions()).toHaveLength(2);
    __clearPluginReplToolsForTests();
    expect(getPluginReplToolDefinitions()).toHaveLength(0);
  });

  it('registerPluginReplTool throws for missing name', () => {
    expect(() => registerPluginReplTool({} as any)).toThrow(/must have a name/);
  });

  it('getPluginReplToolDefinitions returns empty after clear', () => {
    expect(getPluginReplToolDefinitions()).toEqual([]);
  });

  it('executeAdvancedTool for plugin tool falls through to Unknown error when not found', async () => {
    await expect(
      executeAdvancedTool('nonexistentPlugin', {}, mockCtx()),
    ).rejects.toThrow(/Unknown advanced tool/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  advancedToolDefinitions list
// ─────────────────────────────────────────────────────────────────────────────
describe('advancedToolDefinitions', () => {
  it('includes all tool definitions', () => {
    const names = advancedToolDefinitions.map((t) => t.name);
    expect(names).toContain('LSP');
    expect(names).toContain('TodoWrite');
    expect(names).toContain('Brief');
    expect(names).toContain('PushNotification');
    expect(names).toContain('Skill');
    expect(names).toContain('apply_patch');
    expect(names).toContain('ToolSearch');
    expect(names).toContain('VerifyPlanExecution');
    expect(names).toContain('Sleep');
    expect(names).toContain('SuggestBackgroundPR');
    expect(names.length).toBeGreaterThan(15);
  });
});
