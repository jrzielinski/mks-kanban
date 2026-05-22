import { compactToolUseInputs } from './micro-compact';

/**
 * Tests for the diff-summary enhancement: compactToolUseInputs replaces
 * old Edit/Write/MultiEdit input blocks with a stub that contains a
 * one-line summary describing what the call did. Without the summary,
 * the model in a long session has zero structural memory of past
 * edits; with it, it sees `[Edit applied to foo.ts (replaced 3 lines
 * with 5 lines)]` instead of just "original args omitted".
 */

const KEEP_RECENT = 10;
const PADDING = 'x'.repeat(900); // pushes input length above MIN_CHARS gate

function buildAssistantWithToolUse(name: string, input: any): any {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tu_1', name, input: { ...input, _padding: PADDING } },
    ],
  };
}

function makeCtxWithOld(name: string, input: any) {
  // Need > KEEP_RECENT + 2 messages for the compactor's gate to pass
  // (it returns early when total <= KEEP_RECENT + 2). KEEP_RECENT=10
  // → need at least 13 messages, so the first one is in the "old"
  // segment of length 13 - 10 = 3.
  const messages: any[] = [buildAssistantWithToolUse(name, input)];
  for (let i = 0; i < KEEP_RECENT + 3; i++) {
    messages.push({ role: 'user', content: 'pad ' + i });
  }
  return { messages };
}

describe('compactToolUseInputs — diff summary', () => {
  it('summarises Write with line + char counts', () => {
    const ctx = makeCtxWithOld('Write', {
      file_path: '/tmp/foo.ts',
      content: 'line1\nline2\nline3\n',
    });
    const res = compactToolUseInputs(ctx);
    expect(res.trimmed).toBe(1);
    const stub = (ctx as any).messages[0].content[0].input;
    expect(stub._omitted).toContain('wrote');
    expect(stub._omitted).toMatch(/4 lines/); // trailing newline → 4 splits
    expect(stub._omitted).toContain('chars');
    expect(stub.file_path).toBe('/tmp/foo.ts'); // path preserved
  });

  it('summarises Edit with replaced-by line counts', () => {
    const ctx = makeCtxWithOld('Edit', {
      file_path: '/tmp/bar.ts',
      old_string: 'line1\nline2\nline3',
      new_string: 'a\nb\nc\nd\ne',
    });
    compactToolUseInputs(ctx);
    const stub = (ctx as any).messages[0].content[0].input;
    expect(stub._omitted).toMatch(/replaced 3 lines with 5 lines/);
  });

  it('flags replace_all in Edit summary', () => {
    const ctx = makeCtxWithOld('Edit', {
      file_path: '/tmp/r.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    });
    compactToolUseInputs(ctx);
    const stub = (ctx as any).messages[0].content[0].input;
    expect(stub._omitted).toContain('replace_all');
  });

  it('summarises MultiEdit aggregating across edits', () => {
    const ctx = makeCtxWithOld('MultiEdit', {
      file_path: '/tmp/m.ts',
      edits: [
        { old_string: 'a\nb', new_string: 'x' },
        { old_string: 'c', new_string: 'y\nz\nw' },
      ],
    });
    compactToolUseInputs(ctx);
    const stub = (ctx as any).messages[0].content[0].input;
    expect(stub._omitted).toContain('2 edits');
    expect(stub._omitted).toMatch(/-3\/\+4/); // 2+1 old, 1+3 new
  });

  it('handles single-line Edit (1 line / 1 line wording)', () => {
    const ctx = makeCtxWithOld('Edit', {
      file_path: '/tmp/single.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
    compactToolUseInputs(ctx);
    const stub = (ctx as any).messages[0].content[0].input;
    expect(stub._omitted).toContain('replaced 1 line with 1 line');
  });

  it('preserves file_path in stub', () => {
    const ctx = makeCtxWithOld('Write', {
      file_path: '/tmp/preserve.ts',
      content: 'data',
    });
    compactToolUseInputs(ctx);
    const stub = (ctx as any).messages[0].content[0].input;
    expect(stub.file_path).toBe('/tmp/preserve.ts');
  });

  it('is idempotent — second call does not re-trim or alter stub', () => {
    const ctx = makeCtxWithOld('Edit', {
      file_path: '/tmp/idem.ts',
      old_string: 'a',
      new_string: 'b',
    });
    compactToolUseInputs(ctx);
    const firstStub = JSON.stringify((ctx as any).messages[0].content[0].input);
    const res2 = compactToolUseInputs(ctx);
    expect(res2.trimmed).toBe(0);
    expect(JSON.stringify((ctx as any).messages[0].content[0].input)).toBe(firstStub);
  });

  it('skips small inputs (below MIN_CHARS gate)', () => {
    // No padding → input fits in <800 chars → not trimmed
    const ctx = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Edit', input: { file_path: '/t.ts', old_string: 'a', new_string: 'b' } }],
        },
        ...Array.from({ length: KEEP_RECENT + 3 }, (_, i) => ({ role: 'user', content: 'p' + i })),
      ],
    };
    const res = compactToolUseInputs(ctx);
    expect(res.trimmed).toBe(0);
  });
});
