import {
  runChatPreflight,
  captureImageAttachments,
  persistUserMessage,
  resetPerTurnState,
  runUserPromptSubmitHook,
  resetTurnRetryFlags,
  extractTextAttachments,
  buildSystemPromptWithMemory,
  assembleEnrichedTools,
  runEagerMicroCompactPass,
  runAwaySummaryIfNeeded,
  maybeShowClearHint,
  installTurnAlertTimer,
  healHistoryReasoning,
  buildChatMessagesFromHistory,
} from './chat-prelude';

// ── Default context factory ──────────────────────────────────────
function makeCtx(overrides: any = {}): any {
  return {
    isAuthenticated: jest.fn(() => true),
    sessionKeyInjected: true,
    provider: 'claude',
    cwd: '/tmp',
    messages: [],
    buildSystemPromptStatic: jest.fn(() => 'static prompt'),
    buildSystemPromptDynamic: jest.fn(() => 'dynamic prompt'),
    lastUserMessage: '',
    lastTurnAt: Date.now() - 1000,
    providerInfo: { provider: 'claude', model: 'sonnet' },
    effort: 'medium',
    usage: { totalTokens: 1000 },
    activeProject: null,
    ...overrides,
  };
}

// ── Tool def catalog mock (needed by assembleEnrichedTools) ───────
jest.mock('./tools', () => ({
  toolDefinitions: [{ name: 'Read', description: 'Read a file' }],
  getCoordinatorToolDefs: jest.fn(() => []),
}));

// ── Providers ─────────────────────────────────────────────────────
jest.mock('./providers', () => ({
  getProvider: jest.fn(() => ({ available: true, name: 'claude' })),
}));

// ── Sessions ──────────────────────────────────────────────────────
jest.mock('../sessions', () => ({
  appendMessage: jest.fn(),
}));

// ── Optional modules (dynamic require inside function bodies) ─────
jest.mock('../tui/bridge', () => ({
  setTransientStatus: jest.fn(),
}));
jest.mock('./micro-compact', () => ({
  microCompact: jest.fn(() => ({ trimmed: 0, freedChars: 0 })),
}));
const mockGenerateAwaySummary = jest.fn();
jest.mock('./away-summary', () => ({
  gapIsAway: jest.fn(() => true),
  generateAwaySummary: (...a: any[]) => mockGenerateAwaySummary(...a),
}));

describe('runChatPreflight', () => {
  it('returns provider when authenticated and key injected', () => {
    const ctx = makeCtx();
    const surface = jest.fn();
    const result = runChatPreflight(ctx, surface);
    expect(result.provider).toBeTruthy();
    expect(surface).not.toHaveBeenCalled();
  });

  it('returns null and surfaces error when not authenticated', () => {
    const ctx = makeCtx({ isAuthenticated: jest.fn(() => false) });
    const surface = jest.fn();
    const result = runChatPreflight(ctx, surface);
    expect(result.provider).toBeNull();
    expect(surface).toHaveBeenCalledWith(expect.stringContaining('login'));
  });

  it('returns null and surfaces error when sessionKeyInjected is falsy', () => {
    const ctx = makeCtx({ sessionKeyInjected: false, sessionKeyError: 'rate limited' });
    const surface = jest.fn();
    const result = runChatPreflight(ctx, surface);
    expect(result.provider).toBeNull();
    expect(surface).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
  });
});

// ── Image attachments — optional module ───────────────────────────
describe('captureImageAttachments', () => {
  it('returns unchanged input when no image module', () => {
    // image-paste is not mocked -> require('./image-paste') throws
    const result = captureImageAttachments('hello world', jest.fn());
    expect(result.input).toBe('hello world');
    expect(result.pendingImageBlocks).toEqual([]);
  });
});

describe('persistUserMessage', () => {
  it('appends message to ctx.messages and logs via appendMessage', () => {
    const ctx = makeCtx();
    const userMsg = { role: 'user', content: 'hello' };
    persistUserMessage(ctx, userMsg, 'hello');
    expect(ctx.messages).toContain(userMsg);
    expect(ctx.lastUserMessage).toBe('hello');
  });

  it('sets displayText when __skillDisplayText is present', () => {
    const ctx = makeCtx({ __skillDisplayText: '[expanded /skill]' });
    const userMsg = { role: 'user', content: 'hello' };
    persistUserMessage(ctx, userMsg, 'hello');
    expect((userMsg as any).displayText).toBe('[expanded /skill]');
    expect((ctx as any).__skillDisplayText).toBeUndefined();
  });
});

