import { swallow } from '../utils/log';
/**
 * main-bootstrap.ts
 *
 * Arranca o ReplContext pro processo main do Electron. Port da lógica
 * de boot do `tui-index.tsx` com as dependências de Ink removidas:
 *   - não clear screen (renderer cuida)
 *   - não monta Ink (renderer é web)
 *   - não prompta CLAUDE.md import sincronamente — adia para um flow
 *     interativo via IPC question (Fase 1b+)
 *   - mantém: warning handler, scratchpad cleanup, cluster, schedule
 *     poller, hooks SessionStart/Setup, cleanup registry.
 *
 * Retorna `{ ctx, shutdown }` — main.ts guarda pra wire de IPC e
 * chama shutdown() em `app.before-quit`.
 */

import { ReplContext } from './context';
import { installElectronBridge } from './tui/electron-bridge';

export interface BootedAgent {
  ctx: ReplContext;
  shutdown: () => Promise<void>;
}

export async function bootAgent(): Promise<BootedAgent> {
  process.env.MAKESTUDIO_REPL = '1';
  process.env.MAKESTUDIO_UI = 'electron-web';
  process.env.MAKESTUDIO_ELECTRON = '1';

  // Bounded warning handler pra evitar spam de MaxListenersExceededWarning
  try {
    require('../utils/warning-handler').initializeWarningHandler();
  } catch (err) { swallow(err); }

  // Sweep stale scratchpad dirs de runs anteriores
  try {
    require('./scratchpad-cleanup').cleanupScratchpads();
  } catch (err) { swallow(err); }

  const ctx = new ReplContext();

  // Checar auth ANTES de ctx.initialize(). No CLI, initialize chama
  // ensureAuthenticated() que pode prompt via stdin readline — o que
  // trava o boot do Electron (main não tem TTY vivo). Instala o bridge
  // primeiro pra poder publicar mensagens; se não auth, pula initialize
  // e sinaliza pro renderer.
  installElectronBridge(ctx);

  let authenticated = false;
  try {
    const { isAuthenticated } = require('../network/auth');
    authenticated = Boolean(isAuthenticated());
  } catch (err) { swallow(err); }

  if (authenticated) {
    try {
      await ctx.initialize();
    } catch (err: any) {
      const { tuiLog } = require('./tui/bridge');
      tuiLog(`Falha ao inicializar contexto: ${err?.message || err}`, 'error');
    }
  }
  // Sem auth: silêncio. A LoginPage do renderer (Electron) gateia a UI
  // inteira — publicar warning aqui só polui o transcript após o login.
  // Initialize tardio acontece no handler AUTH_LOGIN do main.

  // Warm up model catalog + heartbeat
  try {
    require('./ai/providers/catalog').fetchCatalog().catch(() => { /* fallback silencioso */ });
  } catch (err) { swallow(err); }
  try {
    require('../network/heartbeat').startHeartbeat();
  } catch (err) { swallow(err); }

  // LAN peer discovery + WS server — só se cluster.enabled
  try {
    const { loadClusterConfig } = require('./cluster/config');
    const { startDiscovery } = require('./cluster/discovery');
    const { startClusterServer } = require('./cluster/server');
    if (loadClusterConfig().enabled) {
      await startDiscovery();
      await startClusterServer();
    }
  } catch (err) { swallow(err); }

  // SessionStart hook — fires once per boot
  try {
    const { runHooks } = require('./hooks');
    const res = await runHooks('SessionStart', { projectPath: ctx.cwd });
    if (res?.failures?.length) {
      // Publica os failures como info mensages pro renderer
      const { tuiLog } = require('./tui/bridge');
      for (const f of res.failures) tuiLog(`hook SessionStart: ${f}`, 'warn');
    }

    // Setup hook — fires ONCE per project on the first SessionStart ever
    const fsMod = require('fs');
    const pathMod = require('path');
    const setupMarker = pathMod.join(ctx.cwd, '.makestudio', '.setup-fired');
    if (!fsMod.existsSync(setupMarker)) {
      try {
        await runHooks('Setup', { projectPath: ctx.cwd });
        fsMod.mkdirSync(pathMod.dirname(setupMarker), { recursive: true });
        fsMod.writeFileSync(setupMarker, new Date().toISOString() + '\n');
      } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }

  // Schedule poller — 60s, unref'd
  const { listDueSchedules, markRan, recordRun } = require('./schedule');
  const { tuiLog } = require('./tui/bridge');
  const schedulePollerId = setInterval(async () => {
    const due = listDueSchedules();
    if (due.length === 0) return;
    for (const s of due) {
      tuiLog(`⏰ schedule triggered: ${s.name}`, 'info');
      const startedAt = Date.now();
      try {
        const { routeInputWeb } = require('./web-router');
        await routeInputWeb(s.command, ctx);
        markRan(s.id);
        recordRun({
          scheduleId: s.id,
          ranAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          // Slash commands route through the chat — output goes into the
          // transcript, not capturable here. Leave outputTail empty; UI
          // can deep-link to the session if needed.
          outputTail: '',
          trigger: 'poller',
        });
      } catch (err: any) {
        tuiLog(`schedule ${s.name} failed: ${err.message}`, 'error');
        // Mark as ran anyway so a broken slash command doesn't spam the
        // poller every minute. User must fix or disable the schedule.
        markRan(s.id);
        recordRun({
          scheduleId: s.id,
          ranAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          exitCode: null,
          outputTail: '',
          error: (err?.message ?? String(err))?.substring(0, 500),
          trigger: 'poller',
        });
      }
    }
  }, 60_000);
  schedulePollerId.unref?.();

  // Register cleanup funcs — replicam os do tui-index
  try {
    const { registerCleanup } = require('../utils/cleanup-registry');
    registerCleanup(() => clearInterval(schedulePollerId));
    registerCleanup(() => {
      try { require('./ai/advanced-tools').stopAllBackgroundTasks?.(); } catch (err) { swallow(err); }
    });
    registerCleanup(() => {
      try { require('./mcp').shutdownMcp?.(); } catch (err) { swallow(err); }
    });
    registerCleanup(() => {
      try { require('./cluster/discovery').stopDiscovery?.(); } catch (err) { swallow(err); }
    });
    registerCleanup(() => {
      try { require('./cluster/server').stopClusterServer?.(); } catch (err) { swallow(err); }
    });
    registerCleanup(() => {
      try { require('./cluster/client').closeAllConnections?.(); } catch (err) { swallow(err); }
    });
  } catch (err) { swallow(err); }

  const shutdown = async (): Promise<void> => {
    try {
      const { runCleanupFunctions } = require('../utils/cleanup-registry');
      await runCleanupFunctions(2000);
    } catch (err) { swallow(err); }
    try {
      await require('./hooks').runHooks('SessionEnd', { projectPath: ctx.cwd });
    } catch (err) { swallow(err); }
  };

  return { ctx, shutdown };
}
