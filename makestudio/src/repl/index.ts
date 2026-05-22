import * as readline from 'readline';
import chalk from 'chalk';
import { ReplContext } from './context';
import { buildPrompt, printWelcome } from './ui/prompt';
import { routeInput } from './router';
import { registerLifecycle } from './lifecycle';
import { listDueSchedules, listAllSchedules, findMissedTasks, markRan } from './schedule';
import { loadHistory, appendHistory } from './history';

import { swallow } from '../utils/log';
const dim = chalk.hex('#64748B');

let currentRl: readline.Interface | null = null;
let replCtx: ReplContext | null = null;

function destroyCurrentRl(): void {
  if (currentRl) {
    currentRl.removeAllListeners();
    currentRl.close();
    currentRl = null;
    // Force-release stdin listeners left by readline
    process.stdin.removeAllListeners('keypress');
  }
}

function recreateCurrentRl(): void {
  if (!replCtx) return;
  currentRl = createRl(replCtx);
  currentRl.prompt();
}

const BUILTIN_COMMANDS = [
  '/help', '/quit', '/exit', '/clear', '/compact', '/summarize',
  '/continue', '/sessions', '/security-review', '/secreview',
  '/login', '/logout', '/projects', '/project',
  '/status', '/tasks', '/execute', '/refine', '/doctor', '/init', '/start', '/analyze',
  '/ai', '/cost', '/usage', '/ctx', '/context', '/model',
  '/retry', '/regenerate', '/edit', '/undo',
  '/resume', '/rewind', '/skills', '/schedule',
  '/diff', '/branch', '/commit', '/commit-push-pr', '/cpp',
  '/effort', '/debug', '/memory', '/mem', '/hooks',
  '/plugin', '/plugins', '/kanban', '/health', '/history', '/boilerplate', '/bp',
];

function buildCompleter(ctx: ReplContext) {
  return (line: string): [string[], string] => {
    if (!line.startsWith('/')) return [[], line];

    const parts = line.split(/\s+/);
    const first = parts[0];

    // Completing the command name itself
    if (parts.length === 1) {
      const { loadAllSkills } = require('./skills');
      let skillCommands: string[] = [];
      try { skillCommands = loadAllSkills(ctx.cwd).map((s: any) => '/' + s.name); } catch (err) { swallow(err); }
      try {
        const { pluginRegistry } = require('../core/plugin-registry');
        skillCommands = skillCommands.concat(pluginRegistry.getCommands().map((c: any) => '/' + c.name));
      } catch (err) { swallow(err); }
      const all = [...BUILTIN_COMMANDS, ...skillCommands];
      const hits = all.filter((c) => c.startsWith(first));
      return [hits, first];
    }

    // Subcommand completion for specific commands
    if (first === '/schedule' && parts.length === 2) {
      const hits = ['list', 'add', 'remove', 'enable', 'disable', 'next'].filter((s) => s.startsWith(parts[1]));
      return [hits.map((h) => `/schedule ${h}`), line];
    }
    if (first === '/memory' && parts.length === 2) {
      const hits = ['list', 'save', 'delete', 'rebuild'].filter((s) => s.startsWith(parts[1]));
      return [hits.map((h) => `/memory ${h}`), line];
    }
    if (first === '/plugin' && parts.length === 2) {
      const hits = ['list', 'install', 'remove', 'enable', 'disable'].filter((s) => s.startsWith(parts[1]));
      return [hits.map((h) => `/plugin ${h}`), line];
    }
    if (first === '/ai' && parts.length === 2) {
      const hits = ['claude', 'codex', 'gemini'].filter((s) => s.startsWith(parts[1]));
      return [hits.map((h) => `/ai ${h}`), line];
    }
    if (first === '/effort' && parts.length === 2) {
      const hits = ['low', 'medium', 'high', 'max'].filter((s) => s.startsWith(parts[1]));
      return [hits.map((h) => `/effort ${h}`), line];
    }

    return [[], line];
  };
}

