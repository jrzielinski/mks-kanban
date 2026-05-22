import { toolPinSessionConstraint, SESSION_CONSTRAINT_TOOL_HANDLERS } from './session-constraint';
import { listConstraints, clearConstraints } from '../../session-constraints';

const makeCtx = (): any => ({});

describe('pin_session_constraint tool handler', () => {
  it('exports a single handler under the expected name', () => {
    expect(SESSION_CONSTRAINT_TOOL_HANDLERS).toHaveLength(1);
    expect(SESSION_CONSTRAINT_TOOL_HANDLERS[0].name).toBe('pin_session_constraint');
  });

  it('persists text and verifyCommand on ctx', async () => {
    const ctx = makeCtx();
    const r = await toolPinSessionConstraint(
      { text: 'Typecheck must pass.', verifyCommand: 'npx tsc --noEmit' },
      ctx,
    );
    const parsed = JSON.parse(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.new).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.pinned).toEqual({
      text: 'Typecheck must pass.',
      verifyCommand: 'npx tsc --noEmit',
    });
    expect(listConstraints(ctx)).toEqual([
      { text: 'Typecheck must pass.', verifyCommand: 'npx tsc --noEmit' },
    ]);
    clearConstraints(ctx);
  });

  it('persists text-only constraints with verifyCommand=null', async () => {
    const ctx = makeCtx();
    const r = await toolPinSessionConstraint({ text: 'no force-pushes to main' }, ctx);
    const parsed = JSON.parse(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.pinned).toEqual({ text: 'no force-pushes to main', verifyCommand: null });
    clearConstraints(ctx);
  });

  it('reports new=false when the same text is pinned twice', async () => {
    const ctx = makeCtx();
    await toolPinSessionConstraint({ text: 'rule', verifyCommand: 'cmd-a' }, ctx);
    const r = await toolPinSessionConstraint({ text: 'rule', verifyCommand: 'cmd-a' }, ctx);
    const parsed = JSON.parse(r);
    expect(parsed.new).toBe(false);
    expect(parsed.total).toBe(1);
    clearConstraints(ctx);
  });

  it('trims surrounding whitespace from text and verifyCommand', async () => {
    const ctx = makeCtx();
    await toolPinSessionConstraint(
      { text: '   tests must pass   ', verifyCommand: '  cargo test  ' },
      ctx,
    );
    expect(listConstraints(ctx)).toEqual([
      { text: 'tests must pass', verifyCommand: 'cargo test' },
    ]);
    clearConstraints(ctx);
  });

  it('returns an error JSON when text is missing', async () => {
    const ctx = makeCtx();
    const r = await toolPinSessionConstraint({}, ctx);
    const parsed = JSON.parse(r);
    expect(parsed.error).toMatch(/text required/);
    expect(listConstraints(ctx)).toEqual([]);
  });

  it('returns an error JSON when verifyCommand is provided but is not a string', async () => {
    const ctx = makeCtx();
    const r = await toolPinSessionConstraint({ text: 'foo', verifyCommand: 42 }, ctx);
    const parsed = JSON.parse(r);
    expect(parsed.error).toMatch(/verifyCommand must be a shell command string/);
    expect(listConstraints(ctx)).toEqual([]);
  });

  it('treats an empty-string verifyCommand the same as missing', async () => {
    const ctx = makeCtx();
    await toolPinSessionConstraint({ text: 'rule', verifyCommand: '' }, ctx);
    expect(listConstraints(ctx)).toEqual([
      { text: 'rule', verifyCommand: null },
    ]);
    clearConstraints(ctx);
  });

  it('accepts any shell command — language-agnostic by design', async () => {
    const examples = [
      'npx tsc --noEmit',
      'cargo check',
      'pytest -q',
      'flutter analyze',
      'mvn verify',
      'go vet ./...',
    ];
    for (const cmd of examples) {
      const ctx = makeCtx();
      const r = await toolPinSessionConstraint({ text: `rule for ${cmd}`, verifyCommand: cmd }, ctx);
      const parsed = JSON.parse(r);
      expect(parsed.ok).toBe(true);
      expect(parsed.pinned.verifyCommand).toBe(cmd);
    }
  });
});
