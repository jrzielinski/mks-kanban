import { bashImpl, stripEmptyLines, detectShellParseFailure } from './bash';
import { ReplContext } from '../../context';

type MockEvents = Record<string, (...args: any[]) => void>;
type MockProcess = {
  stdout: { on: jest.Mock; removeAllListeners?: jest.Mock };
  stderr: { on: jest.Mock; removeAllListeners?: jest.Mock };
  on: jest.Mock;
  kill: jest.Mock;
  pid: number;
  [key: string]: any;
};

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

function makeCtx(overrides: Partial<ReplContext> = {}): ReplContext {
  return {
    cwd: '/test',
    autoApprove: false,
    approvedTools: new Set<'Bash'>(),
    activeProject: undefined,
    ...overrides,
  } as any as ReplContext;
}

function fakeProcess(events?: MockEvents): MockProcess {
  const handlers: Record<string, (...args: any[]) => void> = { ...events };
  return {
    pid: 12345,
    stdout: {
      on: jest.fn((ev: string, fn: (...args: any[]) => void) => {
        if (ev === 'data') handlers['stdout-data'] = fn;
      }),
    },
    stderr: {
      on: jest.fn((ev: string, fn: (...args: any[]) => void) => {
        if (ev === 'data') handlers['stderr-data'] = fn;
      }),
    },
    on: jest.fn((ev: string, fn: (...args: any[]) => void) => {
      handlers[ev] = fn;
    }),
    kill: jest.fn(),
    trigger(ev: string, ...args: any[]) {
      handlers[ev]?.(...args);
    },
    emitData(stream: 'stdout' | 'stderr', data: string) {
      const h = stream === 'stdout' ? handlers['stdout-data'] : handlers['stderr-data'];
      h?.(Buffer.from(data));
    },
  };
}

describe('stripEmptyLines', () => {
  it('removes leading blank lines', () => {
    expect(stripEmptyLines('\n\n\nhello')).toBe('hello');
  });

  it('removes trailing blank lines', () => {
    expect(stripEmptyLines('hello\n\n\n')).toBe('hello');
  });

  it('removes both leading and trailing blank lines', () => {
    expect(stripEmptyLines('\n\nhello\nworld\n\n')).toBe('hello\nworld');
  });

  it('returns empty string for all-blank input', () => {
    expect(stripEmptyLines('   \n\n\n')).toBe('');
  });

  it('preserves internal whitespace-only lines', () => {
    expect(stripEmptyLines('a\n   \nb')).toBe('a\n   \nb');
  });

  it('returns empty string for empty input', () => {
    expect(stripEmptyLines('')).toBe('');
  });

  it('preserves single non-blank line', () => {
    expect(stripEmptyLines('hello')).toBe('hello');
  });

  it('preserves content when no blank lines', () => {
    expect(stripEmptyLines('a\nb\nc')).toBe('a\nb\nc');
  });
});

