import { swallow } from '../../../utils/log';
/**
 * Advanced tool — bg-tasks topic. Extracted from advanced-tools.ts.
 */
/**
 * advanced-tools.ts
 *
 * Additional code-agent tools:
 *   - LSP (semantic code nav: definition, references, implementation, hover,
 *     workspaceSymbol, documentSymbol, callHierarchy)
 *   - TodoWrite (in-session task list managed by the LLM)
 *   - AskUserQuestion (LLM-driven multi-choice clarification with "Other")
 *   - BackgroundTask (TaskCreate/Output/Status/Stop/List — non-blocking shell)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { ReplContext } from '../../context';
import { ToolDefinition } from '../tools';
import {
  lspDefinition,
  lspDefinitionAt,
  lspReferences,
  lspReferencesAt,
  lspHover,
  lspDocumentSymbols,
  lspImplementation,
  lspWorkspaceSymbols,
  lspIncomingCalls,
  lspOutgoingCalls,
} from '../../lsp';
import {
  enterWorktreeForDum,
  exitWorktreeAndMerge,
  exitWorktreeAndDiscard,
  canEnterWorktree,
  WorktreeHandle,
} from '../../../core/worktree';

// ── Background Task tools ───────────────────────────────────────────────────

interface BgTask {
  id: string;
  command: string;
  description?: string;
  cwd: string;
  startedAt: number;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cursor: number;     // byte offset of last delivered stdout
  errCursor: number;  // byte offset of last delivered stderr
  pid: number;
}

const bgTasks: Map<string, BgTask> = new Map();
export const MAX_BG_TASKS = 20;
export const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5MB per stream

/**
 * Kill every background task. Called on REPL shutdown so an orphaned
 * child process doesn't keep the Node event loop alive past Ctrl+C.
 */
export function stopAllBackgroundTasks(): void {
  for (const [, t] of bgTasks) {
    try { t.proc.kill('SIGTERM'); } catch (err) { swallow(err); }
  }
  bgTasks.clear();
}

