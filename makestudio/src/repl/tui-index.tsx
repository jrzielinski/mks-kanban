/**
 * Ink-based REPL entry point.
 * Replaces the readline loop in repl/index.ts with a full React TUI.
 */

import * as React from 'react';
import { render } from 'ink';
import { ReplContext } from './context';
import { App } from './tui/App';
import { printWelcomeBanner } from './tui/Welcome';
import { registerLifecycle } from './lifecycle';
import { listDueSchedules, markRan } from './schedule';
import { loadMostRecent, loadById, loadSessionMessages, bindSessionFile, detectInterrupted } from './sessions';
import { findImportCandidate, readImportFile, askImport } from './claude-md-import';

export interface ReplStartOptions {
  continueSession?: boolean;          // -c / --continue
  resumeSessionId?: string;           // --resume <uuid-or-prefix>
  teleportCode?: string;              // --teleport <code>
  autoApprove?: boolean;              // --yes / --dangerously-skip-permissions
}

export async function startRepl(options: ReplStartOptions = {}): Promise<void> {
  process.env.MAKESTUDIO_REPL = '1';

  // Install the bounded warning handler early. Without this, Node emits
  // MaxListenersExceededWarning on AbortSignal the first time the subagent
  // fan-out hits the default cap of 10, and it scrolls Ink's output with
  // noise users mistake for errors.
  try { require('../utils/warning-handler').initializeWarningHandler(); } catch { /* */ }

  // Clear screen + scrollback before mounting TUI
  // \x1B[2J = clear screen, \x1B[3J = clear scrollback (xterm), \x1B[H = cursor home
  process.stdout.write('\x1B[2J\x1B[3J\x1B[H');

  const ctx = new ReplContext();
  await ctx.initialize();
  if (options.autoApprove) ctx.autoApprove = true;

  // Sweep stale scratchpad dirs (~/.makestudio/scratch/par-*|coord-*|dispatch-*)
  // from past runs. Silent — failures never block startup, the accumulation is
  // cosmetic disk bloat not correctness.
  try { require('./scratchpad-cleanup').cleanupScratchpads(); } catch { /* */ }

  // Start LAN peer discovery if the user opted in via /cluster enable. Idempotent —
  // no-op when cluster.enabled is false, so the default UX doesn't change.
  // When enabled, also brings up the WS server that accepts peer requests.
  try {
    const { loadClusterConfig } = require('./cluster/config');
    const { startDiscovery } = require('./cluster/discovery');
    const { startClusterServer } = require('./cluster/server');
    if (loadClusterConfig().enabled) {
      try { await startDiscovery(); }
      catch (err: any) {
        process.stderr.write(`[cluster] startDiscovery failed: ${err?.message || err}\n`);
      }
      try { await startClusterServer(); }
      catch (err: any) {
        process.stderr.write(`[cluster] startClusterServer failed: ${err?.message || err}\n`);
      }
    }
  } catch (err: any) {
    process.stderr.write(`[cluster] boot failed: ${err?.message || err}\n`);
  }

  // Hydrate ctx from a prior session BEFORE the banner so the banner sees
  // the right message count, but defer printing the "Resumed / interrupted"
  // notice until AFTER the banner — otherwise a multi-line warning floats
  // above the logo and looks orphaned at the top of the window.
  let resumeNotice: string[] = [];

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
        resumeNotice.push(`  Teleport loaded — ${snap.messages.length} message(s) from ${snap.machine?.hostname || 'another machine'}`);
      } else {
        resumeNotice.push(`  Teleport code not found or empty: ${options.teleportCode}`);
      }
    } catch (err: any) {
      resumeNotice.push(`  Failed to load teleport: ${err.message}`);
    }
  }

  if (options.continueSession || options.resumeSessionId) {
    const summary = options.resumeSessionId
      ? loadById(ctx.cwd, options.resumeSessionId)
      : loadMostRecent(ctx.cwd);
    if (summary) {
      try {
        const msgs = loadSessionMessages(summary.file);
        ctx.messages.push(...msgs);
        bindSessionFile(ctx, summary.file);
        ctx.justResumed = true;
        resumeNotice.push(
          `  Resumed session ${summary.sessionId.slice(0, 8)} — ${msgs.length} message(s) from ${summary.startedAt}`,
        );
        const recovery = detectInterrupted(summary.file);
        if (recovery.interrupted) {
          const preview = (recovery.lastUserMessage || '').slice(0, 80).replace(/\s+/g, ' ');
          resumeNotice.push(
            `  ! Last turn appears interrupted — no assistant reply after: "${preview}${preview.length >= 80 ? '...' : ''}"`,
          );
          resumeNotice.push(`    Type /retry to regenerate, or continue with a new message.`);
        }
      } catch (err: any) {
        resumeNotice.push(`  Failed to resume session: ${err.message}`);
      }
    } else {
      resumeNotice.push(
        options.resumeSessionId
          ? `  Session "${options.resumeSessionId}" not found in ${ctx.cwd}`
          : `  No prior session found in ${ctx.cwd}`,
      );
    }
  }

  // SessionStart hook — fires once per `makestudio` boot. The user can wire
  // this to load .env, run git fetch, log a telemetry event, etc. Synchronous,
  // best-effort (failures logged after banner prints so they don't corrupt it).
  let sessionStartFailures: string[] = [];
  try {
    const { runHooks } = require('./hooks');
    const res = await runHooks('SessionStart', { projectPath: ctx.cwd });
    sessionStartFailures = res.failures || [];

    // Setup hook — fires ONCE per project on the first SessionStart ever.
    // Uses a marker file at .makestudio/.setup-fired so the event survives
    // CLI restarts. Plugins can wire this to run `npm install`, generate
    // secrets, initialise local state, etc. Idempotent by design.
    const fsMod = require('fs');
    const pathMod = require('path');
    const setupMarker = pathMod.join(ctx.cwd, '.makestudio', '.setup-fired');
    const inProject = fsMod.existsSync(pathMod.join(ctx.cwd, '.git'));
    // Auto-bootstrap: when the current dir looks like a real project (has
    // a .git checkout) but `.makestudio/` doesn't exist yet, scaffold the
    // standard layout. Idempotent — safe to call repeatedly. Skipped for
    // ephemeral cwds like /tmp where dropping a `.makestudio/` would be
    // surprising.
    if (inProject && !fsMod.existsSync(pathMod.join(ctx.cwd, '.makestudio'))) {
      try {
        const { bootstrapProject } = require('./project-bootstrap');
        const r = bootstrapProject(ctx.cwd);
        if (r.created.length > 0) {
          process.stdout.write(`[bootstrap] scaffolded .makestudio/ (${r.created.length} item${r.created.length === 1 ? '' : 's'} — see .makestudio/README.md)\n`);
        }
      } catch { /* never break boot because of bootstrap */ }
    }
    // First-ever-run user persona templates. Copies IDENTITY/SOUL/USER from
    // the agent bundle to ~/.makestudio/ on the FIRST machine boot. Runs
    // regardless of whether the cwd is a project — these files are
    // user-global by design (persona doesn't depend on which repo you're
    // in). Idempotent: existing files at the destination are skipped.
    try {
      const { ensureUserPersonaTemplates } = require('./persona');
      const created = ensureUserPersonaTemplates();
      if (created.length > 0) {
        process.stdout.write(`[persona] seeded ~/.makestudio/${created.join(', ')} — edit to customise\n`);
      }
    } catch { /* persona seeding is optional */ }
    if (!fsMod.existsSync(setupMarker)) {
      const setupRes = await runHooks('Setup', { projectPath: ctx.cwd });
      sessionStartFailures = sessionStartFailures.concat(setupRes.failures || []);
      try {
        fsMod.mkdirSync(pathMod.dirname(setupMarker), { recursive: true });
        fsMod.writeFileSync(setupMarker, new Date().toISOString() + '\n');
      } catch { /* marker best-effort; worst case the hook fires again next boot */ }
    }
  } catch { /* hooks optional */ }

  // Print the banner directly to stdout (scrollback) so it doesn't repaint
  // on Ink re-renders while typing.
  printWelcomeBanner(ctx);
  if (sessionStartFailures.length > 0) {
    process.stderr.write(sessionStartFailures.map((f) => `  ${f}`).join('\n') + '\n');
  }

  // Now that the banner, version line, provider and tip are on screen, drop
  // the session-resume notice right below them — it reads as a natural
  // follow-up to the header instead of a pre-logo orphan block.
  if (resumeNotice.length > 0) {
    process.stderr.write('\n' + resumeNotice.join('\n') + '\n');
  }

  // CLAUDE.md / AGENT.md auto-import — runs once per session, before Ink
  // mounts so readline works in normal terminal mode.
  // With --dangerously-skip-permissions (autoApprove): import silently — the
  // user already expressed full trust, asking again is redundant.
  if (!ctx.importedRules) {
    try {
      const candidate = findImportCandidate(ctx.cwd);
      if (candidate) {
        if (ctx.autoApprove) {
          // Silent auto-import — no prompt needed in bypass mode.
          ctx.importedRules = readImportFile(candidate.filePath);
          process.stdout.write(`  Rules auto-imported from ${candidate.fileName} as compact English guidance (${ctx.importedRules.length} chars, bypass mode)\n`);
        } else {
          process.stdout.write('\n');
          const accepted = await askImport(candidate);
          if (accepted) {
            ctx.importedRules = readImportFile(candidate.filePath);
            process.stdout.write(`  Rules imported from ${candidate.fileName} as compact English guidance (${ctx.importedRules.length} chars)\n`);
          } else {
            process.stdout.write(`  Skipped — rules not imported this session\n`);
          }
          process.stdout.write('\n');
        }
      }
    } catch { /* best-effort — never block startup */ }
  }

  // Pre-warm the prompt cache before the first user turn. Opt-in via
  // settings.cacheWarmOnStart. Skipped silently when disabled or when
  // the call fails (no provider key, network, etc.).
  try {
    const { warmCacheIfEnabled } = require('./ai/chat-prelude');
    warmCacheIfEnabled(ctx).catch(() => { /* */ });
  } catch { /* */ }

  let inkInstance: any = null;
  // `true` only after the user explicitly quits (Ctrl+C at the outer TTY,
  // or a /quit-style slash). Commands that temporarily destroy+recreate
  // Ink (e.g. /refine, /model, /doctor) must NOT flip this — otherwise
  // Ink's waitUntilExit() resolves during the command, the goodbye
  // handler prints, process.exit(0) fires mid-command and the outer node
  // process crashes with whatever the child was in the middle of (e.g.
  // yoga-layout's nbind throw during teardown).
  let userExitRequested = false;

  const mount = () => {
    // Enable bracketed paste mode before Ink takes over the terminal so the
    // sequence is processed while the TTY is still in its normal state.
    // Ink's raw-mode setup does NOT reset DEC private modes, so this persists.
    try { process.stdout.write('\x1b[?2004h'); } catch { /* */ }
    inkInstance = render(
      <App ctx={ctx} onExit={() => { userExitRequested = true; }} />,
      { exitOnCtrlC: false },
    );
    // Expose the instance for non-React code (e.g. MatrixView's
    // unmount cleanup needs to call inst.clear() to reset log-update's
    // line counter after leaving alt-screen).
    (global as any).__makestudio_inkInstance = inkInstance;
  };

  const unmount = (): void | Promise<void> => {
    if (!inkInstance) return;
    const inst = inkInstance;
    inkInstance = null;
    delete (global as any).__makestudio_inkInstance;
    // Trigger React unmount and return a Promise that resolves AFTER Ink's
    // useEffect cleanup hooks have run (those reset stdin raw mode and
    // remove our paste/data listeners). lifecycle.destroyRepl() awaits
    // this — without the await, withDetachedRepl proceeds while Ink is
    // still mid-cleanup, raw mode stays on, and `/login` shows ^M.
    inst.unmount();
    return inst.waitUntilExit();
  };

  registerLifecycle(unmount, mount);

  // On terminal resize, scroll all visible content into the scrollback buffer
  // and reset Ink's cursor tracking — WITHOUT unmounting. Unmounting destroys
  // React state (messages array), causing the conversation history and any
  // coordinator reports to disappear.
  //
  // Strategy: print `rows` blank lines. This scrolls the entire viewport
  // (including ghost InputBox copies from terminal reflow on shrink) into
  // scrollback. Cursor ends at the bottom. inkInstance.clear() resets
  // log-update's previousLineCount to 0 so the next Ink render starts clean
  // from the current cursor position. The dynamic area (InputBox + StatusLine)
  // re-renders at the bottom; Static messages are in scrollback (scroll up
  // to see them). Debounced at 50ms so rapid resize events coalesce.
  let resizeDebounce: NodeJS.Timeout | null = null;
  process.stdout.on('resize', () => {
    if (!inkInstance) return;
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      if (!inkInstance) return;
      try {
        const rows = process.stdout.rows || 24;
        // Scroll everything (including ghost copies) off-screen into scrollback.
        process.stdout.write('\n'.repeat(rows));
        // Reset log-update's previousLineCount so the next render does not
        // erase based on the pre-resize line count.
        inkInstance.clear();
      } catch { /* */ }
    }, 50);
  });

  mount();

  // Schedule poller: checks every minute for due schedules.
  // .unref() so this timer alone does not keep the event loop alive when
  // every other handle has closed — matches Claude Code's background
  // housekeeping pattern. Also registered with cleanup-registry so
  // graceful shutdown clears it even if the caller bypasses the block
  // below (defensive — e.g. SIGTERM from the outer process).
  const schedulePollerId = setInterval(async () => {
    const due = listDueSchedules();
    if (due.length === 0) return;
    const { tuiLog } = require('./tui/bridge');
    for (const s of due) {
      tuiLog(`⏰ schedule triggered: ${s.name}`, 'info');
      try {
        const { routeInputTui } = require('./tui/tui-router');
        await routeInputTui(s.command, ctx);
        markRan(s.id);
      } catch (err: any) {
        tuiLog(`schedule ${s.name} failed: ${err.message}`, 'error');
      }
    }
  }, 60_000);
  schedulePollerId.unref?.();
  try {
    const { registerCleanup } = require('../utils/cleanup-registry');
    registerCleanup(() => { clearInterval(schedulePollerId); });
    registerCleanup(() => { try { require('./ai/advanced-tools').stopAllBackgroundTasks?.(); } catch { /* */ } });
    registerCleanup(() => { try { require('./mcp').shutdownMcp?.(); } catch { /* */ } });
    registerCleanup(() => { try { require('./cluster/discovery').stopDiscovery?.(); } catch { /* */ } });
    registerCleanup(() => { try { require('./cluster/server').stopClusterServer?.(); } catch { /* */ } });
    registerCleanup(() => { try { require('./cluster/client').closeAllConnections?.(); } catch { /* */ } });
  } catch { /* */ }

  // Wait for the TUI to actually be DONE (user explicitly quit) — not just
  // to be torn down mid-command. A bare `await inkInstance.waitUntilExit()`
  // here resolves EVERY time destroyRepl() runs, which is the wrong signal
  // for commands like /refine /model /doctor that temporarily detach and
  // re-mount. Loop until userExitRequested flips, re-waiting on whichever
  // instance currently exists (or polling briefly if unmounted).
  while (!userExitRequested) {
    if (inkInstance) {
      await inkInstance.waitUntilExit();
    } else {
      // Detached — wait a tick for the command to call recreateRepl.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Print interaction summary once Ink has released stdout.
  try {
    const { printGoodbye } = require('./goodbye');
    printGoodbye(ctx);
  } catch { /* */ }

  // Teardown everything that could keep Node's event loop alive. Two
  // parallel paths:
  //   1. cleanup-registry handles REGISTERED resources (schedule poller,
  //      background tasks, MCP) with a 2s budget — a slow cleanup can't
  //      wedge shutdown.
  //   2. SessionEnd hook + failsafe forceExit fire after the budget.
  //
  // Do NOT touch stdin/setRawMode here — Ink restores its own state on
  // unmount, and an extra setRawMode(false) racing against Ink's teardown
  // surfaced as "setRawMode EIO" crashes in the user's screen.
  try {
    const { runCleanupFunctions } = require('../utils/cleanup-registry');
    await runCleanupFunctions(2000);
  } catch { /* */ }
  // SessionEnd hook — fires exactly once on explicit quit. Fire-and-forget;
  // we don't block process.exit on slow hooks.
  try { require('./hooks').runHooks('SessionEnd', { projectPath: ctx.cwd }); } catch { /* */ }
  // Failsafe: if process.exit(0) doesn't fire because a stray handle is
  // still open (rare, but seen when an MCP child refuses to die), force
  // termination after 5s. Matches Claude Code's gracefulShutdown pattern.
  const failsafe = setTimeout(() => {
    try { process.kill(process.pid, 'SIGKILL'); } catch { /* */ }
  }, 5000);
  failsafe.unref();
  process.exit(0);
}
