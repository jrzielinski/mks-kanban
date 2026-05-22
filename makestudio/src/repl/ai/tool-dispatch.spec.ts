import { dispatchStreamingTool, DispatchOutcome, StreamingDispatchArgs } from './tool-dispatch';

// ── Mocks ────────────────────────────────────────────────────────
jest.mock('./tool-corrections', () => ({
  buildDenialCorrection: jest.fn(() => 'use a different approach'),
  buildThrownToolCorrection: jest.fn(() => 'check the arguments'),
}));

jest.mock('./chat-utils', () => ({
  toolFailed: jest.fn((r: string) => r.startsWith('{"error"')),
}));

jest.mock('./tools', () => ({
  executeTool: jest.fn(() => Promise.resolve('tool executed')),
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

// Hooks mock — returns per-hook-name responses so different hook
// points in dispatchStreamingTool can be tested independently.
const hookResponses: Record<string, any> = {};
jest.mock('../hooks', () => ({
  runHooks: jest.fn(async (name: string) =>
    hookResponses[name] || { blocked: null, failures: [] },
  ),
}));

const bridgeMock = {
  addMessage: jest.fn(),
  updateMessage: jest.fn(),
};
jest.mock('../tui/bridge', () => ({
  setCurrentTool: jest.fn(),
  tuiToolCall: jest.fn(() => 'msg-1'),
  tuiLog: jest.fn(),
}));

jest.mock('./permission-preview', () => ({
  buildPermissionPreview: jest.fn(() => ({ summary: '', diff: '', warning: '' })),
  persistAllowRule: jest.fn(),
}));

jest.mock('../debug-log', () => ({
  dbgToolCall: jest.fn(),
  dbgToolResult: jest.fn(),
}));

jest.mock('./tool-limits', () => ({
  clipToolResult: jest.fn((r: string) => r),
}));

jest.mock('./post-edit-hooks', () => ({
  runPostEditCheck: jest.fn(() => ({ ok: true, message: '' })),
  trackEdit: jest.fn(),
}));

jest.mock('../../utils/events', () => ({
  recordEvent: jest.fn(),
}));

jest.mock('../mcp', () => ({
  callMcpTool: jest.fn(() => Promise.resolve('mcp result')),
}));

jest.mock('readline', () => ({
  createInterface: jest.fn(() => ({
    question: (_q: string, cb: (a: string) => void) => cb('s'),
    close: jest.fn(),
  })),
}));

function makeCtx(overrides: any = {}): any {
  return {
    coordinatorActive: false,
    autoApprove: false,
    approvedTools: new Set(),
    cwd: '/tmp',
    activeProject: null,
    interactiveDenials: new Map(),
    recordToolCall: jest.fn(),
    currentAbortController: null,
    toolCallHistory: [],
    lastToolCall: null,
    __prefetchCache: undefined,
    ...overrides,
  };
}

function makeTool(name: string, input: any = {}): any {
  return { id: 'call_abc123', name, input };
}

function makeArgs(overrides: any = {}): StreamingDispatchArgs {
  return {
    tool: makeTool('Read', { file_path: '/tmp/a.ts' }),
    ctx: makeCtx(),
    chatMessages: [],
    bridge: bridgeMock as any,
    ...overrides,
  } as StreamingDispatchArgs;
}

describe('tool-dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset hook responses to defaults
    Object.keys(hookResponses).forEach(k => delete hookResponses[k]);
  });

  it('exports dispatchStreamingTool as a function', () => {
    expect(typeof dispatchStreamingTool).toBe('function');
  });

  it('returns "ok" for a basic Read tool call', async () => {
    const args = makeArgs();
    const outcome = await dispatchStreamingTool(args);
    expect(outcome).toBe('ok');
  });

  describe('preflight validation', () => {
    it('rejects Read with negative offset', async () => {
      const args = makeArgs({
        tool: makeTool('Read', { file_path: '/tmp/a.ts', offset: -1 }),
      });
      await dispatchStreamingTool(args);
      expect(args.chatMessages[0].content).toContain('offset');
    });

    it('rejects Read with non-positive limit', async () => {
      const args = makeArgs({
        tool: makeTool('Read', { file_path: '/tmp/a.ts', limit: 0 }),
      });
      await dispatchStreamingTool(args);
      expect(args.chatMessages[0].content).toContain('limit');
    });

    it('allows Read with valid offset and limit', async () => {
      const args = makeArgs({
        tool: makeTool('Read', { file_path: '/tmp/a.ts', offset: 1, limit: 50 }),
      });
      const outcome = await dispatchStreamingTool(args);
      expect(outcome).toBe('ok');
    });

    it('passes preflight for non-Read tools', async () => {
      const args = makeArgs({
        tool: makeTool('Bash', { command: 'ls' }),
      });
      const outcome = await dispatchStreamingTool(args);
      expect(outcome).toBe('ok');
    });
  });

  describe('safety classifier', () => {
    it('blocks Bash when classifyCommand says blocked', async () => {
      const classifyCommand = require('../safety-classifier').classifyCommand;
      classifyCommand.mockReturnValueOnce({ blocked: true, reason: 'dangerous command' });
      const args = makeArgs({
        tool: makeTool('Bash', { command: 'rm -rf /' }),
      });
      await dispatchStreamingTool(args);
      expect(bridgeMock.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'error' }),
      );
    });
  });

  describe('permission flow', () => {
    it('auto-approves when autoApprove is true', async () => {
      const args = makeArgs({
        tool: makeTool('Bash', { command: 'ls' }),
        ctx: makeCtx({ autoApprove: true }),
      });
      const outcome = await dispatchStreamingTool(args);
      expect(outcome).toBe('ok');
    });

    it('plan-approved Bash bypasses deny', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('deny');
      const matchAllowedBashPrompt = require('./advanced-tools').matchAllowedBashPrompt;
      matchAllowedBashPrompt.mockReturnValueOnce({ prompt: 'approved command', match: true });
      const args = makeArgs({
        tool: makeTool('Bash', { command: 'approved-command' }),
      });
      const outcome = await dispatchStreamingTool(args);
      expect(outcome).toBe('ok');
    });

    it('injects denial correction when denied (non-Bash)', async () => {
      const evaluateWithMode = require('../permissions').evaluateWithMode;
      evaluateWithMode.mockReturnValueOnce('deny');
      const buildDenialCorrection = require('./tool-corrections').buildDenialCorrection;
      buildDenialCorrection.mockReturnValueOnce('use AskUserQuestion instead');
      const args = makeArgs({
        tool: makeTool('Edit', { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' }),
        ctx: makeCtx({ autoApprove: false }),
      });
      await dispatchStreamingTool(args);
      const lastMsg = args.chatMessages[args.chatMessages.length - 1];
      expect(lastMsg.content).toContain('denied by policy');
    });
  });

  describe('hook integration', () => {
    it('blocks tool when PreToolUse hook returns blocked', async () => {
      hookResponses['PreToolUse'] = { blocked: { reason: 'policy says no' }, failures: [] };
      const args = makeArgs();
      await dispatchStreamingTool(args);
      expect(args.chatMessages[0].content).toContain('Blocked by PreToolUse hook');
    });
  });

  describe('circuit breaker', () => {
    it('flags __pendingHardStop after MAX_CONSECUTIVE_TOOL_FAILURES', async () => {
      // Behaviour change: dispatchStreamingTool no longer returns
      // 'circuit_breaker' inline — it sets ctx.__pendingHardStop so the
      // current batch's tool_results all get pushed first (preserving the
      // OpenAI/DeepSeek protocol invariant that every tool_call_id has a
      // matching tool_result). chat.ts inspects __pendingHardStop after
      // the batch and breaks the turn loop there.
      const toolFailed = require('./chat-utils').toolFailed;
      toolFailed.mockReturnValue(true);
      const ctx = makeCtx();
      ctx.__consecutiveToolFailures = 4;
      const args = makeArgs({ ctx });
      const outcome = await dispatchStreamingTool(args);
      expect(outcome).toBe('ok');
      expect(ctx.__pendingHardStop?.kind).toBe('consecutive_failures');
    });

    it('resets failure counter on success', async () => {
      const toolFailed = require('./chat-utils').toolFailed;
      toolFailed.mockReturnValue(false);
      const ctx = makeCtx();
      ctx.__consecutiveToolFailures = 3;
      const args = makeArgs({ ctx });
      await dispatchStreamingTool(args);
      expect(ctx.__consecutiveToolFailures).toBe(0);
    });
  });

  describe('tool execution path', () => {
    it('calls executeTool for local tools', async () => {
      const executeTool = require('./tools').executeTool;
      const args = makeArgs();
      await dispatchStreamingTool(args);
      expect(executeTool).toHaveBeenCalled();
    });

    it('calls callMcpTool for MCP-prefixed tools', async () => {
      const callMcpTool = require('../mcp').callMcpTool;
      const args = makeArgs({
        tool: makeTool('filesystem.read', { path: '/tmp/a.txt' }),
      });
      await dispatchStreamingTool(args);
      expect(callMcpTool).toHaveBeenCalledWith('filesystem.read', expect.any(Object));
    });

    it('applies post-edit compile-gate after Edit', async () => {
      const runPostEditCheck = require('./post-edit-hooks').runPostEditCheck;
      runPostEditCheck.mockReturnValueOnce({ ok: false, message: 'syntax error' });
      const args = makeArgs({
        tool: makeTool('Edit', { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' }),
      });
      await dispatchStreamingTool(args);
      const lastMsg = args.chatMessages[args.chatMessages.length - 1];
      expect(lastMsg.content).toContain('[compile-check]');
    });
  });

  describe('project injection', () => {
    it('injects projectId and projectPath when ctx has activeProject', async () => {
      const ctx = makeCtx({
        activeProject: { id: 'proj-1', localPath: '/home/proj' },
      });
      const args = makeArgs({ ctx });
      await dispatchStreamingTool(args);
      const executeTool = require('./tools').executeTool;
      const callArgs = executeTool.mock.calls[0];
      expect(callArgs[1].projectId).toBe('proj-1');
      expect(callArgs[1].projectPath).toBe('/home/proj');
    });
  });
});

// ── dispatchCliTool ─────────────────────────────────────────────
import { dispatchCliTool, CliDispatchArgs } from './tool-dispatch-cli';

function makeCliArgs(overrides: any = {}): CliDispatchArgs {
  return {
    tool: { name: 'Read', id: 'call_1', input: { file_path: '/tmp/a.ts' } },
    ctx: makeCtx(),
    chatMessages: [],
    ...overrides,
  };
}

describe('dispatchCliTool', () => {
  let consoleSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(hookResponses).forEach(k => delete hookResponses[k]);
    require('./chat-utils').toolFailed.mockImplementation((r: string) => r.startsWith('{"error"'));
    require('../safety-classifier').classifyCommand.mockReturnValue({ blocked: false, reason: '' });
    require('../permissions').evaluateWithMode.mockReturnValue('allow');
    require('./tool-limits').clipToolResult.mockImplementation((r: string) => r);
  });

  it('injects projectId when missing', async () => {
    const a = makeCliArgs({
      ctx: makeCtx({ activeProject: { id: 'p-1', localPath: '/p' } }),
      tool: { name: 'Read', id: 'c1', input: {} },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall!.input.projectId).toBe('p-1');
  });

  it('injects projectPath from localPath', async () => {
    const a = makeCliArgs({
      ctx: makeCtx({ activeProject: { id: 'p-1', localPath: '/my/proj' } }),
      tool: { name: 'Read', id: 'c1', input: { projectId: 'p-1' } },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall!.input.projectPath).toBe('/my/proj');
  });

  it('does not overwrite existing projectId', async () => {
    const a = makeCliArgs({
      ctx: makeCtx({ activeProject: { id: 'p-1' as any } }),
      tool: { name: 'Read', id: 'c1', input: { projectId: 'keep' } },
    });
    await dispatchCliTool(a);
    expect(a.tool.input.projectId).toBe('keep');
  });

  it('blocks Bash when safety classifier blocks', async () => {
    require('../safety-classifier').classifyCommand.mockReturnValue({ blocked: true, reason: 'rm -rf /' });
    const a = makeCliArgs({
      tool: { name: 'Bash', id: 'c1', input: { command: 'rm -rf /' } },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall?.output).toContain('blocked by safety classifier');
    expect(a.chatMessages[0].content).toContain('blocked by safety classifier');
  });

  it('does not classify non-Bash tools', async () => {
    await dispatchCliTool(makeCliArgs());
    expect(require('../safety-classifier').classifyCommand).not.toHaveBeenCalled();
  });

  it('skips policy when autoApprove is true', async () => {
    const a = makeCliArgs({ ctx: makeCtx({ autoApprove: true }) });
    await dispatchCliTool(a);
    expect(require('../permissions').evaluateWithMode).not.toHaveBeenCalled();
  });

  it('skips policy when tool is approved', async () => {
    const ctx = makeCtx();
    ctx.approvedTools.add('Read');
    await dispatchCliTool(makeCliArgs({ ctx }));
    expect(require('../permissions').evaluateWithMode).not.toHaveBeenCalled();
  });

  it('denies tool when policy action is deny', async () => {
    require('../permissions').evaluateWithMode.mockReturnValue('deny');
    const a = makeCliArgs();
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall?.output).toContain('denied by policy');
  });

  it('denies Bash with policy even when plan-matched (CLI dispatcher does not support plan bypass on deny)', async () => {
    require('../permissions').evaluateWithMode.mockReturnValue('deny');
    require('./advanced-tools').matchAllowedBashPrompt.mockReturnValue({ prompt: 'run tests' });
    const a = makeCliArgs({
      tool: { name: 'Bash', id: 'c1', input: { command: 'npm test' } },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall?.output).toContain('denied by policy');
  });

  it('auto-approves via plan allowedPrompt in ask mode', async () => {
    require('../permissions').evaluateWithMode.mockReturnValue('ask');
    require('./advanced-tools').matchAllowedBashPrompt.mockReturnValue({ prompt: 'run tests' });
    const a = makeCliArgs({
      tool: { name: 'Bash', id: 'c1', input: { command: 'npm test' } },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall).toBeTruthy();
  });

  it('auto-denies in headless mode when action is ask', async () => {
    process.env.MAKESTUDIO_HEADLESS = '1';
    require('../permissions').evaluateWithMode.mockReturnValue('ask');
    const a = makeCliArgs({ tool: { name: 'Read', id: 'c1', input: { file_path: '/x' } } });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall?.output).toContain('denied');
    delete process.env.MAKESTUDIO_HEADLESS;
  });

  it('prompts via readline when action is ask', async () => {
    require('../permissions').evaluateWithMode.mockReturnValue('ask');
    await dispatchCliTool(makeCliArgs());
    expect(require('readline').createInterface).toHaveBeenCalled();
  });

  it('blocks execution when PreToolUse hook blocks', async () => {
    hookResponses['PreToolUse'] = { blocked: { reason: 'policy hook' }, failures: [] };
    const a = makeCliArgs();
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall?.output).toContain('Blocked by PreToolUse hook');
  });

  it('logs warnings from PreToolUse hook failures', async () => {
    hookResponses['PreToolUse'] = { blocked: null, failures: ['hook warning'] };
    await dispatchCliTool(makeCliArgs());
    expect(require('../tui/bridge').tuiLog).toHaveBeenCalledWith('hook warning', 'warn');
  });

  it('calls tuiToolCall for Edit/Write/MultiEdit', async () => {
    for (const name of ['Edit', 'Write', 'MultiEdit']) {
      jest.clearAllMocks();
      await dispatchCliTool(makeCliArgs({
        tool: { name, id: 'c1', input: { file_path: '/x.ts' } },
      }));
      expect(require('../tui/bridge').tuiToolCall).toHaveBeenCalledWith(name, { file_path: '/x.ts' });
    }
  });

  it('does not call tuiToolCall for non-mutation tools', async () => {
    await dispatchCliTool(makeCliArgs());
    expect(require('../tui/bridge').tuiToolCall).not.toHaveBeenCalled();
  });

  it('executes regular tool via executeTool', async () => {
    await dispatchCliTool(makeCliArgs());
    expect(require('./tools').executeTool).toHaveBeenCalled();
  });

  it('executes MCP tool via callMcpTool', async () => {
    await dispatchCliTool(makeCliArgs({
      tool: { name: 'github.read', id: 'c1', input: { repo: 'x' } },
    }));
    expect(require('../mcp').callMcpTool).toHaveBeenCalledWith('github.read', { repo: 'x' });
  });

  it('catches tool execution errors', async () => {
    require('./tools').executeTool.mockRejectedValueOnce(new Error('boom'));
    const a = makeCliArgs();
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall?.output).toContain('boom');
  });

  it('runs PostToolUse hook after execution', async () => {
    await dispatchCliTool(makeCliArgs());
    const { runHooks } = require('../hooks');
    expect(runHooks).toHaveBeenCalledWith('PostToolUse', expect.any(Object));
  });

  it('logs warnings from PostToolUse failures', async () => {
    const { runHooks } = require('../hooks');
    (runHooks as jest.Mock).mockImplementation(async (name: string) => {
      if (name === 'PreToolUse') return { blocked: null, failures: [] };
      if (name === 'PostToolUse') return { blocked: null, failures: ['post warn'] };
      return hookResponses[name] || { blocked: null, failures: [] };
    });
    await dispatchCliTool(makeCliArgs());
    expect(require('../tui/bridge').tuiLog).toHaveBeenCalledWith('post warn', 'warn');
  });

  it('pushes tool result to chatMessages', async () => {
    const a = makeCliArgs();
    await dispatchCliTool(a);
    expect(a.chatMessages.length).toBe(1);
    expect(a.chatMessages[0].role).toBe('tool');
    expect(a.chatMessages[0].tool_call_id).toBe('call_1');
  });

  it('records tool call via ctx.recordToolCall', async () => {
    const ctx = { ...makeCtx(), recordToolCall: jest.fn() };
    await dispatchCliTool(makeCliArgs({ ctx }));
    expect(ctx.recordToolCall).toHaveBeenCalled();
  });

  it('handles relpath formatting for file paths', async () => {
    const a = makeCliArgs({
      ctx: makeCtx({ cwd: '/home/user/project', activeProject: null }),
      tool: { name: 'Read', id: 'c1', input: { file_path: '/home/user/project/src/foo.ts' } },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall).toBeTruthy();
  });

  it('handles empty tool input gracefully', async () => {
    const a = makeCliArgs({
      tool: { name: 'Read', id: 'c1', input: {} },
    });
    await dispatchCliTool(a);
    expect(a.ctx.lastToolCall).toBeTruthy();
  });
});
