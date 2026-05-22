import { microCompact, apiMicroCompact } from './micro-compact';

/** Build a ctx with N messages — first half = old, last 10 = recent (untouchable). */
function makeCtx(messages: any[]): any {
  return { messages };
}

describe('microCompact (char-based)', () => {
  it('no-ops when there aren\'t enough messages to have an "old" segment', () => {
    const ctx = makeCtx([{ role: 'tool', tool_call_id: 'a', content: 'x'.repeat(5000) }]);
    expect(microCompact(ctx)).toEqual({ trimmed: 0, freedChars: 0 });
    expect(ctx.messages[0].content).toHaveLength(5000); // untouched
  });

  it('truncates large tool messages in the OLD segment, keeps RECENT untouched', () => {
    // 12 messages: indices 0..1 are old; 2..11 are the "recent 10" preserved.
    const huge = 'y'.repeat(5000);
    const messages: any[] = [];
    for (let i = 0; i < 14; i++) {
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: huge });
    }
    const ctx = makeCtx(messages);
    const res = microCompact(ctx);
    expect(res.trimmed).toBeGreaterThan(0);
    // Old (index 0) was trimmed
    expect(messages[0].content.length).toBeLessThan(huge.length);
    // Recent (last) stayed verbatim
    expect(messages[messages.length - 1].content).toBe(huge);
  });

  it('preserves line-friendly truncation when the payload has ≥8 newlines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i} ${'.'.repeat(80)}`).join('\n');
    const messages: any[] = [];
    for (let i = 0; i < 14; i++) {
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: lines });
    }
    // Force "Anthropic style" content array on the OLD index so the line-
    // boundary branch is exercised (the role:'tool' branch always uses stub).
    messages[0] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: lines }] };
    const ctx = makeCtx(messages);
    const res = microCompact(ctx);
    expect(res.trimmed).toBeGreaterThan(0);
    const newContent = messages[0].content[0].content;
    expect(newContent).toMatch(/line-/);   // some lines preserved
    expect(newContent).toMatch(/truncated/); // footer present
  });

  it('idempotent — second pass over already-trimmed content does nothing extra', () => {
    const huge = 'z'.repeat(5000);
    const messages: any[] = [];
    for (let i = 0; i < 14; i++) {
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: huge });
    }
    const ctx = makeCtx(messages);
    microCompact(ctx);
    const second = microCompact(ctx);
    expect(second.trimmed).toBe(0);
  });
});

describe('apiMicroCompact (token-based)', () => {
  it('preserves Write/Edit/MultiEdit results via tool name lookup', () => {
    // Build a long JSON-shape tool_result that would otherwise be trimmed.
    const big = '{' + '"k":"v",'.repeat(2000) + '"end":1}'; // dense JSON
    const messages: any[] = [];
    // assistant uses 'Edit' (preserve), then tool_result, then padding
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: big }],
    });
    for (let i = 0; i < 11; i++) messages.push({ role: 'user', content: 'x' });
    const ctx = makeCtx(messages);
    const res = apiMicroCompact(ctx);
    // Edit result must be preserved untouched.
    expect(messages[1].content[0].content).toBe(big);
    expect(res.trimmed).toBe(0);
  });

  it('clears Read tool results when above the token threshold', () => {
    const big = '{' + '"k":"v",'.repeat(2000) + '"end":1}';
    const messages: any[] = [];
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: big }],
    });
    for (let i = 0; i < 11; i++) messages.push({ role: 'user', content: 'x' });
    const ctx = makeCtx(messages);
    const res = apiMicroCompact(ctx);
    expect(res.trimmed).toBe(1);
    expect(messages[1].content[0].content).toMatch(/truncated by apiMicroCompact/);
  });

  it('OpenAI tool_calls path also drives the policy gate', () => {
    const big = '{' + '"x":"y",'.repeat(2000) + '"e":1}';
    const messages: any[] = [];
    messages.push({
      role: 'assistant',
      tool_calls: [{ id: 't1', function: { name: 'Read' } }],
    });
    messages.push({ role: 'tool', tool_call_id: 't1', content: big });
    for (let i = 0; i < 11; i++) messages.push({ role: 'user', content: 'x' });
    const ctx = makeCtx(messages);
    const res = apiMicroCompact(ctx);
    expect(res.trimmed).toBe(1);
    expect(messages[1].content).toMatch(/truncated by apiMicroCompact/);
  });

  it('no-ops when below threshold count', () => {
    const ctx = makeCtx([{ role: 'tool', tool_call_id: 'a', content: 'small' }]);
    expect(apiMicroCompact(ctx)).toEqual({ trimmed: 0, freedTokens: 0 });
  });
});
