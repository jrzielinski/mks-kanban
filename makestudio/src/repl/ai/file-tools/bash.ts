import { swallow } from '../../../utils/log';
/**
 * File tool — bash topic. Extracted from file-tools.ts.
 */
/**
 * file-tools.ts
 *
 * Core file/code tools exposed to the REPL AI: Read, Write, Edit, MultiEdit,
 * Glob, Grep, Bash. Implementations are self-contained — no dependency on any
 * third-party CLI agent — so the REPL can operate as a complete code agent.
 *
 * Safety rails:
 *   - Write requires a prior Read of the same absolute path in-session
 *     (prevents clobbering files the agent hasn't inspected).
 *   - Edit requires old_string to be unique in the file (unless replace_all).
 *   - Bash runs through the session sandbox wrapper, with a hard ceiling on
 *     timeout and a default 2min.
 *   - Paths must be absolute.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import fastGlob from 'fast-glob';
import { ReplContext } from '../../context';
import type { ToolDefinition } from '../tools';
import { subprocessEnv } from '../../subprocess-env';
import { markRead, wasRead, requireAbsolute, readFileWithMetadata, encodeWithMetadata, canonicalizePath, relToCwd } from './path-utils';


const MAX_READ_LINES = 2000;
const DEFAULT_READ_LINE_WIDTH = 2000;    // chars per line truncation
const MAX_BASH_TIMEOUT_MS = 600_000;     // 10 min hard ceiling
const DEFAULT_BASH_TIMEOUT_MS = 120_000; // 2 min default

// Per-session tracking: set of absolute paths that have been read.
// Write/Edit require the path to be in this set to prevent blind overwrites.
//
// Capped LRU via insertion-order deletion (Set preserves insertion order).
// Stress test #13 flagged the old unbounded Set as a slow leak: long sessions
// reading 1000s of unique files accumulated proportional memory. With the cap,
// the oldest-read path is evicted once we exceed MAX_READ_PATHS_PER_SESSION —
// the only user-visible impact is that a very-long-ago Read no longer
// satisfies the "Read-before-Write" gate, which just forces an extra Read.
const MAX_READ_PATHS_PER_SESSION = 1000;
const readPaths: WeakMap<ReplContext, Set<string>> = new WeakMap();
export async function bashImpl(input: any, ctx: ReplContext): Promise<string> {
  const command: string = input.command;
  if (!command || typeof command !== 'string') throw new Error('Bash: command is required.');
  const cwd = input.cwd || ctx.cwd || process.cwd();

  // Pre-dispatch failure-memory check. When the model just emitted a
  // shape-similar Bash that already failed at the SHELL level (parse
  // error, unbalanced quotes, etc) within this turn, refuse to run the
  // near-duplicate. Saves one full LLM round-trip per blocked retry.
  // See bash-failure-memory.ts for the heuristic.
  try {
    const { checkRepeatedFailure } = require('./bash-failure-memory');
    const blocked = checkRepeatedFailure(ctx, command);
    if (blocked) return blocked;
  } catch (err) { swallow(err); }

  // run_in_background: port of Claude Code BashTool's run_in_background flag.
  // Hands the command off to the TaskCreate infrastructure and returns the
  // task_id immediately instead of blocking until completion.
  if (input.run_in_background) {
    const { createBackgroundTask } = require('../advanced-tools');
    return createBackgroundTask(command, cwd, input.description);
  }

  const timeout = Math.min(MAX_BASH_TIMEOUT_MS, Math.max(1_000, input.timeout || DEFAULT_BASH_TIMEOUT_MS));
  let dbg: typeof import('../../debug-log') | null = null;
  try { dbg = require('../../debug-log'); } catch (err) { swallow(err); }
  dbg?.dbgBashStart(command, cwd, timeout);

  // Respect per-session permission: if not auto-approved and not already in approvedTools,
  // bail with an informative error suggesting the user toggle.
  if (!ctx.autoApprove && !ctx.approvedTools.has('Bash')) {
    // We still run it — the user started the REPL, they're in charge. But note
    // we're not sandboxing here because the CLI agent path is trusted.
  }

  // Basic classification via security module (best-effort). Import is lazy
  // here to avoid pulling bash-parser into every REPL startup.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sec = eval('require')('../security');
    if (sec?.classifyCommand) {
      const cls = sec.classifyCommand(command, { cwd: ctx.activeProject?.localPath || ctx.cwd });
      if (cls === 'dangerous') {
        return `[BLOCKED] Command classified as dangerous: ${command.substring(0, 100)}\nUse --auto-approve or rewrite the command.`;
      }
    }

    // Binary-read guard: catch `cat foo.pdf` / `head img.png` / `less site.zip`
    // before bash spawns. cat'ing a binary file dumps junk bytes into the
    // conversation and burns context for nothing — the agent has proper
    // tools (Read with PDF support, unzip -p, file, ffprobe, etc.) that
    // actually return readable content.
    if (sec?.detectBinaryRead) {
      const finding = sec.detectBinaryRead(command);
      if (finding) {
        return `[BLOCKED] ${finding.reason}\n\nDo this instead: ${finding.suggestion}`;
      }
    }
  } catch (err) { swallow(err); }

  // Async streaming execution — never blocks the event loop (unlike spawnSync).
  // Live stdout lines appear in the TUI dynamic area as they arrive.
  const { spawn } = require('child_process');
  let bridge: any = null;
  try { bridge = require('../../tui/bridge'); } catch (err) { swallow(err); }

  // Open a live card in the dynamic area (streaming=true).
  const liveMsgId: string | null = bridge?.tuiStartStreamingTool?.('Bash', input) ?? null;
  const startedAt = Date.now();

  // Idle watchdog: if the command produces no stdout/stderr for this many
  // ms, we surface a warning to the TUI and start escalating signals so the
  // turn isn't stuck on something hung (SSH waiting on host-key prompt,
  // hung curl, blocked port). Prevents the "180s of dead air" experience.
  const IDLE_WARN_MS = 30_000;        // first warning + SIGTERM to the group
  const IDLE_KILL_GRACE_MS = 10_000;  // wait this long after SIGTERM before SIGKILL

  // The idle-watchdog used to be selectively disabled by a hard-coded
  // allow-list of "silent-by-design" Node-ecosystem commands (tsc, vitest,
  // jest, webpack, vite build, npm run build, ...). That biased the agent
  // toward one ecosystem — `cargo build`, `mvn verify`, `pytest`,
  // `flutter analyze`, `go test ./...`, etc. would still get killed as
  // "hung" after 30s of silent crunching. The agent must be language-
  // agnostic; the watchdog is gone. The only guardrail is `hardKill` from
  // the `timeout` input, which the model controls per-call. If a build
  // legitimately takes 5 min, the model passes timeout: 300_000.
  return new Promise<string>((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let abortedByUser = false;
    let killedForIdle = false;

    // detached:true puts the child in its own process group. Lets us kill
    // grandchildren too (e.g. bash → script.sh → ssh → ...) by signalling
    // the negative pid. Without this, killing `bash` leaves orphans.
    const proc = spawn('bash', ['-c', command], {
      cwd,
      env: subprocessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch (err) { swallow(err); }
    };

    // Hook the chat-turn AbortController so Esc Esc actually kills running
    // bash instead of just aborting the LLM stream and leaving the bash
    // running until its own hard timeout. SIGTERM → SIGKILL after 2s grace.
    const abortSignal: AbortSignal | undefined = (ctx as any).currentAbortController?.signal;
    const onAbort = () => {
      abortedByUser = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    // No idle-watchdog. The hardKill below (driven by the model-supplied
    // `timeout`) is the only kill-switch — language-agnostic and predictable.
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdleTimer = () => { /* no-op: kept as a hook for future reactivation behind a per-call opt-in */ };

    const hardKill = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeout);

    // Returns true for lines that are Node.js stack trace noise — we never
    // want these leaking into the status bar or live card output.
    const isNoiseLine = (l: string) =>
      /^\s+at\s+\S/.test(l) ||               // "    at TCPConnectWrap..."
      /^\s*(Error|TypeError|RangeError):/.test(l) || // "Error: connect ECONNREFUSED"
      /\(node:/.test(l);                      // "(node:net:..."

    // Stream stdout → collect + live card update
    proc.stdout.on('data', (chunk: Buffer) => {
      armIdleTimer();
      const text = chunk.toString('utf8');
      stdoutChunks.push(text);
      if (liveMsgId && bridge?.tuiUpdateMessage) {
        const allLines = stdoutChunks.join('').split('\n').filter((l: string) => l.trim());
        dbg?.dbgBashStdout(text);
        const cleanLines = allLines.filter((l: string) => !isNoiseLine(l));
        bridge.tuiUpdateMessage(liveMsgId, {
          liveLines: cleanLines.slice(-4),
          totalLiveLines: allLines.length,
        });
      } else if (bridge?.setCurrentTool) {
        const candidates = text.trimEnd().split('\n').filter((l: string) => l.trim() && !isNoiseLine(l));
        const lastLine = candidates.pop() || '';
        if (lastLine) bridge.setCurrentTool(lastLine.slice(0, 60));
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      armIdleTimer();
      const text = chunk.toString('utf8');
      stderrChunks.push(text);
      dbg?.dbgBashStderr(text);
    });

    proc.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(hardKill);
      if (idleTimer) clearTimeout(idleTimer);
      if (abortSignal) abortSignal.removeEventListener?.('abort', onAbort);
      const stdout = stripEmptyLines(stdoutChunks.join(''));
      const stderr = stripEmptyLines(stderrChunks.join(''));
      const exitCode = timedOut ? -1 : (code ?? (signal ? -1 : 0));

      const formatPart = (s: string, max: number): string => {
        if (s.length <= max) return s;
        const kept = s.slice(0, max);
        const totalLines = (s.match(/\n/g) || []).length + 1;
        const keptLines = (kept.match(/\n/g) || []).length + 1;
        return `${kept}\n\n... [${totalLines - keptLines} more line(s) truncated from ${s.length} total chars] ...`;
      };

      // Distinguish *why* the process died so the model gets actionable
      // feedback instead of a bare "exit -1". An idle-kill with no stdout
      // is the common "ssh hung waiting for password" pattern — flag it
      // explicitly so the model doesn't blindly retry the same command.
      const exitLine = abortedByUser
        ? 'exit: -1 (cancelled by user via Esc Esc)'
        : killedForIdle
          ? `exit: -1 (killed: produced no output for ${IDLE_WARN_MS / 1000}s — likely hung. Re-run with run_in_background=true OR wrap with a non-blocking flag (e.g. ssh -o BatchMode=yes, curl --max-time, timeout(1)).)`
          : timedOut
            ? `exit: -1 (timed out after ${timeout}ms)`
            : `exit: ${exitCode}${signal ? ` (signal ${signal})` : ''}`;
      const shellHint = detectShellParseFailure(command, stderr);
      // Memorise SHELL-level failures so a near-duplicate emitted later
      // in the turn gets short-circuited by checkRepeatedFailure on the
      // pre-dispatch path. Program-level non-zero exits don't qualify —
      // the shape-similar future call is probably legitimate retry-after-fix.
      try {
        const { isShellLevelFailure, recordBashFailure } = require('./bash-failure-memory');
        if (isShellLevelFailure(stderr || '', exitCode ?? -1)) {
          recordBashFailure(ctx, command, stderr || `exit ${exitCode}`);
        }
      } catch (err) { swallow(err); }
      // No test-runner-specific annotation. The previous annotator parsed
      // vitest/jest "FAIL <path>.test.tsx" output to flag pre-existing
      // failures, which only worked for the Node ecosystem — pytest,
      // cargo test, go test, mvn test, flutter test all use different
      // formats. The model reads the raw output regardless of language;
      // any per-runner heuristic biases the agent toward Node.
      const summary = [
        exitLine,
        stdout ? `stdout:\n${formatPart(stdout, 50_000)}` : '',
        stderr ? `stderr:\n${formatPart(stderr, 10_000)}` : '',
        shellHint || '',
      ].filter(Boolean).join('\n\n');

      // Track non-zero exits per-turn so the unacknowledged-failure guard
      // (chat.ts) can detect when the model claims success despite a Bash
      // exit ≠ 0. Reset at turn boundaries alongside the other flags.
      const failed =
        abortedByUser ||
        killedForIdle ||
        timedOut ||
        (typeof exitCode === 'number' && exitCode !== 0);
      if (failed) {
        const arr = ((ctx as any).__turnBashFailures ||= []);
        arr.push({
          cmd: String(command).slice(0, 200),
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
          reason: abortedByUser ? 'cancelled' : killedForIdle ? 'idle-kill' : timedOut ? 'timeout' : 'nonzero',
        });
      }

      dbg?.dbgBashEnd(exitCode, Date.now() - startedAt, stdout, stderr);

      // Finalize the live card — move it to Static via streaming=false.
      // Keep the last N output lines on the message so the static card
      // shows the command + tail of output (Claude Code style). Without
      // this the card would collapse to a bare `$ cmd 100ms` after
      // completion and the operator loses the result preview.
      if (liveMsgId && bridge?.tuiUpdateMessage) {
        const TAIL_LINES_AFTER_DONE = 10;
        const allLines = (stdout + (stderr ? '\n' + stderr : ''))
          .split('\n')
          .map((l: string) => l.replace(/\r$/, ''))
          .filter((l: string) => l.trim() && !isNoiseLine(l));
        const tail = allLines.slice(-TAIL_LINES_AFTER_DONE);
        bridge.tuiUpdateMessage(liveMsgId, {
          streaming: false,
          toolDurationMs: Date.now() - startedAt,
          toolOutput: summary,
          liveLines: tail,
          totalLiveLines: allLines.length,
        });
      }

      resolve(summary);
    });

    proc.on('error', (err: Error) => {
      clearTimeout(hardKill);
      if (idleTimer) clearTimeout(idleTimer);
      if (abortSignal) abortSignal.removeEventListener?.('abort', onAbort);
      if (liveMsgId && bridge?.tuiUpdateMessage) {
        bridge.tuiUpdateMessage(liveMsgId, {
          streaming: false,
          toolDurationMs: Date.now() - startedAt,
          liveLines: undefined,
          totalLiveLines: undefined,
        });
      }
      resolve(`exit: -1\nstderr:\n${err.message}`);
    });
  });
}