describe('bashImpl', () => {
  let proc: MockProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    const { spawn } = require('child_process');
    proc = fakeProcess();
    spawn.mockReturnValue(proc);
  });

  function triggerClose(code: number | null, signal: string | null = null) {
    proc.trigger('close', code, signal);
  }

  function emitStdout(data: string) {
    proc.emitData('stdout', data);
  }

  function emitStderr(data: string) {
    proc.emitData('stderr', data);
  }

  function emitError(err: Error) {
    proc.trigger('error', err);
  }

  it('throws when command is missing', async () => {
    await expect(() => bashImpl({}, makeCtx())).rejects.toThrow('Bash: command is required.');
  });

  it('throws when command is not a string', async () => {
    await expect(() => bashImpl({ command: 42 }, makeCtx())).rejects.toThrow('Bash: command is required.');
  });

  it('spawns bash with given command', async () => {
    const { spawn } = require('child_process');
    const prom = bashImpl({ command: 'echo hi' }, makeCtx());
    expect(spawn).toHaveBeenCalledWith('bash', ['-c', 'echo hi'], expect.any(Object));
    const opts = spawn.mock.calls[0][2];
    expect(opts.cwd).toBe('/test');
    expect(opts.detached).toBe(true);
    triggerClose(0);
    await prom;
  });

  it('uses input.cwd when provided', async () => {
    const { spawn } = require('child_process');
    const prom = bashImpl({ command: 'ls', cwd: '/custom' }, makeCtx());
    expect(spawn.mock.calls[0][2].cwd).toBe('/custom');
    triggerClose(0);
    await prom;
  });

  it('collects stdout and stderr and returns formatted output', async () => {
    const prom = bashImpl({ command: 'echo hi' }, makeCtx());
    emitStdout('hi\n');
    emitStderr('warning\n');
    triggerClose(0);
    const result = await prom;
    expect(result).toContain('exit: 0');
    expect(result).toContain('hi');
    expect(result).toContain('warning');
  });

  it('reports non-zero exit code', async () => {
    const prom = bashImpl({ command: 'false' }, makeCtx());
    triggerClose(1);
    const result = await prom;
    expect(result).toContain('exit: 1');
  });

  it('reports signal exit', async () => {
    const prom = bashImpl({ command: 'sleep 10' }, makeCtx());
    triggerClose(null, 'SIGTERM');
    const result = await prom;
    expect(result).toContain('signal');
    expect(result).toContain('SIGTERM');
  });

  it('truncates long output', async () => {
    const prom = bashImpl({ command: 'cat big' }, makeCtx());
    emitStdout('A'.repeat(60_000));
    triggerClose(0);
    const result = await prom;
    expect(result).toContain('truncated');
  });

  it('handles timeout', async () => {
    jest.useFakeTimers();
    const prom = bashImpl({ command: 'sleep', timeout: 1000 }, makeCtx());
    jest.advanceTimersByTime(1000);
    triggerClose(null, 'SIGKILL');
    const result = await prom;
    expect(result).toContain('timed out');
    jest.useRealTimers();
  });

  it('handles error event', async () => {
    const prom = bashImpl({ command: 'bad' }, makeCtx());
    emitError(new Error('spawn ENOENT'));
    const result = await prom;
    expect(result).toContain('ENOENT');
  });

  it('tracks bash failures in ctx', async () => {
    const ctx = makeCtx() as any;
    const prom = bashImpl({ command: 'false' }, ctx);
    triggerClose(1);
    await prom;
    expect(ctx.__turnBashFailures).toHaveLength(1);
    expect(ctx.__turnBashFailures[0].exitCode).toBe(1);
  });

  it('uses process.cwd() fallback when no ctx.cwd or input.cwd', async () => {
    const ctx = makeCtx({ cwd: undefined });
    const { spawn } = require('child_process');
    const prom = bashImpl({ command: 'pwd' }, ctx);
    expect(spawn.mock.calls[0][2].cwd).toBe(process.cwd());
    triggerClose(0);
    await prom;
  });
});

describe('detectShellParseFailure (fix #5)', () => {
  it('returns null when stderr is empty', () => {
    expect(detectShellParseFailure('echo hi', '')).toBeNull();
  });

  it('returns null when stderr has no parse-error markers', () => {
    expect(detectShellParseFailure('false', 'oops something failed')).toBeNull();
  });

  it('returns null on parse error from a SHORT command (probably user intent, not heredoc)', () => {
    // Short, no heredoc, no nested quotes — even if shell choked, we don't
    // suggest the temp-file pattern. Hint should fire only when the trigger
    // condition (heredoc / long / nested quotes) is also true.
    expect(detectShellParseFailure('echo "', 'unexpected EOF while looking for matching `"\'')).toBeNull();
  });

  it('emits hint when a here-doc command parses as unexpected EOF', () => {
    const cmd = `cat > /tmp/x.py << 'PYEOF'\nprint(1)\nPYEOF`;
    const stderr = 'bash: -c: line 5: unexpected EOF while looking for matching `\'\'';
    const out = detectShellParseFailure(cmd, stderr);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/Write tool/);
    expect(out!).toMatch(/\/tmp/);
  });

  it('emits hint when a long command (>300 chars) hits a parse error', () => {
    const cmd = 'echo ' + 'x'.repeat(400);
    const stderr = 'bash: -c: linha 1: unexpected EOF';
    expect(detectShellParseFailure(cmd, stderr)).not.toBeNull();
  });

  it('emits hint when nested quotes hit a parse error', () => {
    const cmd = `bash -c "cd /tmp && echo 'hi from nested'"`;
    const stderr = 'syntax error near unexpected token';
    expect(detectShellParseFailure(cmd, stderr)).not.toBeNull();
  });

  it('detects PT-BR locale parse-error message: "linha 1"', () => {
    const cmd = 'cat <<EOF\n' + 'x\n'.repeat(50) + 'EOF';
    expect(detectShellParseFailure(cmd, 'bash: -c: linha 5: erro de sintaxe')).not.toBeNull();
  });

  it('catches `unterminated quoted string`', () => {
    const cmd = 'echo ' + 'a'.repeat(400);
    expect(detectShellParseFailure(cmd, 'bash: unterminated quoted string')).not.toBeNull();
  });

  it('hint mentions Write tool + /tmp + bash invocation', () => {
    const cmd = 'cat <<EOF\n' + 'x'.repeat(400) + '\nEOF';
    const out = detectShellParseFailure(cmd, 'unexpected EOF');
    expect(out!).toMatch(/Write tool/);
    expect(out!).toMatch(/\/tmp/);
    expect(out!).toMatch(/bash\s+\/tmp/);
  });
});
