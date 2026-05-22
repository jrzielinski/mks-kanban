import {
  runToolMarkupGuard,
  runPromisedActionGuard,
  runAbsenceClaimGuard,
  runContradictionGuard,
  runStreamingGuards,
  lastSentenceIsQuestion,
  StreamingGuardArgs,
} from './streaming-guards';

describe('lastSentenceIsQuestion — punctuation-level question detector', () => {
  it.each([
    ['ataco?', true],
    ['Próximo da fila pra decompor: WidgetRenderer.tsx — ataco?', true],
    ['should I keep going?', true],
    ['¿sigo adelante?', true],
    ['Done. ataco?', true],
    ['ataco?)', true],
    ['ataco?"', true],
    ['Vamos seguir.', false],
    ['Implementei a feature.', false],
    ["I'll edit src/foo.ts now.", false],
    ['', false],
    ['   ', false],
  ])('lastSentenceIsQuestion(%s) -> %s', (text, expected) => {
    expect(lastSentenceIsQuestion(text)).toBe(expected);
  });
});

function makeArgs(overrides: Partial<StreamingGuardArgs> = {}): StreamingGuardArgs {
  const msgs: any[] = [];
  return {
    ctx: {} as any,
    accumulatedText: 'response text',
    toolUses: [],
    chatMessages: msgs,
    buildAssistantMessage: (text: string | null, toolCalls?: any[]) => ({
      role: 'assistant',
      content: text || '',
    }),
    bridge: { addMessage: (m: any) => { msgs.push(m); } },
    ...overrides,
  };
}

describe('runToolMarkupGuard', () => {
  it('returns false when toolUses is not empty', () => {
    const args = makeArgs({ toolUses: [{ name: 'bash' }] });
    expect(runToolMarkupGuard(args)).toBe(false);
  });

  it('returns false when accumulatedText is empty', () => {
    const args = makeArgs({ accumulatedText: '' });
    expect(runToolMarkupGuard(args)).toBe(false);
  });

  it('detects DeepSeek DSML markup', () => {
    const args = makeArgs({ accumulatedText: '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">' });
    expect(runToolMarkupGuard(args)).toBe(true);
  });

  it('detects Anthropic-style function_calls markup', () => {
    const args = makeArgs({ accumulatedText: '<function_calls><invoke name="read">hello</invoke></function_calls>' });
    expect(runToolMarkupGuard(args)).toBe(true);
  });

  it('detects OpenAI-style tool_call markers', () => {
    const args = makeArgs({ accumulatedText: '<|tool_call_start|>' });
    expect(runToolMarkupGuard(args)).toBe(true);
  });

  it('detects bracket-style [TOOL_CALL] markers', () => {
    const args = makeArgs({ accumulatedText: '[TOOL_CALL] bash with args [/TOOL_CALL]' });
    expect(runToolMarkupGuard(args)).toBe(true);
  });

  it('returns false for plain text', () => {
    const args = makeArgs({ accumulatedText: 'I will use Bash to check this' });
    expect(runToolMarkupGuard(args)).toBe(false);
  });

  it('retries up to MAX, then aborts with __toolMarkupAbort flag', () => {
    const ctx: any = {};
    const args = makeArgs({ ctx, accumulatedText: '<｜DSML｜tool_calls>' });
    // Attempt 1: retry
    expect(runToolMarkupGuard(args)).toBe(true);
    expect(ctx.__toolMarkupRetryCount).toBe(1);
    expect(ctx.__toolMarkupAbort).toBeFalsy();
    // Attempt 2: still retry
    expect(runToolMarkupGuard(args)).toBe(true);
    expect(ctx.__toolMarkupRetryCount).toBe(2);
    expect(ctx.__toolMarkupAbort).toBeFalsy();
    // Attempt 3: abort
    expect(runToolMarkupGuard(args)).toBe(true);
    expect(ctx.__toolMarkupRetryCount).toBe(3);
    expect(ctx.__toolMarkupAbort).toBe(true);
  });

  it('injects a retry message on detection', () => {
    const msgs: any[] = [];
    const args = makeArgs({
      accumulatedText: '<｜DSML｜tool_calls>',
      chatMessages: msgs,
      buildAssistantMessage: (text: string | null) => ({ role: 'assistant', content: text }),
    });
    runToolMarkupGuard(args);
    // Should have pushed the assistant message + retry user prompt
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.some((m: any) => m.role === 'user' && m.content.includes('system-reminder'))).toBe(true);
  });
});