export const bgTaskToolDefinitions: ToolDefinition[] = [
  {
    name: 'TaskCreate',
    description: 'Launch a shell command as a non-blocking background task. Use for long-running commands (tests, builds, watchers). Returns a task_id; poll with TaskOutput.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        description: { type: 'string', description: 'Short description of what the task does.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to session cwd.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'TaskOutput',
    description: 'Return new stdout/stderr since last call (incremental). Poll repeatedly to follow a long task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID returned by TaskCreate.' },
        maxBytes: { type: 'number', description: 'Cap bytes returned per stream (default 20000).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'TaskStatus',
    description: 'Check a task without consuming its output buffer. Returns running state, exit code, duration.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'TaskStop',
    description: 'Stop a running background task (SIGTERM, then SIGKILL after 3s).',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'TaskList',
    description: 'List all background tasks in this session with their status and command.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

/**
 * Create a background task from within Bash's run_in_background path.
 * Exported so file-tools.ts can call it without circular imports.
 */
export function createBackgroundTask(command: string, cwd: string, description?: string): string {
  return taskCreateImpl({ command, cwd, description }, { cwd } as any);
}

export function taskCreateImpl(input: any, ctx: ReplContext): string {
  if (bgTasks.size >= MAX_BG_TASKS) {
    // Clean up finished ones first
    for (const [id, t] of bgTasks) {
      if (t.exitCode !== null) bgTasks.delete(id);
    }
  }
  if (bgTasks.size >= MAX_BG_TASKS) {
    throw new Error(`TaskCreate: too many background tasks (${MAX_BG_TASKS}). Stop or drain finished ones first.`);
  }

  const command: string = String(input.command || '').trim();
  if (!command) throw new Error('TaskCreate: command is required');
  const cwd: string = input.cwd || ctx.cwd || process.cwd();

  const id = crypto.randomUUID().slice(0, 8);
  const proc = spawn('bash', ['-c', command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const task: BgTask = {
    id,
    command,
    description: input.description,
    cwd,
    startedAt: Date.now(),
    proc,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    cursor: 0,
    errCursor: 0,
    pid: proc.pid || -1,
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    task.stdout += chunk.toString('utf8');
    if (task.stdout.length > MAX_BUFFER_BYTES) {
      const drop = task.stdout.length - MAX_BUFFER_BYTES;
      task.stdout = task.stdout.slice(drop);
      task.cursor = Math.max(0, task.cursor - drop);
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    task.stderr += chunk.toString('utf8');
    if (task.stderr.length > MAX_BUFFER_BYTES) {
      const drop = task.stderr.length - MAX_BUFFER_BYTES;
      task.stderr = task.stderr.slice(drop);
      task.errCursor = Math.max(0, task.errCursor - drop);
    }
  });
  proc.on('exit', (code, signal) => {
    task.exitCode = code ?? (signal ? -1 : 0);
    task.signal = signal;
  });
  proc.on('error', (err) => {
    task.stderr += `\n[spawn error] ${err.message}\n`;
    task.exitCode = -1;
  });

  bgTasks.set(id, task);
  return JSON.stringify({
    task_id: id,
    pid: task.pid,
    command: task.command,
    cwd: task.cwd,
    startedAt: new Date(task.startedAt).toISOString(),
  }, null, 2);
}

export function taskOutputImpl(input: any, _ctx: ReplContext): string {
  const id: string = input.task_id;
  const t = bgTasks.get(id);
  if (!t) throw new Error(`TaskOutput: unknown task_id ${id}`);
  const maxBytes = Math.min(500_000, Math.max(1_000, input.maxBytes ?? 20_000));

  const outDelta = t.stdout.slice(t.cursor);
  const errDelta = t.stderr.slice(t.errCursor);
  const outClipped = outDelta.length > maxBytes ? outDelta.slice(-maxBytes) : outDelta;
  const errClipped = errDelta.length > maxBytes ? errDelta.slice(-maxBytes) : errDelta;
  t.cursor = t.stdout.length;
  t.errCursor = t.stderr.length;

  return JSON.stringify({
    task_id: id,
    running: t.exitCode === null,
    exitCode: t.exitCode,
    signal: t.signal,
    durationMs: Date.now() - t.startedAt,
    stdout: outClipped,
    stderr: errClipped,
    stdoutTruncated: outDelta.length > maxBytes,
    stderrTruncated: errDelta.length > maxBytes,
  }, null, 2);
}

export function taskStatusImpl(input: any, _ctx: ReplContext): string {
  const t = bgTasks.get(input.task_id);
  if (!t) throw new Error(`TaskStatus: unknown task_id ${input.task_id}`);
  return JSON.stringify({
    task_id: t.id,
    command: t.command,
    description: t.description,
    running: t.exitCode === null,
    exitCode: t.exitCode,
    signal: t.signal,
    startedAt: new Date(t.startedAt).toISOString(),
    durationMs: Date.now() - t.startedAt,
    stdoutBytes: t.stdout.length,
    stderrBytes: t.stderr.length,
    unreadStdoutBytes: t.stdout.length - t.cursor,
    unreadStderrBytes: t.stderr.length - t.errCursor,
  }, null, 2);
}

export function taskStopImpl(input: any, _ctx: ReplContext): string {
  const t = bgTasks.get(input.task_id);
  if (!t) throw new Error(`TaskStop: unknown task_id ${input.task_id}`);
  if (t.exitCode !== null) return JSON.stringify({ task_id: t.id, alreadyFinished: true, exitCode: t.exitCode });
  try { t.proc.kill('SIGTERM'); } catch (err) { swallow(err); }
  const killTimer = setTimeout(() => { try { t.proc.kill('SIGKILL'); } catch (err) { swallow(err); } }, 3_000);
  killTimer.unref();
  return JSON.stringify({ task_id: t.id, signalSent: 'SIGTERM' });
}

export function taskListImpl(_input: any, _ctx: ReplContext): string {
  const all = Array.from(bgTasks.values()).map(t => ({
    task_id: t.id,
    running: t.exitCode === null,
    exitCode: t.exitCode,
    command: t.command.slice(0, 80),
    durationMs: Date.now() - t.startedAt,
  }));
  return JSON.stringify({ count: all.length, tasks: all }, null, 2);
}

