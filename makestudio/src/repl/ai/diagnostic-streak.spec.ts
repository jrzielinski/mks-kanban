import {
  classifyTool,
  noteToolForStreak,
  resetDiagnosticStreak,
  resetDiagnosticStreakCache,
} from './diagnostic-streak';

describe('diagnostic-streak', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_DIAG_STREAK;
    resetDiagnosticStreakCache();
  });

  describe('classifyTool', () => {
    it('classifies Read/Grep/Glob as diagnostic', () => {
      expect(classifyTool('Read', { file_path: '/x' })).toBe('diagnostic');
      expect(classifyTool('Grep', { pattern: 'foo' })).toBe('diagnostic');
      expect(classifyTool('Glob', { pattern: '*.ts' })).toBe('diagnostic');
    });

    it('classifies Edit/Write/MultiEdit as progress', () => {
      expect(classifyTool('Edit', { file_path: '/x', old_string: 'a', new_string: 'b' })).toBe('progress');
      expect(classifyTool('Write', { file_path: '/x', content: 'x' })).toBe('progress');
      expect(classifyTool('MultiEdit', { file_path: '/x', edits: [] })).toBe('progress');
    });

    it('classifies Bash by command shape', () => {
      // Search/inspect = diagnostic
      expect(classifyTool('Bash', { command: 'grep -r foo .' })).toBe('diagnostic');
      expect(classifyTool('Bash', { command: 'find . -name "*.ts"' })).toBe('diagnostic');
      expect(classifyTool('Bash', { command: 'ls -la /x' })).toBe('diagnostic');
      expect(classifyTool('Bash', { command: 'git log --oneline' })).toBe('diagnostic');
      expect(classifyTool('Bash', { command: 'git diff HEAD' })).toBe('diagnostic');

      // Build/install/commit = progress
      expect(classifyTool('Bash', { command: 'npm run build' })).toBe('progress');
      expect(classifyTool('Bash', { command: 'npx tsc --noEmit' })).toBe('progress');
      expect(classifyTool('Bash', { command: 'git commit -m "wip"' })).toBe('progress');
      expect(classifyTool('Bash', { command: 'git push origin main' })).toBe('progress');
      expect(classifyTool('Bash', { command: 'mkdir foo' })).toBe('progress');

      // Empty / unrecognised = neutral
      expect(classifyTool('Bash', { command: '' })).toBe('neutral');
      expect(classifyTool('Bash', { command: 'echo "hi"' })).toBe('neutral');
    });

    it('classifies TodoWrite / dispatch_agent as neutral', () => {
      expect(classifyTool('TodoWrite', {})).toBe('neutral');
      expect(classifyTool('dispatch_agent', {})).toBe('neutral');
      expect(classifyTool('AskUserQuestion', {})).toBe('neutral');
    });
  });

  describe('noteToolForStreak — disabled', () => {
    it('returns 0 streak when env disables it', () => {
      process.env.MAKESTUDIO_DIAG_STREAK = 'off';
      resetDiagnosticStreakCache();
      const ctx: any = {};
      for (let i = 0; i < 8; i++) {
        const r = noteToolForStreak(ctx, 'Read', { file_path: `/f${i}` });
        expect(r.streak).toBe(0);
        expect(r.softHint).toBeUndefined();
      }
    });
  });

  describe('noteToolForStreak — enabled', () => {
    it('counts consecutive diagnostic tools', () => {
      const ctx: any = {};
      const a = noteToolForStreak(ctx, 'Read', { file_path: '/a' });
      const b = noteToolForStreak(ctx, 'Grep', { pattern: 'x' });
      const c = noteToolForStreak(ctx, 'Glob', { pattern: '*.ts' });
      expect(a.streak).toBe(1);
      expect(b.streak).toBe(2);
      expect(c.streak).toBe(3);
    });

    it('emits soft hint at threshold=5', () => {
      const ctx: any = {};
      for (let i = 0; i < 4; i++) {
        const r = noteToolForStreak(ctx, 'Grep', { pattern: 'x' + i });
        expect(r.softHint).toBeUndefined();
      }
      const r5 = noteToolForStreak(ctx, 'Grep', { pattern: 'last' });
      expect(r5.streak).toBe(5);
      expect(r5.softHint).toBeDefined();
      expect(r5.softHint).toContain('5 consecutive');
      expect(r5.softHint).toContain('progress tool');
    });

    it('emits the soft hint exactly once per turn', () => {
      const ctx: any = {};
      for (let i = 0; i < 5; i++) noteToolForStreak(ctx, 'Read', { file_path: `/f${i}` });
      const sixth = noteToolForStreak(ctx, 'Read', { file_path: '/sixth' });
      expect(sixth.streak).toBe(6);
      expect(sixth.softHint).toBeUndefined(); // already fired this turn
    });

    it('progress tool resets the streak AND clears the fired flag', () => {
      const ctx: any = {};
      for (let i = 0; i < 5; i++) noteToolForStreak(ctx, 'Grep', { pattern: 'x' + i });
      const edit = noteToolForStreak(ctx, 'Edit', {
        file_path: '/f.ts', old_string: 'a', new_string: 'b',
      });
      expect(edit.streak).toBe(0);

      // Now fresh streak should fire again
      for (let i = 0; i < 4; i++) noteToolForStreak(ctx, 'Read', { file_path: `/n${i}` });
      const fifth = noteToolForStreak(ctx, 'Read', { file_path: '/fifth' });
      expect(fifth.streak).toBe(5);
      expect(fifth.softHint).toBeDefined();
    });

    it('neutral tools do not increment OR reset the counter', () => {
      const ctx: any = {};
      noteToolForStreak(ctx, 'Read', { file_path: '/a' });
      noteToolForStreak(ctx, 'Read', { file_path: '/b' });
      // TodoWrite is neutral — streak stays at 2
      const t = noteToolForStreak(ctx, 'TodoWrite', { todos: [] });
      expect(t.streak).toBe(2);
      // dispatch_agent neutral too
      const d = noteToolForStreak(ctx, 'dispatch_agent', { task: 'x' });
      expect(d.streak).toBe(2);
      // Another diagnostic continues from 2
      const r = noteToolForStreak(ctx, 'Grep', { pattern: 'y' });
      expect(r.streak).toBe(3);
    });

    it('Bash classified by command shape', () => {
      const ctx: any = {};
      noteToolForStreak(ctx, 'Bash', { command: 'grep foo bar.ts' });
      noteToolForStreak(ctx, 'Bash', { command: 'find . -name x' });
      noteToolForStreak(ctx, 'Bash', { command: 'git log -10' });
      // 3 diagnostic Bashes → streak=3
      // npm run build is progress → reset
      const r = noteToolForStreak(ctx, 'Bash', { command: 'npm run build' });
      expect(r.streak).toBe(0);
    });
  });

  describe('resetDiagnosticStreak', () => {
    it('clears counter + fired flag', () => {
      process.env.MAKESTUDIO_DIAG_STREAK = '1';
      resetDiagnosticStreakCache();
      const ctx: any = {};
      for (let i = 0; i < 5; i++) noteToolForStreak(ctx, 'Read', { file_path: `/f${i}` });
      resetDiagnosticStreak(ctx);
      // Fresh slate — no hint until 5 again
      for (let i = 0; i < 4; i++) noteToolForStreak(ctx, 'Read', { file_path: `/n${i}` });
      const fifth = noteToolForStreak(ctx, 'Read', { file_path: '/fifth' });
      expect(fifth.streak).toBe(5);
      expect(fifth.softHint).toBeDefined();
    });
  });

  describe('turn-total accumulator (alternation evasion)', () => {
    // Pattern: model does Read×4 → trivial Edit (resets streak) → Read×4 →
    // trivial Edit → ... The streak counter never reaches SOFT_THRESHOLD,
    // but the user is paying for 15+ diagnostics in one turn. The
    // turn-total accumulator catches that.

    it('fires turn-total hint at 15 diagnostics even with progress resets', () => {
      const ctx: any = {};
      let lastSoftHint: string | undefined;

      // 4 Reads + 1 Edit (reset streak) — repeated 4 times = 16 reads + 4 edits
      for (let cycle = 0; cycle < 4; cycle++) {
        for (let i = 0; i < 4; i++) {
          const r = noteToolForStreak(ctx, 'Read', { file_path: `/c${cycle}-r${i}` });
          if (r.softHint) lastSoftHint = r.softHint;
        }
        const e = noteToolForStreak(ctx, 'Edit', {
          file_path: `/c${cycle}.ts`, old_string: 'a', new_string: 'b',
        });
        if (e.softHint) lastSoftHint = e.softHint;
      }

      expect(lastSoftHint).toBeDefined();
      expect(lastSoftHint).toContain('diagnostic tool calls in this turn');
      expect(lastSoftHint).toMatch(/1[5-9] diagnostic|[2-9]\d diagnostic/); // ≥15
    });

    it('turn-total fires at most once per turn', () => {
      const ctx: any = {};
      let hintCount = 0;
      // Hammer 30 reads with periodic edits — should fire turn-hint once
      for (let i = 0; i < 30; i++) {
        const r = noteToolForStreak(ctx, 'Read', { file_path: `/${i}` });
        if (r.softHint && r.softHint.includes('diagnostic tool calls in this turn')) {
          hintCount++;
        }
        if (i % 4 === 3) {
          noteToolForStreak(ctx, 'Edit', { file_path: '/x', old_string: 'a', new_string: 'b' });
        }
      }
      expect(hintCount).toBe(1);
    });

    it('turn-total resets via resetDiagnosticStreak', () => {
      const ctx: any = {};
      for (let i = 0; i < 14; i++) noteToolForStreak(ctx, 'Read', { file_path: `/${i}` });
      resetDiagnosticStreak(ctx);
      // Fresh: no hint until another 15
      const fresh = noteToolForStreak(ctx, 'Read', { file_path: '/x' });
      expect(fresh.softHint).toBeUndefined();
    });
  });
});