describe('resetPerTurnState', () => {
  it('is callable without throwing', () => {
    const ctx = makeCtx();
    expect(() => resetPerTurnState(ctx, 'input')).not.toThrow();
  });
});

describe('runUserPromptSubmitHook', () => {
  it('is callable without throwing when no hooks', async () => {
    const ctx = makeCtx();
    await expect(runUserPromptSubmitHook(ctx, 'input', jest.fn())).resolves.toBeUndefined();
  });
});

describe('resetTurnRetryFlags', () => {
  it('resets all retry flags on ctx', () => {
    const ctx = makeCtx();
    // Set them to truthy first
    (ctx as any).__reasoningRecoveryTries = 5;
    (ctx as any).__verifierRetryDone = true;
    (ctx as any).__contradictionRetryDone = true;
    resetTurnRetryFlags(ctx);
    expect((ctx as any).__reasoningRecoveryTries).toBe(0);
    expect((ctx as any).__verifierRetryDone).toBe(false);
    expect((ctx as any).__contradictionRetryDone).toBe(false);
    expect((ctx as any).__turnBashFailures).toEqual([]);
  });
});

describe('extractTextAttachments', () => {
  it('returns input unchanged when no attachments module and __skipAttachmentExtractionOnce is false', () => {
    const ctx = makeCtx();
    const result = extractTextAttachments('hello', ctx, jest.fn());
    expect(result).toBe('hello');
  });

  it('skips extraction when __skipAttachmentExtractionOnce is true', () => {
    const ctx = makeCtx({ __skipAttachmentExtractionOnce: true });
    const result = extractTextAttachments('hello', ctx, jest.fn());
    expect(result).toBe('hello');
    expect((ctx as any).__skipAttachmentExtractionOnce).toBe(false);
  });
});

describe('buildSystemPromptWithMemory', () => {
  it('combines static + dynamic prompts', async () => {
    const ctx = makeCtx();
    const provider = { name: 'claude' };
    const result = await buildSystemPromptWithMemory(ctx, 'input', provider);
    expect(result.systemPrompt).toContain('static prompt');
    expect(result.systemPrompt).toContain('dynamic prompt');
    expect(result.systemStatic).toBe('static prompt');
    expect(result.systemDynamic).toContain('dynamic prompt');
  });
});

describe('assembleEnrichedTools', () => {
  it('returns tool defs with project context when activeProject is set', async () => {
    const ctx = makeCtx({
      activeProject: { name: 'myproject', id: 'p-1', localPath: '/home/proj' },
    });
    const tools = await assembleEnrichedTools(ctx);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].description).toContain('Active project: myproject');
  });

  it('returns tool defs without project context when no activeProject', async () => {
    const ctx = makeCtx();
    const tools = await assembleEnrichedTools(ctx);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].description).not.toContain('Active project');
  });
});

describe('runEagerMicroCompactPass', () => {
  it('surfaces message when microCompact trims', () => {
    const microCompact = require('./micro-compact').microCompact;
    microCompact.mockReturnValue({ trimmed: 3, freedChars: 10000 });
    const ctx = makeCtx();
    const surface = jest.fn();
    runEagerMicroCompactPass(ctx, surface);
    expect(surface).toHaveBeenCalledWith(expect.stringContaining('3'));
  });
});

