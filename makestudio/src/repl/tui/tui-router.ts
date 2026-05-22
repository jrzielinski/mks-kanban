import { swallow } from '../../utils/log';
/**
 * TUI-aware router — routes all slash commands output through the Ink bridge
 * (adds messages to React state) instead of directly writing to stdout.
 *
 * Uses synchronous console.log interception — each line becomes an
 * 'info' message immediately, preserving ordering.
 */

import { ReplContext } from '../context';
import { getTuiBridge } from './bridge';
import { routeInput } from '../router';

let originalConsoleLog: typeof console.log | null = null;
let originalConsoleError: typeof console.error | null = null;

/**
 * Intercept ONLY console.log and console.error — NEVER process.stdout.write,
 * because Ink uses stdout.write to render its own frame. Intercepting it
 * breaks all rendering.
 */
function interceptOutput(enable: boolean): void {
  if (enable && !originalConsoleLog) {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    const bridge = getTuiBridge();

    console.log = (...args: any[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (text.length === 0) return;
      // One console.log call = one TUI message. Previously we split on \n
      // and emitted per-line, but MessageList adds marginTop:1 between
      // messages, so a multi-line console.log (like slash-help output)
      // ended up with a blank row between every line. Ink's <Text> handles
      // embedded newlines natively — pass the whole string as one message.
      if (bridge) bridge.addMessage({ role: 'info', text });
    };

    console.error = (...args: any[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (bridge) bridge.addMessage({ role: 'error', text });
    };
  } else if (!enable && originalConsoleLog) {
    console.log = originalConsoleLog;
    console.error = originalConsoleError!;
    originalConsoleLog = null;
    originalConsoleError = null;
  }
}

export async function routeInputTui(input: string, ctx: ReplContext): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // `!command` — direct shell execution bypassing the LLM. Ink is detached
  // so the child inherits a real TTY (required for interactive commands
  // like `gh auth login`, `ssh`, `vim`).
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    if (!cmd) return;
    const { destroyRepl, recreateRepl } = require('../lifecycle');

    // Unmount Ink FIRST so the bridge is inactive while stdio is inherited.
    destroyRepl();
    // Everything between destroy/recreate goes straight to stdout/stderr —
    // calling bridge.addMessage here triggers React state updates on an
    // unmounted tree.
    process.stdout.write(`$ ${cmd}\n`);
    let exitCode = 0;
    try {
      const { spawn } = require('child_process');
      const proc = spawn('bash', ['-c', cmd], {
        cwd: ctx.cwd,
        stdio: 'inherit',
        env: { ...process.env },
      });
      exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (c: number | null, sig: NodeJS.Signals | null) => resolve(c ?? (sig ? -1 : 0)));
        proc.on('error', () => resolve(-1));
      });
      if (exitCode !== 0) process.stdout.write(`(exit ${exitCode})\n`);
    } finally {
      recreateRepl();
      // Invalidate gh preflight cache — user may have just logged in/out.
      try { require('../router').__invalidateGhPreflight?.(); } catch (err) { swallow(err); }
    }
    return;
  }

  // Free text → streaming via SSE + progressive markdown in bridge
  if (!trimmed.startsWith('/')) {
    const { handleAIChatStream } = require('../ai/chat');
    await handleAIChatStream(trimmed, ctx);
    return;
  }

  const cmd = trimmed.split(/\s+/)[0].toLowerCase();

  // /quit, /exit, /q — intercepted here because router.ts's `rl.close()` is
  // a no-op against the fake readline stub. Unmount Ink cleanly, print the
  // interaction summary, then exit.
  if (cmd === '/quit' || cmd === '/exit' || cmd === '/q') {
    const { destroyRepl } = require('../lifecycle');
    const { printGoodbye } = require('../goodbye');
    destroyRepl();
    printGoodbye(ctx);
    process.exit(0);
  }

  // Heavy interactive commands — the old path tried to destroyRepl+run
  // inline, but the post-Ink stdin state is brittle (raw-mode leftovers,
  // dangling 'data' listeners) and readline.question inside these
  // commands consistently hung after the first prompt.
  //
  // New path: spawn a child `makestudio <subcommand> <args>` with
  // stdio:'inherit'. The child gets a clean fresh TTY, runs the
  // command's native readline loop normally, exits. Parent Ink stays
  // dormant during the whole thing — no stdin races, no teardown
  // surprises.
  const SPAWN_AS_CHILD: Record<string, string> = {
    '/refine': 'refine',
    '/doctor': 'doctor',
    '/init': 'init',
    '/start': 'start',
    '/execute': 'execute',
    '/security-review': 'security-review',
    '/secreview': 'security-review',
    '/review': 'security-review',
  };
  if (SPAWN_AS_CHILD[cmd]) {
    const { destroyRepl, recreateRepl } = require('../lifecycle');
    const subCmd = SPAWN_AS_CHILD[cmd];
    const argList = trimmed.split(/\s+/).slice(1);

    destroyRepl();
    process.stdout.write(`\n> ${subCmd} ${argList.join(' ')}\n`);
    try {
      const { spawn } = require('child_process');
      const nodeBin = process.argv[0];
      const scriptPath = process.argv[1];
      const proc = spawn(nodeBin, [scriptPath, subCmd, ...argList], {
        cwd: ctx.cwd,
        stdio: 'inherit',
        env: { ...process.env },
      });
      const exitCode: number = await new Promise((resolve) => {
        proc.on('exit', (c: number | null, sig: NodeJS.Signals | null) => resolve(c ?? (sig ? -1 : 0)));
        proc.on('error', () => resolve(-1));
      });
      if (exitCode !== 0) process.stdout.write(`(exit ${exitCode})\n`);
    } finally {
      recreateRepl();
    }
    return;
  }

  // Legacy: /login, /upgrade, /restart still use destroyRepl inline —
  // they don't rely on long readline prompts that hit the stdin issues.
  const INTERACTIVE = new Set(['/login', '/upgrade', '/restart']);

  if (INTERACTIVE.has(cmd)) {
    const { destroyRepl, recreateRepl } = require('../lifecycle');
    destroyRepl();
    try {
      await routeInput(trimmed, ctx, null as any);
    } finally {
      recreateRepl();
    }
    return;
  }

  // Non-interactive slash commands — intercept output and route through bridge
  interceptOutput(true);
  try {
    await routeInput(trimmed, ctx, {
      close: () => {},
      setPrompt: () => {},
      prompt: () => {},
    } as any);
  } finally {
    interceptOutput(false);
  }
}