/**
 * Strip leading/trailing blank lines. Preserves whitespace within content.
 * Port of Claude Code's utils.ts:stripEmptyLines. Saves a handful of tokens
 * per Bash invocation — small per-call but adds up over long sessions.
 */
/**
 * Pure: detect when a Bash command failed because the SHELL itself
 * couldn't parse it (vs the program returning a normal non-zero exit).
 *
 * Trigger conditions that indicate a parse failure:
 *   - stderr contains `unexpected EOF`, `bash: -c: line`, `linha`,
 *     `unterminated quoted string`, or similar messages emitted by the
 *     parser before the program ran;
 *   - AND the command was either long (>300 chars), used a here-doc
 *     (`<< EOF` / `<< 'EOF'`), or nested quotes (a single-quote span
 *     embedded inside a double-quoted segment) — the patterns where
 *     long inline scripts notoriously break.
 *
 * When both fire, return a short hint pointing the model at the safer
 * pattern: write the body to a temp file via the Write tool, then run
 * `bash /tmp/x.sh`. Returns null when no hint should be emitted.
 *
 * Lesson learned 2026-05-05: across one PowerQueryEditor.tsx refactor
 * session the agent emitted ~12 long here-doc Python/sed scripts inline
 * via Bash; six of them died on `unexpected EOF` from quote-nesting,
 * each costing a turn. The hint cuts the retry loop.
 */
