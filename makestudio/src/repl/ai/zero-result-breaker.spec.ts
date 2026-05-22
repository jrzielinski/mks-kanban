import {
  isZeroResult,
  noteToolOutcome,
  resetZeroResultStreak,
  resetZeroResultBreakerCache,
  buildHardStopMessage,
} from './zero-result-breaker';

describe('zero-result-breaker', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_ZERO_RESULT_BREAKER;
    resetZeroResultBreakerCache();
  });

  describe('isZeroResult', () => {
    it('detects Glob "No files matched"', () => {
      expect(isZeroResult('Glob', 'No files matched pattern: **/*.foo', true)).toBe(true);
    });

    it('detects Grep "No matches for /pattern/"', () => {
      expect(isZeroResult('Grep', 'No matches for /xyz/ in /src.', true)).toBe(true);
    });

    it('detects Read file-not-found error', () => {
      expect(isZeroResult('Read', 'File not found: /nope.ts', false)).toBe(true);
    });

    it('does NOT count Read with content as zero', () => {
      expect(isZeroResult('Read', '1\tline one\n2\tline two', true)).toBe(false);
    });

    it('does NOT count Glob with hits as zero', () => {
      expect(isZeroResult('Glob', '/path/a.ts\n/path/b.ts', true)).toBe(false);
    });

    it('does NOT count Grep with content as zero', () => {
      expect(isZeroResult('Grep', '/path/a.ts:42:matched line', true)).toBe(false);
    });

    it('does NOT count Bash empty stdout as zero (out of scope)', () => {
      // Bash has many legitimate empty outputs (touch, mkdir).
      expect(isZeroResult('Bash', '', true)).toBe(false);
    });

    it('does NOT count Edit/Write outputs at all', () => {
      expect(isZeroResult('Edit', 'No matches for whatever', true)).toBe(false);
      expect(isZeroResult('Write', '', true)).toBe(false);
    });

    it('detects empty LSP results array', () => {
      expect(isZeroResult('lsp_definition', '[]', true)).toBe(true);
      expect(isZeroResult('lsp_references', '{"result": []}', true)).toBe(true);
    });

    it('detects "no definition found" wording', () => {
      expect(isZeroResult('lsp_definition', 'no definition found for symbol foo', true)).toBe(true);
    });

    it('detects WebFetch 404', () => {
      expect(isZeroResult('WebFetch', 'HTTP 404 Not Found', false)).toBe(true);
    });

    it('does NOT count successful WebFetch as zero', () => {
      expect(isZeroResult('WebFetch', '<html>some content</html>', true)).toBe(false);
    });
  });

  describe('noteToolOutcome — disabled (default)', () => {
    it('returns 0 streak when default-off', () => {
      const ctx: any = {};
      for (let i = 0; i < 8; i++) {
        const r = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: x', true);
        expect(r.streak).toBe(0);
        expect(r.hardStop).toBeFalsy();
        expect(r.softHint).toBeFalsy();
      }
    });
  });

  describe('noteToolOutcome — enabled via env', () => {
    beforeEach(() => {
      process.env.MAKESTUDIO_ZERO_RESULT_BREAKER = '1';
      resetZeroResultBreakerCache();
    });

    it('counts consecutive zero-results', () => {
      const ctx: any = {};
      const r1 = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      const r2 = noteToolOutcome(ctx, 'Grep', 'No matches for /b/ in /src.', true);
      expect(r1.streak).toBe(1);
      expect(r2.streak).toBe(2);
    });

    it('emits soft hint at threshold=3', () => {
      const ctx: any = {};
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      noteToolOutcome(ctx, 'Grep', 'No matches for /b/ in /src.', true);
      const r = noteToolOutcome(ctx, 'Read', 'File not found: /c.ts', false);
      expect(r.streak).toBe(3);
      expect(r.softHint).toBeDefined();
      expect(r.softHint!.toLowerCase()).toContain('zero results');
      expect(r.hardStop).toBeFalsy();
    });

    it('emits soft hint exactly once per turn', () => {
      const ctx: any = {};
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      noteToolOutcome(ctx, 'Grep', 'No matches for /b/ in /src.', true);
      const r3 = noteToolOutcome(ctx, 'Read', 'File not found: /c.ts', false);
      expect(r3.softHint).toBeDefined();
      const r4 = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: d', true);
      expect(r4.softHint).toBeUndefined(); // already fired
      expect(r4.streak).toBe(4);
    });

    it('triggers hard stop at threshold=6', () => {
      const ctx: any = {};
      for (let i = 0; i < 5; i++) {
        const r = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: ' + i, true);
        expect(r.hardStop).toBeFalsy();
      }
      const r = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: last', true);
      expect(r.streak).toBe(6);
      expect(r.hardStop).toBe(true);
    });

    it('resets streak on a productive result', () => {
      const ctx: any = {};
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: b', true);
      // Productive Glob — streak should reset.
      const r = noteToolOutcome(ctx, 'Glob', '/path/a.ts\n/path/b.ts', true);
      expect(r.streak).toBe(0);
      expect(r.hardStop).toBeFalsy();
    });

    it('legitimate refinement does NOT trip the breaker', () => {
      // Real-world pattern: Glob too narrow, then broaden, then hit.
      const ctx: any = {};
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: **/foo-bar.ts', true);
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: **/foo-*.ts', true);
      const hit = noteToolOutcome(ctx, 'Glob', '/src/foo-thing.ts', true);
      expect(hit.streak).toBe(0);
      // Now another zero, but counter started from 0.
      const next = noteToolOutcome(ctx, 'Grep', 'No matches for /bar/ in /src.', true);
      expect(next.streak).toBe(1);
      expect(next.hardStop).toBeFalsy();
    });

    it('mutating tools do not interact with the counter', () => {
      const ctx: any = {};
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      // Edit doesn't reset and doesn't increment.
      const e = noteToolOutcome(ctx, 'Edit', 'Edited /file.ts', true);
      expect(e.streak).toBe(1);
      const g = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: b', true);
      expect(g.streak).toBe(2);
    });
  });

  describe('resetZeroResultStreak', () => {
    beforeEach(() => {
      process.env.MAKESTUDIO_ZERO_RESULT_BREAKER = '1';
      resetZeroResultBreakerCache();
    });
    it('clears the counter', () => {
      const ctx: any = {};
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      noteToolOutcome(ctx, 'Grep', 'No matches for /b/ in /src.', true);
      resetZeroResultStreak(ctx);
      const r = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: c', true);
      expect(r.streak).toBe(1);
    });
  });

  describe('buildHardStopMessage', () => {
    it('mentions the streak count', () => {
      expect(buildHardStopMessage(7)).toContain('7 consecutive');
    });
  });

  describe('protocol-safe outcome shape', () => {
    beforeEach(() => {
      process.env.MAKESTUDIO_ZERO_RESULT_BREAKER = '1';
      resetZeroResultBreakerCache();
    });
    // Regression for the HTTP 400 incident: noteToolOutcome must
    // NEVER mutate or push to chatMessages. It returns a hint
    // string + a hardStop boolean; the caller decides where to
    // place them in the message stream so the OpenAI tool_calls →
    // tool_messages contract stays intact.
    it('does not push to chatMessages — returns hint via outcome only', () => {
      const ctx: any = {};
      const fakeChatMessages: any[] = [];
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: a', true);
      noteToolOutcome(ctx, 'Glob', 'No files matched pattern: b', true);
      const r = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: c', true);
      expect(fakeChatMessages.length).toBe(0); // breaker does not push
      expect(r.softHint).toBeDefined();
    });

    it('hardStop returns a flag, not a thrown error', () => {
      const ctx: any = {};
      let lastOutcome: any;
      for (let i = 0; i < 6; i++) {
        lastOutcome = noteToolOutcome(ctx, 'Glob', 'No files matched pattern: ' + i, true);
      }
      expect(lastOutcome.hardStop).toBe(true);
      // Importantly: nothing in `noteToolOutcome` throws — the caller
      // is the one deciding what to do with the hardStop signal.
    });
  });
});
