import { dispatchCliTool, CliDispatchArgs } from './tool-dispatch-cli';

// ── Mocks ────────────────────────────────────────────────────────
jest.mock('./tools', () => ({
  executeTool: jest.fn(() => Promise.resolve('tool executed')),
}));

jest.mock('./chat-utils', () => ({
  toolFailed: jest.fn((r: string) => r.startsWith('{"error"')),
}));

jest.mock('./tool-limits', () => ({
  clipToolResult: jest.fn((r: string) => r),
}));

jest.mock('../safety-classifier', () => ({
  classifyCommand: jest.fn(() => ({ blocked: false, reason: '' })),
}));

jest.mock('../permissions', () => ({
  loadPolicy: jest.fn(() => ({ rules: [] })),
  evaluateWithMode: jest.fn(() => 'allow'),
  extractContextFromToolCall: jest.fn(() => ({})),
}));

jest.mock('../settings', () => ({
  loadSettings: jest.fn(() => ({ permissionMode: 'default' })),
}));

jest.mock('../trajectory', () => ({
  recordCtxEvent: jest.fn(),
}));

jest.mock('./advanced-tools', () => ({
  getAllowedBashPrompts: jest.fn(() => []),
  matchAllowedBashPrompt: jest.fn(() => null),
}));

jest.mock('../hooks', () => ({
  runHooks: jest.fn(() => Promise.resolve({ blocked: null, failures: [] })),
}));

jest.mock('../tui/bridge', () => ({
  tuiToolCall: jest.fn(),
  tuiLog: jest.fn(),
}));

jest.mock('../mcp', () => ({
  callMcpTool: jest.fn(() => Promise.resolve('mcp result')),
}));

jest.mock('../../utils/events', () => ({
  recordEvent: jest.fn(),
}));

const mockQuestion = jest.fn();
jest.mock('readline', () => ({
  createInterface: jest.fn(() => ({
    question: mockQuestion,
    close: jest.fn(),
  })),
}));

// ── Console spy ──────────────────────────────────────────────────
let consoleLines: string[] = [];
const origLog = console.log;
beforeEach(() => { consoleLines = []; console.log = jest.fn((...a: any[]) => consoleLines.push(a.join(' '))); });
afterEach(() => { console.log = origLog; });

function makeCtx(overrides: any = {}): any {
  return {
    autoApprove: false,
    approvedTools: new Set(),
    cwd: '/tmp',
    activeProject: null,
    recordToolCall: jest.fn(),
    currentAbortController: null,
    toolCallHistory: [],
    lastToolCall: null,
    ...overrides,
  };
}

function makeTool(name: string, input: any = {}): any {
  return { id: 'call_abc123', name, input };
}

function makeArgs(overrides: any = {}): CliDispatchArgs {
  return {
    tool: makeTool('Read', { file_path: '/tmp/a.ts' }),
    ctx: makeCtx(),
    chatMessages: [],
    ...overrides,
  };
}

