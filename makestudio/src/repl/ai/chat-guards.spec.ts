import { runAntiFabricationGuards, GuardOptions } from './chat-guards';

function makeOpts(overrides: Partial<GuardOptions> = {}): GuardOptions {
  const msg: any[] = [];
  return {
    ctx: { activeProject: { localPath: '/tmp' } } as any,
    accumulatedText: 'some response text',
    toolUses: [],
    chatMessages: msg,
    buildAssistantMessage: (text: string | null) => ({ role: 'assistant', content: text }),
    surfaceInfo: () => {},
    surfaceWarn: () => {},
    ...overrides,
  };
}

describe('runAntiFabricationGuards', () => {
  it('returns false when toolUses is not empty', async () => {
    const opts = makeOpts({ toolUses: [{ name: 'bash' }] });
    expect(await runAntiFabricationGuards(opts)).toBe(false);
  });

  it('returns false when accumulatedText is empty', async () => {
    const opts = makeOpts({ accumulatedText: '' });
    expect(await runAntiFabricationGuards(opts)).toBe(false);
  });

  it('returns false for plain text without fabricated markers', async () => {
    // No shell-log markers, no fabricated output to detect
    const opts = makeOpts({ accumulatedText: 'this is a normal response' });
    expect(await runAntiFabricationGuards(opts)).toBe(false);
  });

  it('handles empty toolUses array', async () => {
    const opts = makeOpts({ toolUses: [] });
    expect(await runAntiFabricationGuards(opts)).toBe(false);
  });

  it('does not crash when llm-classifier is unavailable', async () => {
    // The guard internally requires('./llm-classifier') — without a fast
    // tier it returns null. Verify no crash.
    const opts = makeOpts({
      accumulatedText: '```\n$ grep foo\noutput\n```\nVerdict: X exists',
    });
    const result = await runAntiFabricationGuards(opts);
    expect(typeof result).toBe('boolean');
  });

  it('does not crash on long response text', async () => {
    const long = 'check this file '.repeat(500);
    const opts = makeOpts({ accumulatedText: long });
    const result = await runAntiFabricationGuards(opts);
    expect(typeof result).toBe('boolean');
  });

  it('does not crash when no guards fire (success path)', async () => {
    const ctx: any = { activeProject: { localPath: '/tmp' } };
    const opts = makeOpts({
      ctx,
      accumulatedText: 'this is a normal response without tool blocks',
    });
    const result = await runAntiFabricationGuards(opts);
    expect(typeof result).toBe('boolean');
  });

  it('does not crash with shell log markers but no LLM', async () => {
    const msgs: any[] = [];
    const opts = makeOpts({
      accumulatedText: '```\noutput block\n```\nresult: pass',
      chatMessages: msgs,
    });
    const result = await runAntiFabricationGuards(opts);
    expect(typeof result).toBe('boolean');
  });
});
