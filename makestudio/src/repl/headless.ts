import { swallow } from '../utils/log';
/**
 * headless.ts — one-shot prompt mode.
 *
 * Runs a single user prompt, drains the tool loop until completion, prints
 * the final assistant text to stdout, and exits with a proper code:
 *   0 — completed normally (may still have warnings in stderr)
 *   1 — unauthenticated / missing config
 *   2 — prompt empty
 *   3 — blocking context limit / compact-impossible
 *   4 — tool circuit breaker tripped
 *   5 — provider error after retries
 *
 * Design:
 *   - No Ink, no TUI bridge — pure stdout/stderr.
 *   - PermissionMode defaults to `default` (same rules as REPL). Caller can
 *     pass --yes / --dangerously-skip-permissions to flip to `bypassPermissions`.
 *   - AskUserQuestion tool fails fast (no interactive TTY) — agent gets the
 *     error and should self-correct.
 *   - Runs the full chat loop via `handleAIChat` (non-streaming path —
 *     cleaner stdout; the streaming path targets the bridge).
 *   - Reuses ALL safety rails: permissions, hooks, classifier, path canonicalization.
 */

import { ReplContext } from './context';

export interface HeadlessSinkChunk {
  type: 'info' | 'error' | 'assistant' | 'log';
  text: string;
}

export interface HeadlessOptions {
  /** The prompt to run. Required. */
  prompt: string;
  /** Auto-approve all tool calls (equivalent to permissionMode='bypassPermissions').
   *  Defaults to false — safer. Agent respects deny rules in permissions.json. */
  yes?: boolean;
  /** Suppress noisy [INFO] messages — only print the final assistant text.
   *  Useful for piping the response into other commands. */
  quiet?: boolean;
  /** Output mode. 'text' emits plain assistant text; 'json' emits a single
   *  JSON object per message (stream-JSON, one per line). */
  format?: 'text' | 'json';
  /** Resume a prior session by id. When present, loads its messages before
   *  appending the new prompt — same semantic as `makestudio --resume X`. */
  resumeSessionId?: string;
  /** Continue the most recent session instead of starting fresh. */
  continueSession?: boolean;
  /** Cap the tool-loop iteration count. Set by DarkFactory executor when
   *  it dispatches `--cli makestudio --max-turns N` so a runaway task
   *  can't burn the budget. Unlimited when absent (internal MAX_TOOL_LOOPS=200). */
  maxTurns?: number;
  /** When set, every emit pushes through this sink instead of writing to
   *  stdout/stderr. Used by the Electron main to broadcast EVT_HEADLESS_OUTPUT
   *  events — keeps the CLI path unchanged when sink is omitted. */
  sink?: (chunk: HeadlessSinkChunk) => void;
  /** Pass-through abort signal so HEADLESS_STOP can interrupt mid-turn.
   *  Wired into `ctx.currentAbortController` once the chat loop creates one. */
  signal?: AbortSignal;
}

type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

function emit(line: string, format: 'text' | 'json', channel: NodeJS.WriteStream = process.stdout): void {
  channel.write(line);
  if (!line.endsWith('\n')) channel.write('\n');
}

function emitInfo(msg: string, opts: HeadlessOptions): void {
  if (opts.quiet) return;
  if (opts.sink) {
    opts.sink({ type: 'info', text: msg });
    return;
  }
  if (opts.format === 'json') {
    emit(JSON.stringify({ type: 'info', message: msg }), 'json', process.stderr);
  } else {
    process.stderr.write(`[info] ${msg}\n`);
  }
}

function emitError(msg: string, opts: HeadlessOptions): void {
  if (opts.sink) {
    opts.sink({ type: 'error', text: msg });
    return;
  }
  if (opts.format === 'json') {
    emit(JSON.stringify({ type: 'error', message: msg }), 'json', process.stderr);
  } else {
    process.stderr.write(`[error] ${msg}\n`);
  }
}

function emitAssistant(text: string, opts: HeadlessOptions): void {
  if (opts.sink) {
    opts.sink({ type: 'assistant', text });
    return;
  }
  if (opts.format === 'json') {
    emit(JSON.stringify({ type: 'assistant', text }), 'json', process.stdout);
  } else {
    // Plain mode: just the text, no decoration. User expects `command-subst`
    // pattern (`X=$(makestudio "summary of foo")`) to work.
    emit(text, 'text', process.stdout);
  }
}

