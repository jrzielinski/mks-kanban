import { incrementalPrune, resetSmartPruneCache } from './smart-prune';

const KEEP_RECENT = 12;

function makeOldUserMsg(content: string): any {
  return { role: 'user', content };
}

function makeRead(toolUseId: string, file_path: string): any {
  return { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path } }] };
}

function makeBash(toolUseId: string, command: string): any {
  return { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }] };
}

function makeToolResult(toolUseId: string, content: string): any {
  return { role: 'tool', tool_call_id: toolUseId, content };
}

function ctxWith(messages: any[]) {
  return { messages };
}

describe('smart-prune.incrementalPrune', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_SMART_PRUNE;
    resetSmartPruneCache();
  });

  describe('disabled (default)', () => {
    it('is a no-op when MAKESTUDIO_SMART_PRUNE is unset', () => {
      const messages: any[] = [];
      // Build duplicate Reads with old enough position
      for (let i = 0; i < KEEP_RECENT + 4; i++) messages.push(makeOldUserMsg('pad'));
      const before = JSON.stringify(messages);
      const result = incrementalPrune(ctxWith(messages));
      expect(result.duplicatesStubbed).toBe(0);
      expect(JSON.stringify(messages)).toBe(before);
    });
  });

  describe('enabled', () => {
    beforeEach(() => {
      process.env.MAKESTUDIO_SMART_PRUNE = '1';
      resetSmartPruneCache();
    });

    it('stubs duplicate Read tool_results in old segment', () => {
      const original = '<<<a-very-long-line-of-content-that-comfortably-exceeds-the-stub-size>>>'.repeat(10);
      const messages: any[] = [
        makeRead('tu1', '/a.ts'),
        makeToolResult('tu1', original),
        makeRead('tu2', '/a.ts'),
        makeToolResult('tu2', original),
      ];
      // Push enough recent messages to keep the duplicates in "old" segment
      for (let i = 0; i < KEEP_RECENT + 1; i++) messages.push(makeOldUserMsg('pad ' + i));

      const result = incrementalPrune(ctxWith(messages));
      expect(result.duplicatesStubbed).toBe(1); // only the FIRST is stubbed
      expect(messages[1].content).toMatch(/result superseded/);
      expect(messages[3].content).toBe(original); // survivor untouched
    });

    it('does NOT stub duplicates within the recent window', () => {
      const original = '<<<a>>>';
      const messages: any[] = [
        makeRead('tu1', '/a.ts'),
        makeToolResult('tu1', original),
        makeRead('tu2', '/a.ts'),
        makeToolResult('tu2', original),
      ];
      const result = incrementalPrune(ctxWith(messages));
      expect(result.duplicatesStubbed).toBe(0);
      expect(messages[1].content).toBe(original);
    });

    it('stubs old failed tool_results', () => {
      const fail = `Error: command not found\n${'x'.repeat(300)}`;
      const messages: any[] = [
        makeBash('tu1', 'bad-cmd'),
        makeToolResult('tu1', fail),
      ];
      for (let i = 0; i < KEEP_RECENT + 1; i++) messages.push(makeOldUserMsg('pad ' + i));

      const result = incrementalPrune(ctxWith(messages));
      expect(result.failuresStubbed).toBeGreaterThanOrEqual(1);
      expect(messages[1].content).toMatch(/old failed tool call/);
    });

    it('does NOT stub short failures (<200 chars stay verbatim)', () => {
      const messages: any[] = [
        makeBash('tu1', 'bad'),
        makeToolResult('tu1', 'Error: short'),
      ];
      for (let i = 0; i < KEEP_RECENT + 1; i++) messages.push(makeOldUserMsg('pad ' + i));
      const result = incrementalPrune(ctxWith(messages));
      expect(result.failuresStubbed).toBe(0);
      expect(messages[1].content).toBe('Error: short');
    });

    it('trims verbose old Bash output (head + tail kept)', () => {
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) lines.push('line ' + i);
      const verbose = lines.join('\n');

      const messages: any[] = [
        makeBash('tu1', 'verbose'),
        makeToolResult('tu1', verbose),
      ];
      for (let i = 0; i < KEEP_RECENT + 1; i++) messages.push(makeOldUserMsg('pad ' + i));

      const result = incrementalPrune(ctxWith(messages));
      expect(result.bashTrimmed).toBe(1);
      const trimmed = messages[1].content;
      expect(trimmed).toContain('line 0'); // head preserved
      expect(trimmed).toContain('line 99'); // tail preserved
      expect(trimmed).toContain('middle elided by smartPrune');
      expect(trimmed.length).toBeLessThan(verbose.length);
    });

    it('is idempotent — second call does nothing', () => {
      const original = '<<<looooong-content-line-that-is-bigger-than-the-stub>>>'.repeat(10);
      const messages: any[] = [
        makeRead('tu1', '/x.ts'),
        makeToolResult('tu1', original),
        makeRead('tu2', '/x.ts'),
        makeToolResult('tu2', original),
      ];
      for (let i = 0; i < KEEP_RECENT + 1; i++) messages.push(makeOldUserMsg('pad ' + i));

      incrementalPrune(ctxWith(messages));
      const after1 = JSON.stringify(messages);
      const result2 = incrementalPrune(ctxWith(messages));
      expect(result2.duplicatesStubbed).toBe(0);
      expect(JSON.stringify(messages)).toBe(after1);
    });

    it('does not dedup Edit (mutating tool)', () => {
      const messages: any[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } }] },
        makeToolResult('tu1', 'Edited /a.ts'.repeat(50)),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } }] },
        makeToolResult('tu2', 'Edited /a.ts'.repeat(50)),
      ];
      for (let i = 0; i < KEEP_RECENT + 1; i++) messages.push(makeOldUserMsg('pad ' + i));
      const result = incrementalPrune(ctxWith(messages));
      expect(result.duplicatesStubbed).toBe(0);
    });
  });
});
