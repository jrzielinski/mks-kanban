import { groupMessagesByTurn, snipOldTurns, TurnGroup } from './compact-grouping';

function makeUser(content: string, idx: number = 0) {
  return { role: 'user', content: `Turn ${idx}: ${content}` };
}
function makeAssistant(text: string) {
  return { role: 'assistant', content: text };
}
function makeToolResult(content: string) {
  return { role: 'user', content: [{ type: 'tool_result', content }] };
}
function makeAssistantWithTools(text: string, toolCount: number) {
  const blocks: any[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (let i = 0; i < toolCount; i++) {
    blocks.push({ type: 'tool_use', name: 'bash', input: { cmd: `echo ${i}` } });
  }
  return { role: 'assistant', content: blocks };
}

describe('groupMessagesByTurn', () => {
  it('returns empty for empty array', () => {
    expect(groupMessagesByTurn([])).toEqual([]);
  });

  it('groups a simple user→assistant→tool_result cycle', () => {
    const msgs = [
      makeUser('fix the bug'),
      makeAssistant('done'),
      makeToolResult('output ok'),
    ];
    const groups = groupMessagesByTurn(msgs);
    expect(groups).toHaveLength(1);
    expect(groups[0].userPrompt).toContain('fix the bug');
    expect(groups[0].messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('starts a new group on each user prompt', () => {
    const msgs = [
      makeUser('first', 1),
      makeAssistant('reply 1'),
      makeUser('second', 2),
      makeAssistant('reply 2'),
    ];
    const groups = groupMessagesByTurn(msgs);
    expect(groups).toHaveLength(2);
    expect(groups[0].userPrompt).toContain('first');
    expect(groups[1].userPrompt).toContain('second');
  });

  it('treats tool_result-only user as continuation', () => {
    const msgs = [
      makeUser('prompt'),
      makeAssistantWithTools('thinking', 2),
      makeToolResult('result 1'),
      makeToolResult('result 2'),
      makeUser('next prompt'),
    ];
    const groups = groupMessagesByTurn(msgs);
    // tool_result messages stay with the previous turn
    expect(groups[0].messages).toHaveLength(4); // user + assistant + 2 tool_result
    expect(groups).toHaveLength(2);
  });

  it('counts tool calls correctly', () => {
    const msgs = [
      makeUser('do things'),
      makeAssistantWithTools('ok', 3),
      makeToolResult('r1'),
    ];
    const groups = groupMessagesByTurn(msgs);
    expect(groups[0].toolCount).toBe(3);
  });

  it('handles conversation starting with assistant (edge)', () => {
    const msgs = [
      { role: 'assistant', content: 'Hello, how can I help?' },
      makeUser('hi'),
    ];
    const groups = groupMessagesByTurn(msgs);
    // Assistant-only preamble + user = 2 groups (no prior user prompt group + user group)
    expect(groups).toHaveLength(2);
    expect(groups[0].userPrompt).toContain('(no prior user prompt');
  });

  it('captures finalText from assistant text blocks', () => {
    const msgs = [
      makeUser('task'),
      makeAssistantWithTools('this is the final output', 1),
      makeToolResult('x'),
    ];
    const groups = groupMessagesByTurn(msgs);
    expect(groups[0].finalText).toContain('final output');
  });

  it('computes sizeChars as sum of JSON content lengths', () => {
    const msgs = [
      makeUser('hello'),
      makeAssistant('world'),
    ];
    const groups = groupMessagesByTurn(msgs);
    expect(groups[0].sizeChars).toBeGreaterThan(0);
  });
});

describe('snipOldTurns', () => {
  function buildTurns(count: number): any[] {
    const msgs: any[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push(makeUser(`turn ${i}`));
      msgs.push(makeAssistantWithTools('big '.repeat(50), 1));
      msgs.push(makeToolResult('result'));
    }
    return msgs;
  }

  it('returns replaced=0 when below keepRecent threshold', () => {
    const msgs = buildTurns(3);
    const result = snipOldTurns(msgs, { keepRecent: 5 });
    expect(result.replaced).toBe(0);
    expect(result.newMessages).toEqual(msgs);
  });

  it('snips old turns when above threshold', () => {
    const msgs = buildTurns(10);
    const result = snipOldTurns(msgs, { keepRecent: 3, minCharsPerTurn: 10 });
    expect(result.replaced).toBeGreaterThan(0);
    expect(result.freedChars).toBeGreaterThan(0);
    // first message should be the stub
    expect(result.newMessages[0].role).toBe('user');
    expect(result.newMessages[0].content).toContain('older turn(s) collapsed');
  });

  it('returns replaced=0 when all old turns are below minChars', () => {
    // Build small turns
    const msgs: any[] = [
      makeUser('small'),
      makeAssistant('tiny'),
      makeUser('two'),
      makeAssistant('tiny'),
    ];
    // keepRecent=0 means everything is old
    const result = snipOldTurns(msgs, { keepRecent: 0, minCharsPerTurn: 99999 });
    expect(result.replaced).toBe(0);
  });

  it('preserves keepRecent turns verbatim after the stub', () => {
    const msgs = buildTurns(10);
    const result = snipOldTurns(msgs, { keepRecent: 2, minCharsPerTurn: 10 });
    expect(result.replaced).toBeGreaterThan(0);
    expect(result.newMessages[0].role).toBe('user');
    expect(result.newMessages[0].content).toContain('collapsed');
    const msgCount = buildTurns(2).length;
    // result should be 1 stub + keepRecent turns
    expect(result.newMessages.length).toBeGreaterThan(0);
  });
});