function createRl(ctx: ReplContext): readline.Interface {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(ctx),
    historySize: 2000,
    completer: buildCompleter(ctx),
  });

  // Seed readline history from persisted file (most recent last)
  const persisted = loadHistory(ctx.cwd);
  // Node's readline history is in reverse order (most recent first)
  (rl as any).history = [...persisted].reverse();

  rl.on('line', async (line: string) => {
    if (line && line.trim()) appendHistory(line, ctx.cwd);
    try {
      await routeInput(line, ctx, rl);
    } catch (err: any) {
      console.log(`  ${chalk.hex('#EF4444')('!')} ${err.message || err}`);
    }

    if (!currentRl) return;
    rl.setPrompt(buildPrompt(ctx));
    rl.prompt();
  });

  rl.on('close', () => {
    if (currentRl === rl) {
      try {
        const { printGoodbye } = require('./goodbye');
        printGoodbye(ctx);
      } catch (err) { swallow(err); }
      process.exit(0);
    }
  });

  return rl;
}

function startSchedulePoller(ctx: ReplContext): NodeJS.Timeout {
  const t = setInterval(async () => {
    const due = listDueSchedules();
    if (due.length === 0) return;
    for (const s of due) {
      console.log();
      console.log(`  ${chalk.hex('#22D3EE')('⏰')} ${chalk.bold(s.name)} ${dim('—')} agendamento disparado`);
      try {
        const { routeInput } = require('./router');
        await routeInput(s.command, ctx, currentRl as any);
        markRan(s.id);
      } catch (err: any) {
        console.log(`  ${chalk.hex('#EF4444')('!')} Erro no agendamento ${s.name}: ${err.message}`);
      }
    }
    if (currentRl) {
      currentRl.setPrompt(buildPrompt(ctx));
      currentRl.prompt();
    }
  }, 60_000); // check every minute
  // Background timer — don't let it block process exit when readline closes.
  t.unref?.();
  return t;
}

export interface ReplStartOptions {
  continueSession?: boolean;
  resumeSessionId?: string;
  teleportCode?: string;
}