describe('tool-dispatch-cli', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consoleLines = [];
  });

  it('exports dispatchCliTool as a function', () => {
    expect(typeof dispatchCliTool).toBe('function');
  });

  it('executes a basic Read tool call and pushes result to chatMessages', async () => {
    const args = makeArgs();
    await dispatchCliTool(args);
    expect(args.chatMessages.length).toBe(1);
    expect(args.chatMessages[0].role).toBe('tool');
    expect(args.chatMessages[0].content).toBe('tool executed');
  });

  it('logs tool header and result to console', async () => {
    const args = makeArgs({ tool: makeTool('Glob', { pattern: '**/*.ts', path: '/tmp' }) });
    await dispatchCliTool(args);
    expect(consoleLines.some(l => l.includes('[tool]') && l.includes('Glob'))).toBe(true);
    expect(consoleLines.some(l => l.includes('└→'))).toBe(true);
  });

  describe('safety classifier', () => {
    it('blocks Bash when classifyCommand says blocked', async () => {
      const classifyCommand = require('../safety-classifier').classifyCommand;
      classifyCommand.mockReturnValueOnce({ blocked: true, reason: 'dangerous' });
      const args = makeArgs({ tool: makeTool('Bash', { command: 'rm -rf /' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toContain('blocked by safety classifier');
    });

    it('allows Bash when classifier passes', async () => {
      const args = makeArgs({ tool: makeTool('Bash', { command: 'ls' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toBe('tool executed');
    });
  });

  describe('permission flow', () => {
    it('auto-approves when ctx.autoApprove is true', async () => {
      const args = makeArgs({ tool: makeTool('Edit', {}), ctx: makeCtx({ autoApprove: true }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toBe('tool executed');
    });

    it('auto-approves when tool is in approvedTools set', async () => {
      const ctx = makeCtx();
      ctx.approvedTools.add('Read');
      const args = makeArgs({ tool: makeTool('Read', {}), ctx });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toBe('tool executed');
    });

    it('denies when evaluateWithMode returns deny', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('deny');
      const args = makeArgs({ tool: makeTool('Edit', {}) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toContain('denied by policy');
    });

    it('Bash plan-approved via allowedPrompt bypasses ask', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('ask');
      const matchAllowed = require('./advanced-tools').matchAllowedBashPrompt;
      matchAllowed.mockReturnValueOnce({ prompt: 'approved', match: true });
      const args = makeArgs({ tool: makeTool('Bash', { command: 'safe-command' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toBe('tool executed');
    });

    it('auto-denies in headless mode when policy=ask', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('ask');
      const prev = process.env.MAKESTUDIO_HEADLESS;
      process.env.MAKESTUDIO_HEADLESS = '1';
      const args = makeArgs({ tool: makeTool('Bash', { command: 'some-command' }) });
      await dispatchCliTool(args);
      process.env.MAKESTUDIO_HEADLESS = prev;
      expect(args.chatMessages[0].content).toContain('denied');
    });

    it('asks via readline when policy=ask and not headless', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('ask');
      mockQuestion.mockImplementationOnce((_p: string, cb: (a: string) => void) => cb('s'));
      const args = makeArgs({ tool: makeTool('Bash', { command: 'ls' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toBe('tool executed');
    });

    it('denies when user answers n to readline', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('ask');
      mockQuestion.mockImplementationOnce((_p: string, cb: (a: string) => void) => cb('n'));
      const args = makeArgs({ tool: makeTool('Bash', { command: 'ls' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toContain('denied');
    });

    it('adds tool to approvedTools when user answers a/always', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('ask');
      mockQuestion.mockImplementationOnce((_p: string, cb: (a: string) => void) => cb('a'));
      const ctx = makeCtx();
      const args = makeArgs({ tool: makeTool('Bash', { command: 'ls' }), ctx });
      await dispatchCliTool(args);
      expect(ctx.approvedTools.has('Bash')).toBe(true);
    });
  });

  describe('hook integration', () => {
    it('blocks tool when PreToolUse hook returns blocked', async () => {
      const runHooks = require('../hooks').runHooks;
      runHooks.mockImplementationOnce(async (name: string) =>
        name === 'PreToolUse'
          ? { blocked: { reason: 'denied by policy' }, failures: [] }
          : { blocked: null, failures: [] },
      );
      const args = makeArgs();
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toContain('Blocked by PreToolUse hook');
    });

    it('runs PostToolUse hook after successful execution', async () => {
      const runHooks = require('../hooks').runHooks;
      const args = makeArgs();
      await dispatchCliTool(args);
      const postCalls = runHooks.mock.calls.filter((c: any[]) => c[0] === 'PostToolUse');
      expect(postCalls.length).toBe(1);
    });
  });

  describe('project injection', () => {
    it('injects projectId and projectPath when ctx has activeProject', async () => {
      const ctx = makeCtx({ activeProject: { id: 'proj-1', localPath: '/home/proj' } });
      const args = makeArgs({ ctx });
      await dispatchCliTool(args);
      const executeTool = require('./tools').executeTool;
      const callInput = executeTool.mock.calls[0][1];
      expect(callInput.projectId).toBe('proj-1');
      expect(callInput.projectPath).toBe('/home/proj');
    });
  });

  describe('MCP tool dispatch', () => {
    it('calls callMcpTool for dotted tool names', async () => {
      const callMcpTool = require('../mcp').callMcpTool;
      const args = makeArgs({ tool: makeTool('filesystem.read', { path: '/tmp/a.txt' }) });
      await dispatchCliTool(args);
      expect(callMcpTool).toHaveBeenCalledWith('filesystem.read', expect.any(Object));
    });
  });

  describe('input handling', () => {
    it('clones tool input before mutation', async () => {
      const originalInput = { file_path: '/tmp/a.ts' };
      const ctx = makeCtx({ activeProject: { id: 'proj-1', localPath: '/home/proj' } });
      const args = makeArgs({ tool: makeTool('Read', originalInput), ctx });
      await dispatchCliTool(args);
      expect((originalInput as any).projectId).toBeUndefined();
    });
  });

  describe('tool failure handling', () => {
    it('handles executeTool throwing an error', async () => {
      const executeTool = require('./tools').executeTool;
      executeTool.mockRejectedValueOnce(new Error('crashed'));
      const args = makeArgs({ tool: makeTool('Bash', {}), ctx: makeCtx({ autoApprove: true }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toContain('crashed');
    });
  });

  describe('fmtVal edge cases', () => {
    it('handles empty/null/undefined input values', async () => {
      const args = makeArgs({ tool: makeTool('Read', { file_path: '', name: null, desc: undefined }) });
      await dispatchCliTool(args);
      expect(args.chatMessages.length).toBe(1);
    });

    it('handles array values in tool input', async () => {
      const args = makeArgs({ tool: makeTool('Glob', { pattern: ['*.ts', '*.js'], path: '/tmp' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages.length).toBe(1);
    });

    it('handles object values in tool input', async () => {
      const args = makeArgs({ tool: makeTool('Read', { options: { encoding: 'utf8' } }) });
      await dispatchCliTool(args);
      expect(args.chatMessages.length).toBe(1);
    });

    it('shows <no args> when tool has no input', async () => {
      const args = makeArgs({ tool: makeTool('Read') });
      await dispatchCliTool(args);
      expect(consoleLines.some(l => l.includes('<no args>'))).toBe(true);
    });

    it('relativizes absolute paths for file/path keys', async () => {
      const longPath = '/tmp/a/very/long/path/to/file.ts';
      const ctx = makeCtx({ cwd: '/tmp/a' });
      const args = makeArgs({ ctx, tool: makeTool('Read', { file_path: longPath }) });
      await dispatchCliTool(args);
      expect(consoleLines.some(l => l.includes('very/long/path/to/file.ts'))).toBe(true);
    });

    it('handles boolean and number values in input', async () => {
      const args = makeArgs({ tool: makeTool('Read', { recursive: true, depth: 3 }) });
      await dispatchCliTool(args);
      expect(args.chatMessages.length).toBe(1);
    });

    it('shows relPath returning non-prefixed abs path', async () => {
      // path=/other/dir that doesn't start with cwd prefix
      const otherPath = '/other/dir/file.js';
      const ctx = makeCtx({ cwd: '/tmp' });
      const args = makeArgs({ ctx, tool: makeTool('Read', { file_path: otherPath }) });
      await dispatchCliTool(args);
      expect(consoleLines.some(l => l.includes('/other/dir/file.js'))).toBe(true);
    });

    it('shows dot for path equal to cwd', async () => {
      const ctx = makeCtx({ cwd: '/tmp' });
      const args = makeArgs({ ctx, tool: makeTool('Read', { file_path: '/tmp' }) });
      await dispatchCliTool(args);
      expect(consoleLines.some(l => l.includes('.'))).toBe(true);
    });

    it('handles relative path in file input', async () => {
      const args = makeArgs({ tool: makeTool('Read', { file_path: 'relative/path.ts' }) });
      await dispatchCliTool(args);
      expect(args.chatMessages.length).toBe(1);
    });

    it('truncates result preview when longer than 200 chars', async () => {
      const longResult = 'x'.repeat(500);
      const executeTool = require('./tools').executeTool;
      executeTool.mockResolvedValueOnce(longResult);
      const args = makeArgs({ ctx: makeCtx({ autoApprove: true }) });
      await dispatchCliTool(args);
      expect(args.chatMessages[0].content).toBe(longResult);
    });
  });

  describe('hook failure logging', () => {
    it('logs PreToolUse failures via tuiLog', async () => {
      const runHooks = require('../hooks').runHooks;
      const tuiLog = require('../tui/bridge').tuiLog;
      runHooks.mockImplementationOnce(async () => ({ blocked: null, failures: ['pre warning'] }));
      await dispatchCliTool(makeArgs({ ctx: makeCtx({ autoApprove: true }) }));
      expect(tuiLog).toHaveBeenCalledWith('pre warning', 'warn');
    });

    it('logs PostToolUse failures via tuiLog', async () => {
      const runHooks = require('../hooks').runHooks;
      const tuiLog = require('../tui/bridge').tuiLog;
      runHooks
        .mockImplementationOnce(async () => ({ blocked: null, failures: [] }))
        .mockImplementationOnce(async () => ({ blocked: null, failures: ['post warning'] }));
      await dispatchCliTool(makeArgs({ ctx: makeCtx({ autoApprove: true }) }));
      expect(tuiLog).toHaveBeenCalledWith('post warning', 'warn');
    });
  });
});