/**
 * Run one prompt to completion and exit. Intended as the process's entry
 * when invoked as `makestudio "prompt"` or `makestudio -p "prompt"`.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<ExitCode> {
  const format = opts.format ?? 'text';
  const prompt = (opts.prompt || '').trim();
  if (!prompt) {
    emitError('Empty prompt. Usage: makestudio "<your request>" or makestudio -p "<your request>".', { ...opts, format });
    return 2;
  }

  // Pretend we're a REPL so dispatch_agent / permissions / etc. use the
  // right code paths. Everything reads ctx.cwd and ctx.activeProject.
  process.env.MAKESTUDIO_HEADLESS = '1';

  const ctx = new ReplContext();
  try {
    await ctx.initialize();
  } catch (err: any) {
    emitError(`Failed to initialize agent: ${err.message || err}`, { ...opts, format });
    return 1;
  }

  if (!ctx.isAuthenticated()) {
    emitError('Not authenticated. Run `makestudio login` first.', { ...opts, format });
    return 1;
  }

  // Resume / continue: prepend prior session messages so the new prompt
  // picks up the conversation. Same mechanism the TUI uses in tui-index.
  if (opts.continueSession || opts.resumeSessionId) {
    try {
      const { loadMostRecent, loadById, loadSessionMessages, bindSessionFile } =
        require('./sessions');
      const summary = opts.resumeSessionId
        ? loadById(ctx.cwd, opts.resumeSessionId)
        : loadMostRecent(ctx.cwd);
      if (summary) {
        const prior = loadSessionMessages(summary.file);
        ctx.messages.push(...prior);
        bindSessionFile(ctx, summary.file);
        emitInfo(`Resumed session ${summary.sessionId.slice(0, 8)} with ${prior.length} msg(s).`, { ...opts, format });
      }
    } catch (err: any) {
      emitInfo(`Could not resume session: ${err.message || err}`, { ...opts, format });
    }
  }

  // Optional yes/bypass — equivalent to Claude Code's
  // --dangerously-skip-permissions. The PREVIOUS implementation called
  // saveSettings({permissionMode:'bypassPermissions'}) which PERSISTED to
  // ~/.makestudio/settings.json and contaminated every later REPL session
  // (the user saw a red "[mode:bypassPermissions]" badge with no clue
  // why). We now scope the override to THIS subprocess only — env var +
  // ctx flag — and never touch the on-disk settings file.
  if (opts.yes) {
    process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE = 'bypassPermissions';
    (ctx as any).__runtimePermissionMode = 'bypassPermissions';
    ctx.autoApprove = true;
    emitInfo('permission-mode=bypassPermissions (--yes flag, runtime only)', { ...opts, format });
  }

  // When this subprocess is enriching/structuring a DUM (env vars set by
  // structure-pass / enrich-pass), the prompt is INSTRUCTIONS, not pasted
  // user content. The default attachment-extractor would externalize it
  // as `[Pasted #N]` and force the model to spend a tool call on
  // `read_attachment` BEFORE it can do anything. That extra round-trip
  // adds ~10s of LLM latency per DUM and confuses smaller models that
  // forget to call read_attachment first. Skipping extraction keeps the
  // instructions inline where the model sees them immediately.
  if (process.env.MAKESTUDIO_DECOMPOSITION_TEMPID) {
    (ctx as any).__skipAttachmentExtractionOnce = true;
  }

  // Install a stdout capture shim around console.log so the assistant's
  // final text + tool output doesn't intermix with info lines. The
  // non-streaming chat path already prints tool calls to console.log; in
  // headless we redirect those to stderr when quiet, leave them in stdout
  // otherwise (for transparency — user sees what the agent ran).
  const origLog = console.log;
  const capturedLogs: string[] = [];
  if (opts.sink) {
    // When a sink is wired (Electron path), all console.log gets routed
    // through it as type='log' regardless of format/quiet — caller decides
    // visibility on the renderer side.
    console.log = (...args: any[]) => {
      const text = args.map(String).join(' ');
      capturedLogs.push(text);
      try { opts.sink!({ type: 'log', text }); } catch (err) { swallow(err); }
    };
  } else if (format === 'json' || opts.quiet) {
    console.log = (...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '));
      if (format === 'json' && !opts.quiet) {
        emit(JSON.stringify({ type: 'log', message: args.map(String).join(' ') }), 'json', process.stderr);
      }
      // in quiet+text, swallow silently
    };
  }

  let exitCode: ExitCode = 0;
  try {
    const before = ctx.messages.length;
    // Propagate maxTurns to the tool loop — consulted by chat.ts when it
    // computes its effective cap per invocation.
    if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
      (ctx as any).__headlessMaxTurns = opts.maxTurns;
    }
    // External signal pass-through. handleAIChat installs its own
    // AbortController on ctx.currentAbortController; we link the outer
    // signal so abort() from HEADLESS_STOP propagates into the provider
    // stream/tool loop without racing the chat code that creates it.
    let signalUnlink: (() => void) | null = null;
    if (opts.signal) {
      const linkAbort = () => {
        const inner = (ctx as any).currentAbortController as AbortController | null;
        if (inner && !inner.signal.aborted) inner.abort('headless-stop');
      };
      if (opts.signal.aborted) {
        // If already aborted before chat even started, throw early so
        // handleAIChat sees a refused turn instead of half-running.
        throw new Error('aborted');
      }
      opts.signal.addEventListener('abort', linkAbort, { once: true });
      signalUnlink = () => opts.signal!.removeEventListener('abort', linkAbort);
    }
    // handleAIChat runs the full tool loop. Safer than streaming for
    // headless: deterministic output ordering, no partial-message gotchas.
    const { handleAIChat } = require('./ai/chat');
    try {
      await handleAIChat(prompt, ctx);
    } finally {
      signalUnlink?.();
    }
    // Grab the final assistant message (last in the array) + emit it.
    const finalMsg = ctx.messages[ctx.messages.length - 1];
    if (finalMsg?.role === 'assistant') {
      const content: any = finalMsg.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = (content as any[]).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      }
      if (text.trim()) emitAssistant(text.trim(), { ...opts, format });
      else emitError('Agent produced no final text.', { ...opts, format });
    } else {
      emitError('Agent did not return an assistant message (likely blocked by policy or circuit breaker).', { ...opts, format });
      exitCode = 4;
    }
    // If ctx gained zero messages, something refused early (not-authenticated,
    // blocking-limit hit etc.) — those paths print their own stderr, we just
    // propagate the exit.
    if (ctx.messages.length === before) exitCode = exitCode || 3;
  } catch (err: any) {
    emitError(`Run failed: ${err.message || err}`, { ...opts, format });
    exitCode = 5;
  } finally {
    console.log = origLog;
  }

  return exitCode;
}
