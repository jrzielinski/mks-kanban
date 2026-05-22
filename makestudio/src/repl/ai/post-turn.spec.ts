import { runStreamingPostTurn } from './post-turn';

function mockCtx(overrides: any = {}): any {
  return {
    cwd: '/tmp/test',
    currentAbortController: new AbortController(),
    messages: [],
    provider: 'claude',
    ...overrides,
  };
}

function mockBridge(overrides: any = {}): any {
  const msgs: any[] = [];
  return {
    addMessage: (m: any) => { msgs.push(m); },
    messages: msgs,
    ...overrides,
  };
}

describe('runStreamingPostTurn', () => {
  it('runs full pipeline without throwing when all requires succeed', async () => {
    const ctx = mockCtx();
    const bridge = mockBridge();
    // The function uses dynamic require() inside try/catch — we can't
    // mock those from outside (they are resolved at runtime from the
    // module's location). This test verifies the function doesn't crash
    // on the happy path where modules exist.
    // We pass valid args and expect no throw.
    await expect(
      runStreamingPostTurn(ctx, bridge, 'input', 'final text'),
    ).resolves.toBeUndefined();
  });

  it('handles bridge without addMessage gracefully', async () => {
    const ctx = mockCtx();
    const bridge = {}; // no addMessage
    await expect(
      runStreamingPostTurn(ctx, bridge, 'hi', 'ok'),
    ).resolves.toBeUndefined();
  });

  it('handles null ctx gracefully', async () => {
    // Should not throw even with minimal ctx
    const ctx: any = {};
    const bridge = { addMessage: () => {} };
    await expect(
      runStreamingPostTurn(ctx, bridge, '', ''),
    ).resolves.toBeUndefined();
  });

  it('handles ctx without cwd', async () => {
    const ctx: any = { messages: [] };
    const bridge = { addMessage: () => {} };
    await expect(
      runStreamingPostTurn(ctx, bridge, 'input', 'text'),
    ).resolves.toBeUndefined();
  });
});