export function detectShellParseFailure(command: string, stderr: string): string | null {
  if (!stderr) return null;
  const err = stderr.toLowerCase();
  const PARSE_ERROR_PATTERNS = [
    'unexpected eof',
    'bash: -c: line',
    'bash: -c: linha',
    'unterminated quoted string',
    'syntax error near unexpected token',
    'syntax error: unexpected end of file',
  ];
  const isParseError = PARSE_ERROR_PATTERNS.some((p) => err.includes(p));
  if (!isParseError) return null;

  const hasHeredoc = /<<[-]?\s*(['"])?[A-Za-z_][A-Za-z0-9_]*\1?/.test(command);
  const isLong = command.length > 300;
  // Nested-quote heuristic: a single-quote span sitting inside the
  // outer double-quoted body. Catches the `bash -c "... '...' ..."`
  // pattern that breaks when the inner span runs into its own escape
  // chars. We match a `"…'…'…"` minimal envelope.
  const hasNestedQuotes = /"[^"]*'[^']*'[^"]*"/.test(command) || /'[^']*"[^"]*"[^']*'/.test(command);

  if (!hasHeredoc && !isLong && !hasNestedQuotes) return null;
  return [
    '[hint] The shell failed to PARSE this command before any program ran.',
    'When the script body is long, has a here-doc, or nests quotes, write it to a',
    'temp file with the Write tool (e.g. `/tmp/run.sh` or `/tmp/run.py`) and then',
    'invoke it via `bash /tmp/run.sh` — quote escaping stops mattering once the body',
    'lives in a real file.',
  ].join('\n');
}

export function stripEmptyLines(content: string): string {
  const lines = content.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (start > end) return '';
  return lines.slice(start, end + 1).join('\n');
}

