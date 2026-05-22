/**
 * Smoke test: /efficiency runs without throwing on a representative
 * ctx (in-memory toolCallHistory + usage), and produces output that
 * mentions all the headline labels we promise.
 */

import { EFFICIENCY_SLASH_COMMANDS } from './efficiency';

function makeCtx(history: any[], usage: any = {}): any {
  return {
    toolCallHistory: history,
    usage,
    cwd: '/tmp',
  };
}

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); };
  return { logs, restore: () => { console.log = orig; } };
}

describe('/efficiency', () => {
  const handler = EFFICIENCY_SLASH_COMMANDS[0].handler;
  const sc: any = (ctx: any) => ({ ctx, rest: [], cmd: '/efficiency', command: '/efficiency', argsStr: '', trimmed: '/efficiency', input: '/efficiency', rl: null });

  it('runs on an empty ctx without throwing', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([]);
      expect(() => handler(sc(ctx))).not.toThrow();
      const out = cap.logs.join('\n');
      expect(out).toContain('Total commands:');
      expect(out).toContain('Input tokens:');
      expect(out).toContain('Output tokens:');
      expect(out).toContain('Tokens saved:');
      expect(out).toContain('Total exec time:');
      expect(out).toContain('Efficiency meter:');
    } finally { cap.restore(); }
  });

  it('aggregates by tool and shows the table', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([
        { name: 'Read',  output: 'a'.repeat(800), durationMs: 4,  ok: true },
        { name: 'Read',  output: 'b'.repeat(800), durationMs: 5,  ok: true },
        { name: 'Glob',  output: '/x/y/z.ts',    durationMs: 12, ok: true },
        { name: 'Grep',  output: '',              durationMs: 8,  ok: false },
      ], { promptTokens: 50_000, completionTokens: 1_200, cacheReads: 30_000 });

      handler(sc(ctx));
      const out = cap.logs.join('\n');
      expect(out).toContain('By Command');
      expect(out).toContain('Read');
      expect(out).toContain('Glob');
      expect(out).toContain('Grep');
      // Total commands = 4
      expect(out).toMatch(/Total commands:\s*4/);
    } finally { cap.restore(); }
  });

  it('shows cache savings when cacheReads > 0', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([
        { name: 'Read', output: 'x', durationMs: 1, ok: true },
      ], { promptTokens: 100_000, completionTokens: 5_000, cacheReads: 80_000 });

      handler(sc(ctx));
      const out = cap.logs.join('\n');
      // 80k cache × 0.9 = 72k saved
      expect(out).toMatch(/Tokens saved:\s*\S*72/);
    } finally { cap.restore(); }
  });

  it('formats large token counts as M/K', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([], {
        promptTokens: 4_400_000,
        completionTokens: 1_600_000,
        cacheReads: 3_100_000,
      });
      handler(sc(ctx));
      const out = cap.logs.join('\n');
      expect(out).toMatch(/4\.4M|4\.4 M/);
      expect(out).toMatch(/1\.6M|1\.6 M/);
    } finally { cap.restore(); }
  });

  it('formats execution time with minutes when > 60s', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([
        { name: 'Bash', output: '', durationMs: 74_000, ok: true },
      ], {});
      handler(sc(ctx));
      const out = cap.logs.join('\n');
      expect(out).toMatch(/1m1[0-9]s/);
    } finally { cap.restore(); }
  });

  it('does not crash on history entries with missing/undefined name', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([
        { name: undefined as any, output: 'x', durationMs: 5, ok: true },
        { name: '', output: 'y', durationMs: 7, ok: true },
        null as any,
        { name: 'Read', output: 'ok', durationMs: 3, ok: true },
      ], { promptTokens: 1000, completionTokens: 100, cacheReads: 500 });
      expect(() => handler(sc(ctx))).not.toThrow();
      const out = cap.logs.join('\n');
      expect(out).toContain('Total commands:');
      expect(out).toContain('unknown');
      expect(out).toContain('Read');
    } finally { cap.restore(); }
  });

  it('marks failures in red (column visible)', () => {
    const cap = captureConsole();
    try {
      const ctx = makeCtx([
        { name: 'Grep', output: '', durationMs: 1, ok: false },
        { name: 'Grep', output: '', durationMs: 1, ok: false },
      ], {});
      handler(sc(ctx));
      const out = cap.logs.join('\n');
      expect(out).toContain('Grep');
    } finally { cap.restore(); }
  });
});