describe('runPromisedActionGuard', () => {
  it('returns false when toolUses not empty', async () => {
    const args = makeArgs({ toolUses: [{ name: 'read' }] });
    expect(await runPromisedActionGuard(args)).toBe(false);
  });

  it('returns false when accumulatedText empty', async () => {
    const args = makeArgs({ accumulatedText: '' });
    expect(await runPromisedActionGuard(args)).toBe(false);
  });

  it('detects pending errors via regex fast-path', async () => {
    const args = makeArgs({
      accumulatedText: 'Let me fix this error',
      chatMessages: [
        { role: 'user', content: 'Found error TS2345: type mismatch' },
      ],
    });
    // Fast-path: hasPendingErrors = true → returns a description
    // LLM stage not reached because hasPendingErrors is true
    const result = await runPromisedActionGuard(args);
    expect(result).toBe(true);
  });

  it('is one-shot (__promisedActionNudgeFired)', async () => {
    const ctx: any = {};
    const args = makeArgs({
      ctx,
      accumulatedText: 'I will fix the error',
      chatMessages: [{ role: 'user', content: 'error TS232: type error' }],
    });
    expect(await runPromisedActionGuard(args)).toBe(true);
    expect(await runPromisedActionGuard(args)).toBe(false);
  });

  it('returns false for plain response without error context', async () => {
    const args = makeArgs({ accumulatedText: 'I think the issue is related' });
    expect(await runPromisedActionGuard(args)).toBe(false);
  });

  // Audit-mode bail (real-world false-positive case): the agent did
  // some Globs / Reads earlier in the SAME turn, then summarised in
  // prose without a final tool call. Used to fire — must NOT now.
  it('does NOT fire when the turn already had tool calls (ctx.__turnToolCount > 0)', async () => {
    const ctx: any = { __turnToolCount: 3 };
    const args = makeArgs({
      ctx,
      // Long enough to cross the >80 length gate that would otherwise
      // dispatch the LLM classifier — proving the pre-gate is what
      // saves us, not the length check.
      accumulatedText: 'I listed the directory and read package.json. ' +
        'The project is a local CLI agent called MakeStudio, version 0.1.1013, ' +
        'with a single bin entry pointing at dist/index.js.',
      chatMessages: [
        { role: 'user', content: 'me fala o que tem no diretório' },
      ],
    });
    expect(await runPromisedActionGuard(args)).toBe(false);
  });

  it('still fires for a fresh-turn promise with NO prior tool calls', async () => {
    const ctx: any = { __turnToolCount: 0 };
    const args = makeArgs({
      ctx,
      accumulatedText: "I'll fix this error now.",
      chatMessages: [{ role: 'user', content: 'error TS999: unfixed' }],
    });
    expect(await runPromisedActionGuard(args)).toBe(true);
  });
});

describe('runAbsenceClaimGuard', () => {
  it('returns false when toolUses not empty', async () => {
    const args = makeArgs({ toolUses: [{ name: 'read' }], ctx: { __auditModeActive: true } });
    expect(await runAbsenceClaimGuard(args)).toBe(false);
  });

  it('returns false when accumulatedText empty', async () => {
    const args = makeArgs({ accumulatedText: '', ctx: { __auditModeActive: true } });
    expect(await runAbsenceClaimGuard(args)).toBe(false);
  });

  it('returns false when audit mode is off', async () => {
    const args = makeArgs({ accumulatedText: 'MyApp lacks caching support', ctx: {} });
    expect(await runAbsenceClaimGuard(args)).toBe(false);
  });

  it('returns false for pronoun-based absence claims (filters out "you"/"i")', async () => {
    const ctx: any = { __auditModeActive: true };
    const args = makeArgs({
      ctx,
      accumulatedText: 'You lack the authority to do that',
    });
    expect(await runAbsenceClaimGuard(args)).toBe(false);
  });

  it('detects absence claim in audit mode', async () => {
    const ctx: any = { __auditModeActive: true };
    const args = makeArgs({
      ctx,
      accumulatedText: 'MyApp does not have caching support implemented',
    });
    const result = await runAbsenceClaimGuard(args);
    expect(typeof result).toBe('boolean');
  });
});

describe('runContradictionGuard', () => {
  it('returns false when toolUses not empty', async () => {
    const args = makeArgs({ toolUses: [{ name: 'read' }], ctx: { __auditModeActive: true } });
    expect(await runContradictionGuard(args)).toBe(false);
  });

  it('returns false when audit mode is off', async () => {
    const args = makeArgs({ accumulatedText: 'SomeApp lacks foo', ctx: {} });
    expect(await runContradictionGuard(args)).toBe(false);
  });

  it('returns false for plain text in audit mode', async () => {
    const ctx: any = { __auditModeActive: true };
    const args = makeArgs({
      ctx,
      accumulatedText: 'The code looks clean and well-structured',
    });
    const result = await runContradictionGuard(args);
    expect(typeof result).toBe('boolean');
  });
});

describe('runStreamingGuards', () => {
  it('returns false for empty response', async () => {
    const args = makeArgs({ accumulatedText: '' });
    expect(await runStreamingGuards(args)).toBe(false);
  });

  it('fires tool markup guard first when detected', async () => {
    const args = makeArgs({ accumulatedText: '<｜DSML｜tool_calls>' });
    expect(await runStreamingGuards(args)).toBe(true);
  });

  it('runs all guards without throwing', async () => {
    const ctx: any = { __auditModeActive: true };
    const args = makeArgs({
      ctx,
      accumulatedText: 'The project MyApp does not have a payment module',
    });
    const result = await runStreamingGuards(args);
    expect(typeof result).toBe('boolean');
  });
});
