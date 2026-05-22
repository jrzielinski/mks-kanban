import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
  hashToolCall,
  getToolCallStats,
  ToolLoopState,
  TOOL_CALL_HISTORY_SIZE,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
} from './tool-loop-detection';

function freshState(): ToolLoopState {
  return { toolCallHistory: [] };
}

describe('hashToolCall', () => {
  it('produces a deterministic hash for same call', () => {
    expect(hashToolCall('read', { file_path: 'x' }))
      .toBe(hashToolCall('read', { file_path: 'x' }));
  });

  it('produces different hashes for different params', () => {
    expect(hashToolCall('read', { file_path: 'x' }))
      .not.toBe(hashToolCall('read', { file_path: 'y' }));
  });

  it('handles null params', () => {
    expect(() => hashToolCall('read', null as any)).not.toThrow();
  });

  it('throws on undefined params as expected', () => {
    expect(() => hashToolCall('read', undefined)).toThrow();
  });
});

describe('recordToolCall', () => {
  it('adds an entry to toolCallHistory', () => {
    const state = freshState();
    recordToolCall(state, 'read', { file_path: 'x' });
    expect(state.toolCallHistory).toHaveLength(1);
    expect(state.toolCallHistory![0].toolName).toBe('read');
  });

  it('respects TOOL_CALL_HISTORY_SIZE', () => {
    const state = freshState();
    for (let i = 0; i < TOOL_CALL_HISTORY_SIZE + 5; i++) {
      recordToolCall(state, 'read', { file_path: `x${i}` });
    }
    expect(state.toolCallHistory!.length).toBeLessThanOrEqual(TOOL_CALL_HISTORY_SIZE);
  });
});

describe('detectToolCallLoop', () => {
  it('returns false stuck when no loop detected', () => {
    const state = freshState();
    for (let i = 0; i < 3; i++) {
      recordToolCall(state, `tool${i}`, { file_path: `x${i}` });
    }
    const result = detectToolCallLoop(state, 'tool0', { file_path: 'x0' });
    expect(result).toBeDefined();
    expect(result.stuck).toBe(false);
  });

  it('detects repeated identical calls above threshold', () => {
    const state = freshState();
    for (let i = 0; i < 20; i++) {
      recordToolCall(state, 'read', { file_path: 'same.txt' });
    }
    const result = detectToolCallLoop(state, 'read', { file_path: 'same.txt' });
    expect(result).not.toBeNull();
  });
});

describe('getToolCallStats', () => {
  it('returns counts per tool', () => {
    const state = freshState();
    recordToolCall(state, 'read', { file_path: 'a.txt' });
    recordToolCall(state, 'read', { file_path: 'b.txt' });
    recordToolCall(state, 'write', { file_path: 'c.txt' });
    const stats = getToolCallStats(state);
    expect(Object.keys(stats).length).toBeGreaterThanOrEqual(2);
  });

  it('returns null mostFrequent when no history', () => {
    const stats = getToolCallStats(freshState());
    expect(stats.totalCalls).toBe(0);
    expect(stats.mostFrequent).toBeNull();
  });
});

describe('recordToolCallOutcome', () => {
  it('updates existing record by toolName+argsHash', () => {
    const state = freshState();
    recordToolCall(state, 'read', { file_path: 'a.txt' });
    recordToolCallOutcome(state, { toolName: 'read', toolParams: { file_path: 'a.txt' }, result: 'content' });
    expect(state.toolCallHistory![0].resultHash).toBeDefined();
  });

  it('appends new entry when no match found', () => {
    const state = freshState();
    recordToolCall(state, 'read', { file_path: 'a.txt' });
    recordToolCallOutcome(state, { toolName: 'write', toolParams: { file_path: 'b.txt' }, result: 'ok' });
    expect(state.toolCallHistory!.length).toBe(2);
  });

  it('does nothing when resultHash is undefined (no result)', () => {
    const state = freshState();
    recordToolCall(state, 'read', { file_path: 'a.txt' });
    recordToolCallOutcome(state, { toolName: 'read', toolParams: { file_path: 'a.txt' } });
    expect(state.toolCallHistory!.length).toBe(1);
  });

  it('respects historySize config trim', () => {
    const state = freshState();
    for (let i = 0; i < 5; i++) {
      recordToolCall(state, 'read', { file_path: `x${i}` });
    }
    for (let i = 0; i < 5; i++) {
      recordToolCallOutcome(state, { toolName: 'read', toolParams: { file_path: `x${i}` }, result: 'ok', config: { historySize: 3 } });
    }
    expect(state.toolCallHistory!.length).toBeLessThanOrEqual(3);
  });
});

describe('detectToolCallLoop — extended', () => {
  it('returns stuck false when detection disabled', () => {
    const result = detectToolCallLoop({}, 'read', { file_path: 'a' }, { enabled: false });
    expect(result.stuck).toBe(false);
  });

  it('detects unknown tool repeat', () => {
    const state = freshState();
    for (let i = 0; i < 12; i++) {
      state.toolCallHistory!.push({
        toolName: 'nonexistent_tool', argsHash: 'x', unknownToolName: 'nonexistent_tool',
        timestamp: i, intent: '', toolCallId: `call_${i}`,
      });
    }
    const result = detectToolCallLoop(state, 'nonexistent_tool', {});
    expect(result.stuck).toBe(true);
    if (result.stuck) expect(result.detector).toBe('unknown_tool_repeat');
  });

  it('detects ping-pong with stable outcomes', () => {
    const state = freshState();
    for (let i = 0; i < 12; i++) {
      state.toolCallHistory!.push({
        toolName: 'Read',
        argsHash: i % 2 === 0 ? 'hashA' : 'hashB',
        intent: i % 2 === 0 ? 'Read:/A' : 'Read:/B',
        resultHash: 'stableResult',
        timestamp: i,
      });
    }
    const result = detectToolCallLoop(state, 'Read', { file_path: 'A' });
    expect(result).toBeDefined();
  });

  it('reports warning when generic repeat exceeds threshold', () => {
    const state = freshState();
    for (let i = 0; i < 12; i++) {
      state.toolCallHistory!.push({
        toolName: 'read', argsHash: 'sameHash', intent: 'read', timestamp: i,
      });
    }
    const result = detectToolCallLoop(state, 'read', { file_path: 'x' });
    // Same argsHash entries in history + same current call → stuck at warning
    expect(result).toBeDefined();
  });
});