export async function startRepl(options: ReplStartOptions = {}): Promise<void> {
  process.env.MAKESTUDIO_REPL = '1';
  const ctx = new ReplContext();
  replCtx = ctx;

  registerLifecycle(destroyCurrentRl, recreateCurrentRl);

  await ctx.initialize();

  // Warm up model catalog (backend controls which provider:model serves each
  // tier) and start the 5-min heartbeat (license check + usage batch).
  // Non-blocking: REPL proceeds even if backend is unreachable — defaults apply.
  try {
    const { fetchCatalog } = require('./ai/providers/catalog');
    fetchCatalog().catch(() => { /* fall back to DEFAULT_CATALOG silently */ });
    const { startHeartbeat } = require('../network/heartbeat');
    startHeartbeat();
  } catch (err) { swallow(err); }

  // Teleport: load snapshot from ~/.makestudio/teleport/<code>.json
  if (options.teleportCode) {
    try {
      const { loadTeleportSnapshot } = require('./slash-handlers/teleport');
      const snap = loadTeleportSnapshot(options.teleportCode);
      if (snap && snap.messages && snap.messages.length > 0) {
        ctx.messages.push(...snap.messages);
        ctx.activeProject = snap.activeProject || ctx.activeProject;
        ctx.provider = snap.provider || ctx.provider;
        ctx.effort = snap.effort || ctx.effort;
        if (snap.approvedTools) ctx.approvedTools = new Set(snap.approvedTools);
        if (snap.autoApprove !== undefined) ctx.autoApprove = snap.autoApprove;
        if (snap.lastUserMessage) ctx.lastUserMessage = snap.lastUserMessage;
        if (snap.lastToolCall) ctx.lastToolCall = snap.lastToolCall;
        console.log(`  ${dim(`Teleport loaded — ${snap.messages.length} message(s) from ${snap.machine?.hostname || 'another machine'}`)}`);
      } else {
        console.log(`  ${dim('Teleport code not found or empty: ' + options.teleportCode)}`);
      }
    } catch (err: any) {
      console.log(`  ${dim(`Failed to load teleport: ${err.message}`)}`);
    }
  }

  // Optional: hydrate from a prior session
  if (options.continueSession || options.resumeSessionId) {
    const { loadMostRecent, loadById, loadSessionMessages, bindSessionFile } = require('./sessions');
    const summary = options.resumeSessionId
      ? loadById(ctx.cwd, options.resumeSessionId)
      : loadMostRecent(ctx.cwd);
    if (summary) {
      try {
        const msgs = loadSessionMessages(summary.file);
        ctx.messages.push(...msgs);
        bindSessionFile(ctx, summary.file);
        console.log(`  ${dim(`Resumed session ${summary.sessionId.slice(0, 8)} — ${msgs.length} message(s)`)}`);
      } catch (err: any) {
        console.log(`  ${dim(`Failed to resume: ${err.message}`)}`);
      }
    } else {
      console.log(`  ${dim(options.resumeSessionId ? 'Session not found' : 'No prior session in this directory')}`);
    }
  }

  // Detect if the most recent session was interrupted/crashed (even without --continue)
  try {
    const { loadMostRecent, detectInterrupted, detectCancelled } = require('./sessions');
    const lastSession = loadMostRecent(ctx.cwd);
    if (lastSession && !options.continueSession && !options.resumeSessionId) {
      const recovery = detectInterrupted(lastSession.file);
      if (recovery.interrupted) {
        const cancelled = detectCancelled(lastSession.file);
        if (cancelled) {
          console.log(`  ${dim(`Last session was cancelled (use ${chalk.cyan('--continue')} to resume)`)}`);
        } else {
          console.log(`  ${chalk.hex('#FBBF24')('!')} Last session (${lastSession.sessionId.slice(0, 8)}) was interrupted mid-turn. Use ${chalk.cyan('--continue')} to restore.`);
        }
      }
    }
  } catch (err) { swallow(err); }

  // Log missed schedules (tasks whose fire window passed while offline)
  try {
    const missed = findMissedTasks(listAllSchedules());
    if (missed.length > 0) {
      console.log(`  ${chalk.hex('#FBBF24')('\u231B')} ${missed.length} agendamento(s) perdido(s) durante o período offline`);
      for (const m of missed) {
        console.log(`    ${dim(m.name)} — execução perdida em ${new Date(m.missedFrom).toLocaleString()}`);
      }
    }
  } catch (err) { swallow(err); }

  // Camada B — spawn tsc --watch --noEmit --incremental background. Não
  // bloqueante: se falhar (sem tsconfig, sem npx) retorna silenciosamente.
  try { require('./ai/typecheck-watcher').startTypeCheckWatcher(ctx); } catch (err) { swallow(err); }

  // Memory watchdog — sample heap every 30s; force compact at 3.5GB,
  // critical alert at 6GB. Without this, long REPL sessions OOM at the
  // 8GB heap ceiling (real incident: 2026-04-26 lost 2h46min of work).
  try {
    const { startMemoryWatchdog } = require('./memory-watchdog');
    const { compactNow } = require('./ai/chat');
    const wd = startMemoryWatchdog({
      intervalMs: 30_000,
      onHigh: (status: any) => {
        const msg = `[memory] heap ${status.heapUsedMB}MB ≥ 3.5GB — forçando autoCompact`;
        console.log(`  ${chalk.hex('#FBBF24')('!')} ${msg}`);
        try { require('./debug-log').dbgWarn('memory_high', status); } catch (err) { swallow(err); }
        // Fire-and-forget compactNow — never block the watchdog tick
        Promise.resolve(compactNow(ctx)).catch(() => { /* compactNow already logs */ });
      },
      onCritical: (status: any) => {
        const msg = `[memory] heap ${status.heapUsedMB}MB ≥ 6GB — CRÍTICO. Considere /clear ou reiniciar o REPL`;
        console.log(`  ${chalk.hex('#EF4444')('!')} ${msg}`);
        try { require('./debug-log').dbgError('memory_critical', status); } catch (err) { swallow(err); }
      },
    });
    // Stash on ctx so SIGINT/exit can stop it cleanly
    (ctx as any).__memoryWatchdog = wd;
  } catch (err) { swallow(err); }

  printWelcome(ctx);

  currentRl = createRl(ctx);
  currentRl.prompt();

  // Start schedule poller — checks every minute for due schedules
  startSchedulePoller(ctx);

  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount >= 2) {
      console.log();
      // Stop background tsc watcher first
      try { require('./ai/typecheck-watcher').stopTypeCheckWatcher(); } catch (err) { swallow(err); }
      // Stop memory watchdog
      try { (ctx as any).__memoryWatchdog?.stop?.(); } catch (err) { swallow(err); }
      try {
        const { printGoodbye } = require('./goodbye');
        printGoodbye(ctx);
      } catch (err) { swallow(err); }
      process.exit(0);
    }
    console.log(`  ${dim('(Ctrl+C para sair)')}`);
    sigintCount = 0;
    if (currentRl) currentRl.prompt();
  });
}