describe('runAwaySummaryIfNeeded', () => {
  it('is callable without throwing when away module is absent', async () => {
    const ctx = makeCtx();
    const bridge = { addMessage: jest.fn() };
    await expect(runAwaySummaryIfNeeded(ctx, bridge)).resolves.toBeUndefined();
  });

  it('generates and adds away summary when away module returns text', async () => {
    mockGenerateAwaySummary.mockResolvedValue('you were away for 5 min');
    const ctx = makeCtx({ lastTurnAt: Date.now() - 10 * 60 * 1000, awaySummaryFiredAt: 0 });
    const bridge = { addMessage: jest.fn() };
    await runAwaySummaryIfNeeded(ctx, bridge);
    expect(bridge.addMessage).toHaveBeenCalledWith({ role: 'info', text: '↳ you were away for 5 min' });
  });

  it('skips away summary if fired within last 60s', async () => {
    mockGenerateAwaySummary.mockResolvedValue('summary');
    const ctx = makeCtx({ lastTurnAt: Date.now() - 10 * 60 * 1000, awaySummaryFiredAt: Date.now() - 10_000 });
    const bridge = { addMessage: jest.fn() };
    await runAwaySummaryIfNeeded(ctx, bridge);
    expect(bridge.addMessage).not.toHaveBeenCalled();
  });
});

describe('maybeShowClearHint', () => {
  it('does nothing when totalTokens <= 100000', () => {
    const ctx = makeCtx({ usage: { totalTokens: 50000 } });
    expect(() => maybeShowClearHint(ctx, 'hello')).not.toThrow();
  });

  it('does nothing when input looks like continuation, not new task', () => {
    const ctx = makeCtx({ usage: { totalTokens: 200000 } });
    expect(() => maybeShowClearHint(ctx, 'continue with the previous task')).not.toThrow();
  });

  it('calls setTransientStatus when tokens > 100k and input is new-task opener', () => {
    const ctx = makeCtx({ usage: { totalTokens: 200000 } });
    maybeShowClearHint(ctx, 'next task');
    const { setTransientStatus } = require('../tui/bridge');
    expect(setTransientStatus).toHaveBeenCalledWith(expect.stringContaining('/clear'), 8000);
  });

  it('calls setTransientStatus when tokens > 100k and idle gap > 5min', () => {
    const ctx = makeCtx({ usage: { totalTokens: 200000 }, lastTurnAt: Date.now() - 10 * 60 * 1000 });
    maybeShowClearHint(ctx, 'continue the task');
    const { setTransientStatus } = require('../tui/bridge');
    expect(setTransientStatus).toHaveBeenCalled();
  });
});

describe('installTurnAlertTimer', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('sets __clearTurnAlert on ctx', () => {
    const ctx = makeCtx();
    installTurnAlertTimer(ctx);
    expect(typeof (ctx as any).__clearTurnAlert).toBe('function');
    (ctx as any).__clearTurnAlert();
  });

  it('fires setTransientStatus after 2 minutes', () => {
    const ctx = makeCtx();
    installTurnAlertTimer(ctx);
    jest.advanceTimersByTime(2 * 60 * 1000 + 10);
    const { setTransientStatus } = require('../tui/bridge');
    expect(setTransientStatus).toHaveBeenCalledWith(expect.stringContaining('turn running'), 6000);
    (ctx as any).__clearTurnAlert();
  });
});

describe('healHistoryReasoning', () => {
  it('adds reasoning_content to assistant messages missing it', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const ctx = makeCtx({ messages });
    healHistoryReasoning(ctx);
    expect((messages[1] as any).reasoning_content).toBe('');
  });

  it('does nothing if messages is empty', () => {
    const ctx = makeCtx({ messages: [] });
    expect(() => healHistoryReasoning(ctx)).not.toThrow();
  });
});

describe('buildChatMessagesFromHistory', () => {
  it('preserves reasoning_content and tool_calls on assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', reasoning_content: 'thinking...', tool_calls: [{ id: 'call_1' }] },
    ];
    const result = buildChatMessagesFromHistory(messages);
    expect(result[1].reasoning_content).toBe('thinking...');
    expect(result[1].tool_calls).toEqual([{ id: 'call_1' }]);
  });

  it('fills missing reasoning_content with empty string', () => {
    const messages = [
      { role: 'assistant', content: 'hello' },
    ];
    const result = buildChatMessagesFromHistory(messages);
    expect(result[0].reasoning_content).toBe('');
  });

  it('preserves thinking_signature and tool_call_id', () => {
    const messages = [
      { role: 'assistant', content: 'hello', thinking_signature: 'sig_abc', tool_call_id: 'call_xyz' },
    ];
    const result = buildChatMessagesFromHistory(messages);
    expect(result[0].thinking_signature).toBe('sig_abc');
    expect(result[0].tool_call_id).toBe('call_xyz');
  });
});
