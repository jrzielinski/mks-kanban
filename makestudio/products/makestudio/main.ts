/**
 * MakeStudio product — Electron main process implementation.
 *
 * Loaded by `desktop/main.ts` (the shell entry-point) AFTER:
 *   1. The diagnostics_channel.tracingChannel polyfill is installed
 *      (bootstrap.js + defense-in-depth in desktop/main.ts).
 *   2. `tsx/cjs` is registered so `.ts` source from `agent/src/repl/*`
 *      can be required at runtime.
 *
 * Boot sequence inside this file:
 *   1. BrowserWindow + preload.
 *   2. setBroadcaster → webContents.send pra todas as janelas.
 *   3. bootAgent() → ReplContext + installElectronBridge + hooks + poller.
 *   4. Register IPC handlers que falam com o ctx real.
 *
 * Fallback mock: se bootAgent() falhar (dev sem deps), fica com handlers
 * que publicam uma mensagem de erro explicando o motivo, em vez de
 * crashar a janela.
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  Notification,
  shell,
  dialog,
  globalShortcut,
  clipboard,
  screen as electronScreen,
  IpcMainInvokeEvent,
} from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import type {
  TuiMessageDTO,
  AgentState,
  PermissionChoice,
  ScheduleDTO,
  DaemonStatusDTO,
  SettingsDTO,
  OutputStyleDTO,
  FlagDTO,
  StatuslineFieldDTO,
  PermissionPolicyDTO,
  PermissionRuleDTO,
  PermissionTestRequestDTO,
  PermissionTestResultDTO,
  ShadowWarningDTO,
  TrustedFolderDTO,
  HookDTO,
  HookTestResultDTO,
  UsageAggregateDTO,
  UsageHeatmapDTO,
  UsageStreaksDTO,
  UsageEventDTO,
  UsageCsvExportRequestDTO,
  UsageCsvExportResultDTO,
  DebugLogEntryDTO,
  DebugLogTailRequestDTO,
  DebugLogSessionDTO,
  DebugLogFollowStartDTO,
  DoctorReportDTO,
  DoctorRunOptionsDTO,
  HealthReportDTO,
} from '../../src/repl/ipc/types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const isDev = process.env.NODE_ENV === 'development';

// ── Helper pra require() .ts source do agent ─────────────────────────────
// Resolves the `agent/` root by walking up until a SOURCE marker is found.
// Why we check for `src/repl/main-bootstrap.ts` (and NOT just `src/repl/`):
// tsc with `include: '../src/repl/ipc/**/*'` emits `dist/src/repl/ipc/...`
// at the desktop dist root, so a naive `src/repl` existence check matches
// the dist tree at `agent/desktop/dist/` and resolves the wrong root —
// agentRequire would then look for `agent/desktop/dist/src/repl/main-bootstrap`
// which does NOT exist (main-bootstrap is loaded via tsx/cjs from source,
// never compiled). The .ts marker is unique to the agent source tree.
function findAgentRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'repl', 'main-bootstrap.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`agent root (with src/repl/main-bootstrap.ts) not found from ${start}`);
}
const AGENT_ROOT = findAgentRoot(__dirname);
const AGENT_REPL_DIR = path.join(AGENT_ROOT, 'src', 'repl');
function agentRequire<T = any>(rel: string): T {
  return require(path.join(AGENT_REPL_DIR, rel));
}

// ── Desktop-shell asset anchors ─────────────────────────────────────────
// __dirname here at runtime = `<repo>/agent/desktop/dist/desktop/products/<product>/`.
// preload.js lives 2 levels up (sibling of dist/desktop/main.js), the Vite
// build output (`dist/renderer/index.html`) is 3 levels up. We pin these
// anchors once instead of sprinkling `path.join(__dirname, '..', '..')`
// across the file (and breaking again the next time the file moves).
const DESKTOP_DIST_DIR = path.join(__dirname, '..', '..');
const DESKTOP_SOURCE_DIR = path.join(AGENT_ROOT, 'desktop');

// ── Diagnostic log — written to ~/.makestudio/electron-events.log ────────
// One JSONL line per IPC handler we want to trace. Used to debug "the chat
// disappears when I navigate away during generation" type bugs without
// needing the user to share terminal output.
const os = require('os');
const diagLogPath = path.join(os.homedir(), '.makestudio', 'electron-events.log');
function diagLog(msg: string, extra?: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }) + '\n';
    fs.mkdirSync(path.dirname(diagLogPath), { recursive: true });
    fs.appendFileSync(diagLogPath, line);
  } catch { /* */ }
}

// CRÍTICO: broadcast.ts e channels.ts precisam vir do MESMO module instance
// que o agent code usa. Se importássemos via `import ... from '../../src/repl/...'`,
// o tsc compilaria pra `require('../../src/repl/ipc/broadcast')` resolvendo no
// `dist/src/repl/ipc/broadcast.js` (gerado pelo include do tsconfig). O agent
// code (carregado por tsx/cjs) requer o `.ts` source — outra instância. Aí
// `setBroadcaster()` rodava num module e `broadcast()` no outro, com
// `broadcaster` null no segundo, e NENHUM EVT_* chegava no renderer.
const { setBroadcaster, broadcast } =
  agentRequire<typeof import('../../src/repl/ipc/broadcast')>('ipc/broadcast');
const CH =
  agentRequire<typeof import('../../src/repl/ipc/channels')>('ipc/channels');

// ── Single-instance ─────────────────────────────────────────────────────
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Agent reference — populated after bootAgent resolves ────────────────
interface AgentRuntime {
  ctx: any;
  shutdown: () => Promise<void>;
}
let agent: AgentRuntime | null = null;
let agentBootError: Error | null = null;
/** True após o primeiro `ctx.initialize()` ter rodado com sucesso.
 *  Permite que AUTH_LOGIN dispare initialize tardio quando o user
 *  loga via UI depois do boot ter pulado initialize por falta de auth. */
let agentInitialized = false;

// ── Window / tray ───────────────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'MakeStudio Code',
    show: false,
    backgroundColor: '#0C0A08',
    titleBarStyle: 'hiddenInset',
    // Linux/Windows: hide the native menu bar ("Arquivo Editar Visualizar
    // Janela") — it competes visually with the in-app sidebar/header. The
    // menu is still BUILT (so accelerators like CmdOrCtrl+N for "Novo
    // bate-papo" / Ctrl+= zoom keep working) but never rendered. macOS is
    // unaffected: the menu lives on the system bar there. autoHideMenuBar
    // also blocks Alt from popping the bar back open momentarily.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DESKTOP_DIST_DIR, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  const dataDir = process.env.MAKESTUDIO_DATA_DIR ?? path.join(require('os').homedir(), '.makestudio');
  const settingsJsonPath = path.join(dataDir, 'settings.json');
  // The auto-uiScale heuristic that lived here applied a 1.05–1.20 zoom
  // factor on smaller displays, which inflated the layout enough that
  // the sidebar (260px) plus the main content overflowed the viewport
  // and the renderer cropped chunks of the chrome (sidebar text, AD
  // avatar, etc.) instead of reflowing. We let CSS handle small screens
  // now — the renderer auto-collapses the sidebar under ~900px viewport.
  // User-set `uiScale` in settings.json is still honoured below.

  mainWindow.once('ready-to-show', () => {
    // Apply persisted uiScale as Electron zoom factor — survives CSS zoom
    // so native Ctrl+0 / Ctrl+= / Ctrl+- work as escape hatches.
    try {
      if (fs.existsSync(settingsJsonPath)) {
        const raw = JSON.parse(fs.readFileSync(settingsJsonPath, 'utf8'));
        const scale = typeof raw.uiScale === 'number' ? raw.uiScale : 1.0;
        mainWindow?.webContents.setZoomFactor(Math.min(2.0, Math.max(0.5, scale)));
      }
    } catch { /* ignore */ }
    mainWindow?.show();
  });

  // Auto-detect: se Vite dev server estiver rodando em :3002, carrega URL;
  // senão cai no dist/renderer/index.html (vite build); senão mostra
  // mensagem explicativa em data URL ao invés de travar a janela.
  loadRendererInto(mainWindow).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[main] loadRenderer failed', err);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── Context menu (botão direito) ─────────────────────────────────────
  // Detecta se o clique foi em input editável, texto selecionado, link,
  // ou imagem, e monta o menu com as opções adequadas.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const { editFlags } = params;
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.hasImageContents) {
      template.push(
        {
          label: 'Copiar imagem',
          click: () => mainWindow?.webContents.copyImageAt(params.x, params.y),
        },
        {
          label: 'Salvar imagem como...',
          click: () => mainWindow?.webContents.downloadURL(params.srcURL),
        },
        { type: 'separator' },
      );
    }

    if (params.linkURL) {
      template.push(
        { label: 'Abrir link', click: () => shell.openExternal(params.linkURL) },
        {
          label: 'Copiar link',
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: 'separator' },
      );
    }

    if (params.isEditable) {
      if (editFlags.canUndo) template.push({ label: 'Desfazer', role: 'undo' });
      if (editFlags.canRedo) template.push({ label: 'Refazer', role: 'redo' });
      if (editFlags.canUndo || editFlags.canRedo) template.push({ type: 'separator' });
      template.push(
        { label: 'Recortar', role: 'cut', enabled: editFlags.canCut },
        { label: 'Copiar', role: 'copy', enabled: editFlags.canCopy },
        { label: 'Colar', role: 'paste', enabled: editFlags.canPaste },
        { label: 'Selecionar tudo', role: 'selectAll' },
      );
    } else {
      // Não editável: SEMPRE oferece Copiar + Selecionar tudo. Copiar fica
      // desabilitado se o navegador diz que não há seleção, mas o item
      // permanece visível — antes o menu sumia silenciosamente quando
      // params.selectionText voltava vazio (acontece em alguns casos no
      // Wayland mesmo com texto selecionado), e o usuário ficava sem
      // forma de acessar o "Copiar" via mouse.
      template.push(
        { label: 'Copiar', role: 'copy', enabled: editFlags.canCopy },
        { label: 'Selecionar tudo', role: 'selectAll' },
      );
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow! });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function isViteRunning(timeoutMs = 1500): Promise<boolean> {
  // Usa `localhost` em vez de `127.0.0.1` — Vite v8 no Linux costuma bindar
  // em `::1` (IPv6) quando `host: 'localhost'` resolve dual-stack. Probe via
  // `localhost` resolve igual, então pega tanto IPv4 quanto IPv6. Sem isso o
  // Electron não detecta o Vite e cai no dist/renderer/ antigo (cache stale).
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http');
    const req = http.get({ host: 'localhost', port: 3002, timeout: timeoutMs }, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function loadRendererInto(win: BrowserWindow): Promise<void> {
  // Probe Vite com retry — se o Electron sobe junto/antes do Vite, dá tempo dele
  // ficar pronto antes de cair no dist antigo.
  let viteUp = await isViteRunning();
  for (let i = 0; !viteUp && i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    viteUp = await isViteRunning();
  }
  if (viteUp) {
    await win.loadURL('http://localhost:3002');
    return;
  }
  const indexPath = path.join(DESKTOP_DIST_DIR, '..', 'renderer', 'index.html');
  if (fs.existsSync(indexPath)) {
    await win.loadFile(indexPath);
    return;
  }
  // Nem vite rodando, nem build feito — mostra página de instrução.
  const fallback = `
    <html>
      <head><meta charset="utf-8" /><title>MakeStudio Code</title>
      <style>
        body { margin:0; background:#0C0A08; color:#F5F3EF; font:14px/1.6 system-ui,sans-serif;
               display:flex; align-items:center; justify-content:center; height:100vh; }
        .c { max-width:520px; padding:32px; border:1px solid #332E28; border-radius:14px;
             background:#131110; box-shadow: 0 16px 48px -16px rgba(0,0,0,0.55); }
        h1 { margin:0 0 12px; font-size:18px; font-weight:600; color:#D77757; letter-spacing:-0.01em; }
        code { background:#1A1814; padding:2px 6px; border-radius:4px; color:#E8A284;
               font-family:'JetBrains Mono',monospace; font-size:12px; }
        p { margin:0 0 10px; color:#D9D5CD; }
        ol { margin:10px 0 0; padding-left:20px; color:#D9D5CD; }
        li { margin-bottom:6px; }
      </style></head>
      <body><div class="c">
        <h1>Renderer não está disponível</h1>
        <p>Nem o dev server do Vite (<code>http://localhost:3002</code>) nem o build de produção (<code>dist/renderer</code>) foram encontrados.</p>
        <ol>
          <li><strong>Dev:</strong> em outro terminal, <code>cd agent/desktop && npx vite</code>, depois reabra esta janela.</li>
          <li><strong>Build:</strong> <code>cd agent/desktop && npx vite build</code> e reabra.</li>
        </ol>
      </div></body>
    </html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallback)}`);
}

function createTray(): void {
  try {
    const iconPath = path.join(DESKTOP_SOURCE_DIR, 'assets', 'tray-icon.png');
    const icon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
      : nativeImage.createEmpty();
    tray = new Tray(icon);
    const showWindow = () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else createWindow();
    };
    const menu = Menu.buildFromTemplate([
      { label: 'Mostrar janela', click: showWindow },
      {
        label: 'Novo bate-papo',
        click: () => {
          showWindow();
          mainWindow?.webContents.send(CH.EVT_NAVIGATE, { path: '/' });
        },
      },
      {
        label: 'Abrir projetos',
        click: () => {
          showWindow();
          mainWindow?.webContents.send(CH.EVT_NAVIGATE, { path: '/projects' });
        },
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]);
    tray.setToolTip('MakeStudio Code');
    tray.setContextMenu(menu);
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else createWindow();
    });
  } catch {
    /* optional */
  }
}

// ═══════════════════════════════════════════════════════════════════════
// IPC handlers — todos falam com ctx real via bridge. Se bootAgent falhou,
// respondem com erro descritivo em vez de crashar.
// ═══════════════════════════════════════════════════════════════════════

function requireAgent(): AgentRuntime | null {
  if (agent) return agent;
  if (agentBootError && mainWindow) {
    broadcast(CH.EVT_MESSAGE_ADD, {
      id: `err-${Date.now()}`,
      role: 'error',
      text: `Agent não iniciado: ${agentBootError.message}`,
      timestamp: Date.now(),
    });
  }
  return null;
}

function buildAgentState(): AgentState {
  const a = agent;
  if (!a) {
    return {
      busy: false,
      busyLabel: '',
      contextPct: 0,
      currentTool: null,
      lastTool: null,
      agentSummary: null,
      streamTokens: 0,
      model: agentBootError ? `erro: ${agentBootError.message.slice(0, 40)}` : null,
      provider: null,
      totalTokens: 0,
      cacheReads: 0,
      messagesCount: 0,
      importedRules: false,
      autoApprove: false,
      permissionMode: 'default',
      coordinatorActive: false,
      cwd: process.env.HOME || '/',
      activeSessionId: null,
    };
  }

  const ctx = a.ctx;
  const { getTuiBridge, getCurrentTool, getLastTool, getAgentSummary, getStreamTokens } =
    agentRequire('tui/bridge');
  const bridge = getTuiBridge();

  // Context pct — copiado da lógica do StatusLine TUI
  let contextPct = 0;
  try {
    const systemTokens = Math.ceil(ctx.buildSystemPrompt().length / 4);
    const msgTokens = ctx.messages.reduce((s: number, m: any) => {
      const contentLen =
        typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
      return s + Math.ceil(contentLen / 4);
    }, 0);
    const total = systemTokens + msgTokens;
    const model = (ctx.providerInfo?.model || '').toLowerCase();
    let maxCtx = 128_000;
    if (model.includes('claude')) maxCtx = 200_000;
    else if (model.includes('gemini')) maxCtx = 1_000_000;
    contextPct = (total / maxCtx) * 100;
  } catch {
    /* */
  }

  const msgsCount = bridge?.getMessagesSnapshot?.()?.length ?? ctx.messages.length;

  return {
    busy: false, // busy é push-only; renderer sincroniza via EVT_BUSY
    busyLabel: '',
    contextPct,
    currentTool: getCurrentTool(),
    lastTool: getLastTool(),
    agentSummary: getAgentSummary(),
    streamTokens: getStreamTokens(),
    model: ctx.providerInfo?.model || null,
    provider: ctx.providerInfo?.provider || null,
    totalTokens: (ctx.usage?.totalTokens as number) ?? 0,
    cacheReads: (ctx.usage?.cacheReads as number) ?? 0,
    messagesCount: msgsCount,
    importedRules: Boolean(ctx.importedRules),
    autoApprove: Boolean(ctx.autoApprove),
    permissionMode: ctx.permissionMode || 'default',
    coordinatorActive: Boolean(ctx.coordinatorActive),
    cwd: ctx.cwd,
    activeSessionId: (ctx as any).sessionId || null,
  };
}

function registerIpcHandlers(): void {
  // ── agent:state / messages / completions ────────────────────────────
  ipcMain.handle(CH.AGENT_STATE, () => buildAgentState());

  ipcMain.handle(CH.AGENT_MESSAGES, (): TuiMessageDTO[] => {
    if (!agent) return [];
    const { getMessagesSnapshot } = agentRequire('tui/electron-bridge');
    return getMessagesSnapshot();
  });

  ipcMain.handle(CH.AGENT_COMPLETIONS, (_e, prefix: string) => {
    if (!agent || !prefix?.startsWith('/')) return [];
    try {
      const { getCompletions } = agentRequire('tui/completions');
      return getCompletions(prefix, agent.ctx) as string[];
    } catch {
      return [];
    }
  });

  // ── agent:submit — fire-and-forget ──────────────────────────────────
  // Retorna imediato após enfileirar; turn roda em background e publica
  // seu progresso via eventos push. Mantém o invoke do renderer rápido.
  let turnInflight = false;
  ipcMain.handle(CH.AGENT_SUBMIT, async (_e: IpcMainInvokeEvent, text: string) => {
    diagLog('AGENT_SUBMIT invoked', { textPreview: text.slice(0, 60), turnInflight });
    const a = requireAgent();
    if (!a) return { ok: false, error: agentBootError?.message || 'agent not ready' };
    if (typeof text !== 'string' || !text.trim()) return { ok: false };
    const trimmed = text.trim();

    const { expandPasteMarkers, consumePendingAnswer } = agentRequire('tui/bridge');
    const expanded = expandPasteMarkers(trimmed);

    // AskUserQuestion: próxima submissão é a resposta, não vai pro chat.
    if (consumePendingAnswer(expanded)) {
      return { ok: true, consumedAsAnswer: true };
    }

    // Race guard — se já tem um turn rodando, recusa explicitamente.
    // O renderer previne isso via `busy` state, mas network/IPC lag pode
    // driblar. Cliente deve abort manualmente (Esc Esc) antes de resubmeter.
    if (turnInflight) {
      return { ok: false, error: 'busy' };
    }
    turnInflight = true;

    // setBusy(true) ANTES do turn — alimenta EVT_BUSY no renderer (botão
    // stop, busy lock no input) e EVT_CONTEXT_PCT (recompute do %).
    // Equivalente ao runTurn() do TUI App.tsx que envolve routeInputTui
    // com setBusyFn(true)/setBusyFn(false). Sem isto o turn roda mas
    // a UI não reflete o estado de "rodando".
    const label = expanded.startsWith('/')
      ? `executing ${expanded.split(' ')[0]}...`
      : 'thinking...';
    const { getTuiBridge } = agentRequire('tui/bridge');
    getTuiBridge()?.setBusy(true, label);

    // Fire-and-forget — erros viram mensagens no chat, não rejeição do invoke.
    const { routeInputWeb } = agentRequire('web-router');
    routeInputWeb(expanded, a.ctx)
      .catch((err: any) => {
        broadcast(CH.EVT_MESSAGE_ADD, {
          id: `err-${Date.now()}`,
          role: 'error',
          text: err?.message || String(err),
          timestamp: Date.now(),
        });
      })
      .finally(() => {
        getTuiBridge()?.setBusy(false, '');
        turnInflight = false;
      });

    return { ok: true };
  });

  ipcMain.handle(CH.AGENT_ABORT, () => {
    const a = agent;
    if (!a) return { aborted: false };
    const controller = a.ctx.currentAbortController as AbortController | null;
    let aborted = false;
    if (controller && !controller.signal.aborted) {
      controller.abort('interrupt');
      aborted = true;
    }
    // Defensive: clear the inflight flag and busy state immediately so a
    // hung stream can't keep blocking new submits even if the upstream
    // .finally() takes a while (or never runs because the fetch reader is
    // wedged at OS level). The abort signal still fires for the streaming
    // layer; this just unblocks the user.
    turnInflight = false;
    try {
      const { getTuiBridge } = agentRequire('tui/bridge');
      getTuiBridge()?.setBusy(false, '');
    } catch { /* */ }
    return { aborted };
  });

  ipcMain.handle(CH.AGENT_CLEAR, () => {
    diagLog('AGENT_CLEAR invoked', { stack: new Error().stack?.split('\n').slice(2, 5).join(' | ') });
    const a = agent;
    if (!a) return { ok: false };
    try {
      a.ctx.clearConversation();
    } catch {
      /* */
    }
    // Desbinda a session file pra que a próxima mensagem crie um arquivo
    // novo. Sem isto, "Novo bate-papo" depois de um resume continua
    // appending no mesmo .jsonl da sessão anterior — vira merge, não
    // sessão nova.
    try {
      const { unbindSessionFile } = agentRequire('sessions');
      unbindSessionFile(a.ctx);
    } catch {
      /* */
    }
    const { getTuiBridge } = agentRequire('tui/bridge');
    const bridge = getTuiBridge();
    bridge?.clearMessages();
    return { ok: true };
  });

  // ── Paste store ─────────────────────────────────────────────────────
  ipcMain.handle(CH.AGENT_STORE_PASTE, (_e, text: string) => {
    const { storePastedText } = agentRequire('tui/bridge');
    return storePastedText(text);
  });

  ipcMain.handle(CH.AGENT_EXPAND_PASTE, (_e, value: string) => {
    const { expandPasteMarkers } = agentRequire('tui/bridge');
    return expandPasteMarkers(value);
  });

  // ── Attachments: list files for @file completion ────────────────────
  ipcMain.handle(
    CH.ATTACHMENTS_LIST_FILES,
    (
      _e,
      payload: { query?: string; limit?: number } | string | undefined,
    ) => {
      const a = agent;
      if (!a) return [];
      const query =
        typeof payload === 'string'
          ? payload
          : ((payload?.query ?? '') as string);
      const limit =
        typeof payload === 'object' && payload && typeof payload.limit === 'number'
          ? payload.limit
          : 30;
      const cwd: string = a.ctx.cwd;
      try {
        return listProjectFiles(cwd, query, limit);
      } catch {
        return [];
      }
    },
  );

  // ── Attachments: store image buffer (from clipboard / drag-drop) ────
  ipcMain.handle(
    CH.ATTACHMENTS_STORE_IMAGE,
    (
      _e,
      payload: { data: ArrayBuffer | Uint8Array | Buffer; mime?: string },
    ) => {
      try {
        const { attachImageBuffer } = agentRequire('image-paste');
        const raw = payload?.data;
        if (!raw) return { ok: false, error: 'no data' };
        const buf =
          raw instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(raw))
            : Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(raw as Uint8Array);
        const mime = payload?.mime || 'image/png';
        const att = attachImageBuffer(buf, mime);
        return { ok: true, id: att.id, mime: att.mime, bytes: att.bytes };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  // ── Attachments: store from a file path (drag-drop file) ────────────
  ipcMain.handle(
    CH.ATTACHMENTS_STORE_FILE_PATH,
    async (_e, payload: { path: string }) => {
      const filePath = payload?.path;
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, kind: 'unsupported', error: 'no path' };
      }
      try {
        const { attachImageFile } = agentRequire('image-paste');
        const ext = path.extname(filePath).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
        if (isImage) {
          const att = attachImageFile(filePath);
          if (!att) return { ok: false, kind: 'image', error: 'unreadable' };
          return { ok: true, kind: 'image', id: att.id, mime: att.mime, bytes: att.bytes };
        }
        // Texto: lê com cap de 2MB pra não acidentalmente engolir binários.
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024) {
          return { ok: false, kind: 'unsupported', error: 'file too large' };
        }
        const text = fs.readFileSync(filePath, 'utf8');
        const { storePastedText } = agentRequire('tui/bridge');
        const ref = storePastedText(text);
        return {
          ok: true,
          kind: 'text',
          id: ref.id,
          lines: ref.lines,
          name: path.basename(filePath),
        };
      } catch (err: any) {
        return { ok: false, kind: 'unsupported', error: err?.message || String(err) };
      }
    },
  );

  // ── RPC resolves — respostas vindas do renderer pra prompts main-side
  ipcMain.on(CH.AGENT_PICKER_RESOLVE, (_e, value: unknown) => {
    const { consumePickerResult } = agentRequire('tui/bridge');
    consumePickerResult(value);
  });

  ipcMain.on(CH.AGENT_PERMISSION_RESOLVE, (_e, choice: PermissionChoice) => {
    const { consumePermissionResult } = agentRequire('tui/bridge');
    consumePermissionResult(choice);
  });

  ipcMain.on(CH.AGENT_QUESTION_RESOLVE, (_e, answer: string) => {
    const { consumePendingAnswer } = agentRequire('tui/bridge');
    consumePendingAnswer(answer);
  });

  ipcMain.handle(CH.AGENT_SUGGESTION_CONSUME, () => {
    const { consumePendingSuggestion } = agentRequire('tui/bridge');
    return consumePendingSuggestion();
  });

  // ── Phase 5 — Sessions ───────────────────────────────────────────────
  ipcMain.handle(
    CH.SESSIONS_LIST,
    (_e, args?: { cwd?: string; limit?: number }) => {
      const ctx = requireAgent()?.ctx;
      const cwd = args?.cwd ?? ctx?.cwd ?? process.cwd();
      const sessions = agentRequire('sessions').listSessions(cwd, args?.limit);
      return sessions.map(sessionToDTO);
    },
  );

  ipcMain.handle(
    CH.SESSIONS_RESUME,
    (_e, args: { sessionId: string }) => {
      const a = requireAgent();
      if (!a) return { ok: false, error: 'agent not ready' };
      const ctx = a.ctx;
      const sessions = agentRequire('sessions');

      // Defense-in-depth: if the requested session is ALREADY the one ctx
      // is bound to, do NOT wipe ctx.messages or rebroadcast historic msgs.
      // The active turn (if any) is still streaming into the bridge — a
      // wipe would erase the user's in-flight message and the partial
      // assistant response, leaving an empty chat until the next reload.
      // This catches the case where the renderer's `activeId` is out of
      // sync (e.g. the new-session broadcast didn't reach the sidebar).
      const currentFile = sessions.currentSessionFile(ctx);
      const currentId = currentFile ? path.basename(currentFile, '.jsonl') : null;
      diagLog('SESSIONS_RESUME invoked', {
        requested: args.sessionId,
        currentFile,
        currentId,
        sameSession: currentId === args.sessionId,
        ctxMessageCount: ctx.messages.length,
        turnInflight,
      });
      if (currentFile && currentId === args.sessionId) {
        return {
          ok: true,
          sessionId: args.sessionId,
          title: undefined,
          messageCount: ctx.messages.length,
          sameSession: true,
        };
      }

      const found = sessions.loadById(ctx.cwd, args.sessionId);
      if (!found) return { ok: false, error: 'session not found' };
      let messages: any[] = [];
      try { messages = sessions.loadSessionMessages(found.file); } catch {
        return { ok: false, error: 'failed to load session messages' };
      }
      // Substitui ctx.messages pelo histórico carregado e binda o file
      // para que appendMessage subsequentes anexem na MESMA sessão.
      ctx.messages.length = 0;
      for (const m of messages) ctx.messages.push(m);
      sessions.bindSessionFile(ctx, found.file);
      // Reconstrói o transcript no renderer: limpa e reemite cada msg
      // como TuiMessage (user/assistant text-only — tool calls do
      // passado ficam no contexto LLM mas não no transcript visível;
      // historic tool replay é Fase 5+ refinement).
      const { getTuiBridge } = agentRequire('tui/bridge');
      const bridge = getTuiBridge();
      bridge?.clearMessages();
      for (const m of messages) {
        const role = m.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .filter((b: any) => b?.type === 'text')
                  .map((b: any) => b.text)
                  .join('\n')
              : '';
        if (!text.trim()) continue;
        bridge?.addMessage({ role, text });
      }
      return {
        ok: true,
        sessionId: found.sessionId,
        title: found.title,
        messageCount: messages.length,
      };
    },
  );

  ipcMain.handle(
    CH.SESSIONS_OPEN,
    (_e, args: { sessionId: string }) => {
      const ctx = requireAgent()?.ctx;
      if (!ctx) return { messages: [] };
      const cwd = ctx.cwd;
      const found = agentRequire('sessions').loadById(cwd, args.sessionId);
      if (!found) return { messages: [], error: 'not found' };
      const messages = agentRequire('sessions').loadSessionMessages(found.file);
      return { messages, file: found.file, summary: sessionToDTO(found) };
    },
  );

  ipcMain.handle(
    CH.SESSIONS_FORK,
    (_e, args?: { title?: string }) => {
      const ctx = requireAgent()?.ctx;
      if (!ctx) return { ok: false, error: 'no agent' };
      const result = agentRequire('sessions').forkSession(ctx, args?.title);
      return result
        ? { ok: true, sessionId: result.sessionId, file: result.file }
        : { ok: false, error: 'fork failed' };
    },
  );

  ipcMain.handle(
    CH.SESSIONS_RENAME,
    (_e, args: { file: string; title: string }) => {
      const ok = agentRequire('sessions').renameSession(args.file, args.title);
      if (ok) {
        broadcast(CH.EVT_SESSIONS_UPDATED, {
          reason: 'manual-rename',
          file: args.file,
          title: args.title,
        });
      }
      return { ok };
    },
  );

  ipcMain.handle(
    CH.SESSIONS_TAG,
    (_e, args: { file: string; tags: string[] }) => ({
      ok: agentRequire('sessions').setSessionTags(args.file, args.tags),
    }),
  );

  ipcMain.handle(
    CH.SESSIONS_DELETE,
    (_e, args: { file: string }) => {
      try {
        fs.unlinkSync(args.file);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.SESSIONS_EXPORT,
    (_e, args: { file: string; format: 'md' | 'json' }) => {
      try {
        const messages = agentRequire('sessions').loadSessionMessages(args.file);
        const base = path.basename(args.file).replace(/\.jsonl$/, '');
        if (args.format === 'json') {
          return {
            content: JSON.stringify(messages, null, 2),
            filename: `${base}.json`,
          };
        }
        const md = messagesToMarkdown(messages);
        return { content: md, filename: `${base}.md` };
      } catch (err) {
        return { content: '', filename: '', error: String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.SESSIONS_SEARCH,
    async (
      _e,
      args: { query: string; mode?: 'literal' | 'semantic'; cwd?: string },
    ) => {
      const ctx = requireAgent()?.ctx;
      const cwd = args.cwd ?? ctx?.cwd ?? process.cwd();
      try {
        const ss = agentRequire('session-search');
        const fn =
          args.mode === 'semantic'
            ? ss.searchSemantic ?? ss.search
            : ss.searchLiteral ?? ss.search;
        const results = await fn(cwd, args.query);
        return Array.isArray(results) ? results.map(sessionToDTO) : [];
      } catch {
        // fallback: literal substring sobre listSessions
        const all = agentRequire('sessions').listSessions(cwd);
        const q = args.query.toLowerCase();
        return all
          .filter((s: any) =>
            (s.title ?? '').toLowerCase().includes(q) ||
            (s.summary ?? '').toLowerCase().includes(q),
          )
          .map(sessionToDTO);
      }
    },
  );

  // ── Phase 5 — Rewind ─────────────────────────────────────────────────
  ipcMain.handle(CH.REWIND_LIST, () => {
    const ctx = requireAgent()?.ctx;
    if (!ctx) return [];
    const checkpoints = agentRequire('rewind').listCheckpoints(ctx);
    return checkpoints.map(checkpointToDTO);
  });

  ipcMain.handle(
    CH.REWIND_RESTORE,
    (_e, args: { turn: number }) => {
      const ctx = requireAgent()?.ctx;
      if (!ctx) return { error: 'no agent' };
      return agentRequire('rewind').rewindToTurn(ctx, args.turn);
    },
  );

  ipcMain.handle(CH.REWIND_CLEAR, () => {
    const ctx = requireAgent()?.ctx;
    if (!ctx) return { removed: 0 };
    return agentRequire('rewind').clearCheckpoints(ctx);
  });

  // ── Phase 5 — File history ───────────────────────────────────────────
  ipcMain.handle(
    CH.FILE_HISTORY_LIST,
    (_e, args: { path: string }) => {
      const ctx = requireAgent()?.ctx;
      const cwd = ctx?.cwd ?? process.cwd();
      const snaps = agentRequire('file-history').listFileHistory(cwd, args.path);
      return snaps.map(snapshotToDTO);
    },
  );

  ipcMain.handle(
    CH.FILE_HISTORY_RESTORE,
    (_e, args: { path: string; index?: number }) => {
      const ctx = requireAgent()?.ctx;
      const cwd = ctx?.cwd ?? process.cwd();
      return agentRequire('file-history').restoreFile(cwd, args.path, args.index);
    },
  );

  ipcMain.handle(CH.FILE_HISTORY_CLEAR, () => {
    const ctx = requireAgent()?.ctx;
    const cwd = ctx?.cwd ?? process.cwd();
    agentRequire('file-history').clearFileHistory(cwd);
    return { ok: true };
  });

  // ── Phase 5 — Cassettes ──────────────────────────────────────────────
  ipcMain.handle(CH.CASSETTES_LIST, () => {
    const list = agentRequire('cassettes').listCassettes();
    return list.map((c: any) => ({
      name: c.name,
      path: c.path,
      recordedAt:
        typeof c.recordedAt === 'string'
          ? c.recordedAt
          : new Date(c.recordedAt).toISOString(),
      turns: c.turns,
      sizeBytes: c.sizeBytes,
    }));
  });

  ipcMain.handle(
    CH.CASSETTES_REPLAY,
    (_e, args: { name: string }) => {
      const ctx = requireAgent()?.ctx;
      if (!ctx) return { turns: 0, error: 'no agent' };
      const turns = agentRequire('cassettes').replayCassette(ctx, args.name);
      return { turns };
    },
  );

  ipcMain.handle(
    CH.CASSETTES_RECORD_START,
    (_e, args: { name: string }) => {
      const ctx = requireAgent()?.ctx;
      if (!ctx) return { ok: false, error: 'no agent' };
      try {
        agentRequire('cassettes').startRecording(ctx, args.name);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(CH.CASSETTES_RECORD_STOP, () => {
    const ctx = requireAgent()?.ctx;
    if (!ctx) return { path: '', error: 'no agent' };
    try {
      const filePath = agentRequire('cassettes').stopRecording(ctx);
      return { path: filePath };
    } catch (err) {
      return { path: '', error: String(err) };
    }
  });

  // ── Phase 6 — Memory ─────────────────────────────────────────────────
  ipcMain.handle(CH.MEMORY_LIST, () => {
    const topics = agentRequire('memory').loadAllTopics();
    return topics.map(memoryToDTO);
  });

  ipcMain.handle(
    CH.MEMORY_GET,
    (_e, args: { name: string }) => {
      const topics = agentRequire('memory').loadAllTopics();
      const t = topics.find((x: any) => x.name === args.name);
      if (!t) return { topic: null };
      return {
        topic: {
          name: t.name,
          description: t.description,
          type: t.type,
          tags: t.tags,
          body: t.body,
          accessCount: t.accessCount,
          lastAccessedAt: t.lastAccessedAt,
        },
      };
    },
  );

  ipcMain.handle(
    CH.MEMORY_SAVE,
    (
      _e,
      args: {
        name: string;
        body: string;
        tags?: string[];
        type?: 'user' | 'feedback' | 'project' | 'reference';
        description?: string;
      },
    ) => {
      try {
        agentRequire('memory').saveTopic({
          name: args.name,
          body: args.body,
          tags: args.tags ?? [],
          type: args.type,
          description: args.description,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.MEMORY_DELETE,
    (_e, args: { name: string }) => ({
      ok: agentRequire('memory').deleteTopic(args.name),
    }),
  );

  ipcMain.handle(CH.MEMORY_REBUILD, () => {
    agentRequire('memory').regenerateIndex();
    return { ok: true };
  });

  ipcMain.handle(
    CH.MEMORY_SIMILAR,
    (_e, args?: { threshold?: number }) => {
      const pairs = agentRequire('memory').findSimilarTopics(args?.threshold);
      return pairs.map((p: any) => ({
        a: p.a.name,
        b: p.b.name,
        similarity: p.similarity,
      }));
    },
  );

  // ── Phase 11 (antecipado) — Auth ─────────────────────────────────────
  ipcMain.handle(CH.AUTH_STATUS, () => buildAuthStatus());

  ipcMain.handle(
    CH.AUTH_LOGIN,
    async (
      _e,
      args: { email: string; password: string; serverUrl?: string },
    ) => {
      try {
        const { login } = agentRequire('../network/api-client');
        const { loadConfig } = agentRequire('../config/config');
        const cfg = loadConfig() ?? {};
        const serverUrl =
          args.serverUrl?.trim() ||
          cfg.serverUrl ||
          'https://api.zielinski.dev.br';
        await login(args.email, args.password, serverUrl);
        // Initialize tardio do ctx se o boot pulou por falta de auth.
        if (agent && !agentInitialized) {
          try {
            await agent.ctx.initialize();
            agentInitialized = true;
            // TransientStatus auto-some — não polui o transcript.
            broadcast(CH.EVT_TRANSIENT_STATUS, {
              text: 'agente pronto',
              ttlMs: 3500,
              setAt: Date.now(),
            });
          } catch (initErr: any) {
            // Falha aqui é importante — vai pro chat como erro permanente.
            broadcast(CH.EVT_MESSAGE_ADD, {
              id: `auth-init-err-${Date.now()}`,
              role: 'error',
              text: `Falha ao inicializar contexto: ${initErr?.message ?? initErr}`,
              timestamp: Date.now(),
            });
          }
        }
        const status = buildAuthStatus();
        broadcast(CH.EVT_AUTH_CHANGED, status);
        return { ok: true, status };
      } catch (err: any) {
        const message =
          err?.response?.data?.message ??
          err?.message ??
          'Falha no login';
        return { ok: false, error: String(message) };
      }
    },
  );

  ipcMain.handle(CH.AUTH_LOGOUT, () => {
    try {
      const { clearConfig } = agentRequire('../config/config');
      clearConfig();
      try {
        agentRequire('../network/ws-client').disconnectWebSocket?.();
      } catch {
        /* */
      }
      const status = buildAuthStatus();
      broadcast(CH.EVT_AUTH_CHANGED, status);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle(CH.AUTH_REFRESH, async () => {
    try {
      const { refreshAuthToken } = agentRequire('../network/api-client');
      const ok = await refreshAuthToken();
      if (ok) broadcast(CH.EVT_AUTH_CHANGED, buildAuthStatus());
      return { ok: Boolean(ok) };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle(CH.AUTH_HEARTBEAT, (): import('../../src/repl/ipc/types').LicenseInfoDTO | null => {
    const { getLastHeartbeat } = agentRequire('../network/heartbeat');
    const hb = getLastHeartbeat() as {
      response: { license?: any } | null;
      at: number | null;
      nextAt: number | null;
    };
    if (!hb.response?.license) return null;
    return {
      valid: Boolean(hb.response.license.valid),
      reason: hb.response.license.reason,
      plan: hb.response.license.plan,
      seats: hb.response.license.seats,
      tasks: hb.response.license.tasks,
      lastHeartbeatAt: hb.at ?? undefined,
      nextHeartbeatAt: hb.nextAt ?? undefined,
    };
  });

  // ── Phase 11 — Providers ─────────────────────────────────────────────

  ipcMain.handle(CH.PROVIDERS_CATALOG, (): import('../../src/repl/ipc/types').ProvidersSnapshotDTO => {
    return buildProvidersSnapshot();
  });

  ipcMain.handle(
    CH.PROVIDERS_SET,
    async (
      _e,
      args: import('../../src/repl/ipc/types').ProvidersSetRequestDTO,
    ): Promise<import('../../src/repl/ipc/types').ProvidersSnapshotDTO> => {
      const { overrideEntry, clearOverride, fetchCatalog } = agentRequire('ai/providers/catalog');
      const { setProviderKey, removeProviderKey } = agentRequire('../config/credentials');

      if (args.key) {
        const providerName = String(args.key.provider ?? '').trim();
        if (!providerName || /[^a-zA-Z0-9._-]/.test(providerName)) {
          throw new Error('Invalid provider name');
        }
        if (args.key.remove) {
          removeProviderKey(providerName);
        } else if (typeof args.key.key === 'string' && args.key.key.trim()) {
          setProviderKey(providerName, args.key.key.trim());
        }
      }
      if (args.catalog) {
        overrideEntry(args.catalog.tier, {
          provider: args.catalog.provider,
          model: args.catalog.model,
          baseURL: args.catalog.baseUrl,
          maxOutputTokens: args.catalog.maxOutputTokens,
        });
      }
      if (args.resetCatalogTier) {
        clearOverride(args.resetCatalogTier);
      }
      if (args.refreshFromServer) {
        try { await fetchCatalog({ force: true }); } catch { /* swallow — partial OK */ }
      }
      const snapshot = buildProvidersSnapshot();
      broadcast(CH.EVT_PROVIDERS_CHANGED, snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(CH.PROVIDERS_COSTS, (): import('../../src/repl/ipc/types').ProviderCostBreakdownDTO[] => {
    return buildProviderCosts();
  });

  ipcMain.handle(
    CH.PROVIDERS_EFFORT_SET,
    (_e, args: { level: 'low' | 'medium' | 'high' | 'max' }): import('../../src/repl/ipc/types').ProvidersSnapshotDTO => {
      const { saveSettings } = agentRequire('settings');
      saveSettings({ effort: args.level });
      // Live REPL ctx: opportunistically update if we can. The bridge has the
      // ctx singleton — fall through silently if it's not initialised.
      try {
        const bridge = agentRequire('tui/electron-bridge');
        const ctx = bridge?.getReplContext?.();
        if (ctx) ctx.effort = args.level;
      } catch { /* ok */ }
      const snapshot = buildProvidersSnapshot();
      broadcast(CH.EVT_PROVIDERS_CHANGED, snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(
    CH.PROVIDERS_TEST,
    async (
      _e,
      args: import('../../src/repl/ipc/types').ProviderTestRequestDTO,
    ): Promise<import('../../src/repl/ipc/types').ProviderTestResultDTO> => {
      return await testProviderConnection(args.provider, args.baseUrl);
    },
  );

  // ── API configs (Zielinski Cloud) — listar e trocar config ativa ────
  ipcMain.handle(
    CH.API_CONFIGS_LIST,
    async (): Promise<{
      ok: boolean;
      activeId?: string;
      configs?: Array<{
        id: string;
        name: string;
        provider: string;
        model: string;
        isDefault: boolean;
        isActive: boolean;
        priority: number;
      }>;
      error?: string;
    }> => {
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        const api = getApiClient();
        // Bumped timeouts: 8s was too tight when the VPS is under load or
        // the local network is flaky — the picker would stall on the first
        // request and surface a confusing "timeout of 8000ms exceeded".
        // 30s gives the operator a real signal that the backend is down
        // (vs just slow) without hanging the UI for minutes.
        const activeRes = await api
          .get('/api-configs/active', { timeout: 30_000 })
          .catch(() => ({ data: {} }));
        const activeId: string | undefined = activeRes.data?.id;
        const list: any[] = [];
        for (let page = 1; page <= 20; page++) {
          const res = await api.get(`/api-configs?limit=50&page=${page}`, {
            timeout: 30_000,
          });
          const batch: any[] = res.data?.data || [];
          list.push(...batch);
          if (!res.data?.hasNextPage || batch.length === 0) break;
        }
        const configs = list
          .filter((c) => c && c.isActive !== false)
          .map((c) => ({
            id: String(c.id),
            name: String(c.name || c.model || c.id),
            provider: String(c.provider || ''),
            model: String(c.model || ''),
            isDefault: Boolean(c.isDefault),
            isActive: c.isActive !== false,
            priority: Number(c.priority ?? 0),
          }));
        return { ok: true, activeId, configs };
      } catch (err: any) {
        return { ok: false, error: String(err?.response?.data?.message ?? err?.message ?? err) };
      }
    },
  );

  ipcMain.handle(
    CH.API_CONFIGS_ACTIVATE,
    async (_e, args: { id: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        const api = getApiClient();
        // List all configs across pages so we can zero peers' isDefault.
        const list: any[] = [];
        for (let page = 1; page <= 20; page++) {
          const res = await api.get(`/api-configs?limit=50&page=${page}`, { timeout: 30_000 });
          const batch: any[] = res.data?.data || [];
          list.push(...batch);
          if (!res.data?.hasNextPage || batch.length === 0) break;
        }
        // Zero peers' isDefault BEFORE setting the target. This used to
        // swallow errors silently — if any PATCH failed, two configs ended
        // up with isDefault=true. The backend's findActive sorts by
        // (priority ASC, createdAt ASC) and returns the first match, so
        // the OLDEST tied config kept winning regardless of who was just
        // "activated". Surface failures now so the user knows the switch
        // didn't fully take.
        const peers = list.filter((c) => c && c.id !== args.id && c.isDefault);
        const peerResults = await Promise.allSettled(
          peers.map((c) =>
            api.patch(`/api-configs/${c.id}`, { isDefault: false }, { timeout: 30_000 }),
          ),
        );
        const failedPeers = peerResults
          .map((r, i) => ({ r, peer: peers[i] }))
          .filter((x) => x.r.status === 'rejected');
        if (failedPeers.length > 0) {
          const reasons = failedPeers
            .map((x) => `${x.peer?.name || x.peer?.id}: ${(x.r as any).reason?.message || (x.r as any).reason}`)
            .join('; ');
          return {
            ok: false,
            error:
              `Não consegui zerar isDefault em ${failedPeers.length} config(s) anterior(es) — ` +
              `backend ainda traria elas como ativas. Razões: ${reasons}`,
          };
        }
        // Picker é o gesto explícito do operador "use este modelo como
        // principal". O role da config no banco vai junto: backend
        // findActive filtra role='fast', então sempre forçamos 'primary'
        // pra garantir que a escolha do usuário valha. Mutação intencional —
        // o usuário escolheu, o sistema obedece.
        const target = list.find((c) => c && c.id === args.id);
        await api.patch(
          `/api-configs/${args.id}`,
          { isDefault: true, isActive: true, priority: 0, role: 'primary' },
          { timeout: 30_000 },
        );
        // Verify: ask the backend who's active and confirm it's our target.
        // Catches silent backend bugs (caching, role='fast' filter dropping
        // the target, etc.) before we tell the user "Modelo trocado".
        let activeAfter: any = null;
        try {
          const verifyRes = await api.get('/api-configs/active', { timeout: 30_000 });
          activeAfter = verifyRes.data;
        } catch { /* */ }
        if (activeAfter && activeAfter.id && activeAfter.id !== args.id) {
          const targetName = target?.name || target?.model || args.id;
          const targetRole = target?.role || 'sem role';
          return {
            ok: false,
            error:
              `Patch foi aplicado mas o backend continua retornando ` +
              `${activeAfter.provider}/${activeAfter.model} como ativo. ` +
              `A config "${targetName}" (role='${targetRole}') foi marcada com isDefault=true, ` +
              `mas o endpoint /api-configs/active prefere outra. ` +
              `Provável causa: role da config é 'vision' ou outra que o backend não trata como primário, ` +
              `ou existe cache no servidor. Edite a config no Zielinski Cloud e troque role pra 'primary' ou null.`,
          };
        }
        // Re-puxa providerInfo no ctx pra atualizar catálogo + chaves.
        if (agent?.ctx?.fetchProviderInfo) {
          await agent.ctx.fetchProviderInfo().catch(() => undefined);
        }
        // Notifica o renderer pra refazer queries que dependem do provider ativo.
        broadcast(CH.EVT_PROVIDERS_CHANGED, buildProvidersSnapshot());
        return { ok: true };
      } catch (err: any) {
        return {
          ok: false,
          error: String(err?.response?.data?.message ?? err?.message ?? err),
        };
      }
    },
  );

  ipcMain.handle(CH.MEMORY_SYNC_STATUS, () => {
    try {
      const cluster = agentRequire('cluster/identity');
      const peerId =
        typeof cluster.getIdentity === 'function'
          ? cluster.getIdentity().peerId
          : 'local';
      return {
        peerId,
        peers: 0,
        lastSync: null,
        conflicts: 0,
      };
    } catch {
      return { peerId: 'local', peers: 0, lastSync: null, conflicts: 0 };
    }
  });

  // ── Phase 7 — Schedule ───────────────────────────────────────────────
  ipcMain.handle(CH.SCHEDULE_LIST, () => {
    const { loadSchedules } = agentRequire('schedule');
    return loadSchedules().map(scheduleToDTO);
  });

  ipcMain.handle(
    CH.SCHEDULE_ADD,
    (_e, args: { name: string; cron: string; command: string }) => {
      const { addSchedule, computeNextRun } = agentRequire('schedule');
      // Quick validity check — computeNextRun returns ~1y future when the
      // expression is malformed. Reject early so the UI gets a clear error.
      const next = computeNextRun(args.cron);
      const yearOut = Date.now() + 360 * 24 * 3600_000;
      if (next && new Date(next).getTime() > yearOut) {
        return { ok: false, error: 'cron expression invalid or never fires within 1y' };
      }
      try {
        const s = addSchedule(args.name, args.cron, args.command);
        return { ok: true, schedule: scheduleToDTO(s) };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  );

  ipcMain.handle(
    CH.SCHEDULE_UPDATE,
    (
      _e,
      args: { id: string; patch: Partial<import('../../src/repl/ipc/types').ScheduleDTO> },
    ) => {
      const { loadSchedules, saveSchedules, computeNextRun } =
        agentRequire('schedule');
      const all = loadSchedules() as any[];
      const s = all.find((x) => x.id === args.id);
      if (!s) return { ok: false, error: 'schedule not found' };
      // Only allow whitelisted fields — id/createdAt are immutable.
      const allowed = ['name', 'cron', 'command', 'enabled'] as const;
      for (const k of allowed) {
        if (args.patch[k] !== undefined) (s as any)[k] = args.patch[k];
      }
      // Cron changed → recompute nextRunAt.
      if (args.patch.cron !== undefined) {
        s.nextRunAt = computeNextRun(s.cron);
      }
      saveSchedules(all);
      return { ok: true, schedule: scheduleToDTO(s) };
    },
  );

  ipcMain.handle(CH.SCHEDULE_REMOVE, (_e, args: { id: string }) => {
    const { removeSchedule } = agentRequire('schedule');
    return { ok: Boolean(removeSchedule(args.id)) };
  });

  ipcMain.handle(
    CH.SCHEDULE_ENABLE,
    (_e, args: { id: string; enabled: boolean }) => {
      const { toggleSchedule } = agentRequire('schedule');
      return { ok: Boolean(toggleSchedule(args.id, args.enabled)) };
    },
  );

  ipcMain.handle(
    CH.SCHEDULE_NEXT,
    (_e, args: { cron: string; from?: string }) => {
      try {
        const { computeNextRun } = agentRequire('schedule');
        const from = args.from ? new Date(args.from) : new Date();
        const nextRunAt = computeNextRun(args.cron, from);
        return { nextRunAt };
      } catch (err: any) {
        return { nextRunAt: null, error: String(err?.message ?? err) };
      }
    },
  );

  ipcMain.handle(CH.SCHEDULE_RUN_NOW, (_e, args: { id: string }) => {
    const { loadSchedules, markRan, recordRun } = agentRequire('schedule');
    const s = (loadSchedules() as any[]).find((x) => x.id === args.id);
    if (!s) return { ok: false, error: 'schedule not found' };
    const startedAt = Date.now();
    if (s.command.startsWith('/')) {
      // Slash commands need the REPL — route through the agent's web-router.
      const { routeInputWeb } = agentRequire('web-router');
      const ctx = agent?.ctx;
      if (!ctx) return { ok: false, error: 'agent not initialised' };
      return routeInputWeb(s.command, ctx)
        .then(() => {
          markRan(s.id);
          const run = recordRun({
            scheduleId: s.id,
            ranAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            exitCode: 0,
            outputTail: '',
            trigger: 'manual',
          });
          return { ok: true, runId: run.runId, exitCode: 0 };
        })
        .catch((err: any) => {
          markRan(s.id);
          const run = recordRun({
            scheduleId: s.id,
            ranAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            exitCode: null,
            outputTail: '',
            error: (err?.message ?? String(err))?.substring(0, 500),
            trigger: 'manual',
          });
          return { ok: false, runId: run.runId, error: String(err?.message ?? err) };
        });
    }
    // Shell command — execSync (matches the daemon path).
    const cp = require('child_process') as typeof import('child_process');
    try {
      const out = cp.execSync(s.command, {
        timeout: 30 * 60_000,
        stdio: 'pipe',
        shell: '/bin/sh',
      });
      markRan(s.id);
      const run = recordRun({
        scheduleId: s.id,
        ranAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        outputTail: out?.toString('utf8') ?? '',
        trigger: 'manual',
      });
      return { ok: true, runId: run.runId, exitCode: 0 };
    } catch (err: any) {
      const exit: number | null =
        typeof err?.status === 'number' ? err.status : null;
      const tail =
        (err?.stdout?.toString('utf8') ?? '') +
        (err?.stderr?.toString('utf8') ? '\n' + err.stderr.toString('utf8') : '');
      markRan(s.id);
      const run = recordRun({
        scheduleId: s.id,
        ranAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        exitCode: exit,
        outputTail: tail,
        error: (err?.message ?? String(err))?.substring(0, 500),
        trigger: 'manual',
      });
      return {
        ok: false,
        runId: run.runId,
        exitCode: exit ?? undefined,
        error: String(err?.message ?? err),
      };
    }
  });

  ipcMain.handle(
    CH.SCHEDULE_RUNS,
    (_e, args: { scheduleId: string; limit?: number }) => {
      const { listRunsForSchedule } = agentRequire('schedule');
      return listRunsForSchedule(args.scheduleId, args.limit ?? 10);
    },
  );

  // ── Phase 7 — Daemon ─────────────────────────────────────────────────
  ipcMain.handle(CH.DAEMON_STATUS, () => buildDaemonStatus());

  ipcMain.handle(CH.DAEMON_INSTALL, () => {
    const { installDaemon } = agentRequire('daemon');
    const result = installDaemon();
    broadcast(CH.EVT_DAEMON_STATUS, buildDaemonStatus());
    return result;
  });

  ipcMain.handle(CH.DAEMON_UNINSTALL, () => {
    const { uninstallDaemon } = agentRequire('daemon');
    const result = uninstallDaemon();
    broadcast(CH.EVT_DAEMON_STATUS, buildDaemonStatus());
    return result;
  });

  // ── Phase 7 — Headless runner ─────────────────────────────────────────
  // runs map is closed-over by both HEADLESS_RUN and HEADLESS_STOP. Each
  // entry is removed in the run's `.finally()` to avoid leaks.
  const headlessRuns = new Map<
    string,
    { controller: AbortController; startedAt: number }
  >();

  ipcMain.handle(
    CH.HEADLESS_RUN,
    (
      _e,
      opts: {
        prompt: string;
        yes?: boolean;
        maxTurns?: number;
        format?: 'text' | 'json';
        resumeSessionId?: string;
        continueSession?: boolean;
      },
    ): import('../../src/repl/ipc/types').HeadlessRunStartDTO => {
      const { randomUUID } = require('crypto') as typeof import('crypto');
      const runId = randomUUID();
      const startedAt = Date.now();
      const controller = new AbortController();
      headlessRuns.set(runId, { controller, startedAt });

      let finalText = '';
      const sink = (chunk: { type: string; text: string }) => {
        if (chunk.type === 'assistant') finalText = chunk.text;
        broadcast(CH.EVT_HEADLESS_OUTPUT, {
          runId,
          channel: chunk.type,
          text: chunk.text,
          ts: Date.now(),
        });
      };

      const { runHeadless } = agentRequire('headless');
      Promise.resolve()
        .then(() =>
          runHeadless({
            ...opts,
            sink,
            signal: controller.signal,
          }),
        )
        .then((exitCode: number) => {
          broadcast(CH.EVT_HEADLESS_DONE, {
            runId,
            exitCode,
            durationMs: Date.now() - startedAt,
            finalText,
          });
        })
        .catch((err: any) => {
          broadcast(CH.EVT_HEADLESS_DONE, {
            runId,
            exitCode: 5,
            durationMs: Date.now() - startedAt,
            finalText: err?.message ?? String(err),
          });
        })
        .finally(() => {
          headlessRuns.delete(runId);
        });

      return { runId, startedAt: new Date(startedAt).toISOString() };
    },
  );

  ipcMain.handle(CH.HEADLESS_STOP, (_e, args: { runId: string }) => {
    const entry = headlessRuns.get(args.runId);
    if (!entry) return { ok: false };
    if (!entry.controller.signal.aborted) {
      entry.controller.abort('headless-stop');
    }
    return { ok: true };
  });

  // ── Phase 9 — Settings / theme / output-style / keybindings / statusline / flags
  // Mirror reads/writes of agent-core settings.json + flags.json. We never
  // mutate agent-core modules — saveSettings() is the single chokepoint
  // already exposed; flags.json is written directly with fs since flags.ts
  // is read-only by design.
  ipcMain.handle(CH.SETTINGS_GET, () => settingsToDTO());
  ipcMain.handle(
    CH.SETTINGS_SET,
    (_e, args: { patch: Partial<SettingsDTO> }) => {
      const { saveSettings } = agentRequire('settings');
      saveSettings(args.patch ?? {});
      const dto = settingsToDTO();
      broadcast(CH.EVT_SETTINGS_CHANGED, dto);
      // Apply uiScale as Electron zoom factor so Ctrl+0 is the escape hatch.
      if (typeof args.patch?.uiScale === 'number') {
        const scale = Math.min(2.0, Math.max(0.5, args.patch.uiScale));
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.setZoomFactor(scale);
        }
      }
      return dto;
    },
  );

  ipcMain.handle(CH.THEME_LIST, () => {
    const { themeNames } = agentRequire('theme');
    return (themeNames() as string[]).map((name) => ({ name }));
  });

  // THEME_PREVIEW is renderer-side (CSS vars). The handler exists so the
  // channel resolves; payload is echoed so callers can confirm receipt.
  ipcMain.handle(CH.THEME_PREVIEW, (_e, args: { name: string }) => {
    return { ok: true, name: args?.name ?? '' };
  });

  ipcMain.handle(CH.OUTPUT_STYLE_LIST, (): OutputStyleDTO[] => {
    const { loadOutputStyles } = agentRequire('ai/output-styles');
    const styles = loadOutputStyles() as Array<{
      name: string;
      source: 'builtin' | 'user' | 'project' | 'managed';
      description?: string;
      keepCodingInstructions?: boolean;
      body?: string;
      path?: string;
    }>;
    return styles.map((s) => ({
      name: s.name,
      source: s.source,
      description: s.description,
      bodyPreview: s.body ? s.body.slice(0, 240) : undefined,
      keepCodingInstructions: s.keepCodingInstructions,
      filePath: s.path,
    }));
  });

  ipcMain.handle(
    CH.OUTPUT_STYLE_SET,
    (_e, args: { name: string }) => {
      const { saveSettings } = agentRequire('settings');
      saveSettings({ outputStyle: args.name });
      const dto = settingsToDTO();
      broadcast(CH.EVT_SETTINGS_CHANGED, dto);
      return dto;
    },
  );

  // Phase 9 — output-style editor (read body, create/update, delete)
  ipcMain.handle(
    CH.OUTPUT_STYLE_GET_BODY,
    (_e, args: { name: string }): import('@shared/types').OutputStyleBodyDTO | null => {
      const { findOutputStyle } = agentRequire('ai/output-styles');
      const s = findOutputStyle(args.name) as
        | {
            name: string;
            source: 'builtin' | 'user' | 'project' | 'managed';
            description: string;
            keepCodingInstructions?: boolean;
            body: string;
            path?: string;
          }
        | null;
      if (!s) return null;
      return {
        name: s.name,
        source: s.source,
        description: s.description ?? '',
        keepCodingInstructions: s.keepCodingInstructions !== false,
        body: s.body ?? '',
        filePath: s.path,
      };
    },
  );
  ipcMain.handle(
    CH.OUTPUT_STYLE_SAVE,
    (_e, args: import('@shared/types').OutputStyleSaveDTO): { ok: true; filePath: string } => {
      const { saveOutputStyle } = agentRequire('ai/output-styles');
      const filePath = saveOutputStyle(args) as string;
      return { ok: true, filePath };
    },
  );
  ipcMain.handle(
    CH.OUTPUT_STYLE_DELETE,
    (_e, args: { name: string; scope: 'user' | 'project' }): { ok: boolean } => {
      const { deleteOutputStyle } = agentRequire('ai/output-styles');
      const ok = deleteOutputStyle(args.name, args.scope) as boolean;
      return { ok };
    },
  );

  ipcMain.handle(CH.KEYBINDINGS_GET, () => settingsToDTO().keybindings);
  ipcMain.handle(
    CH.KEYBINDINGS_SET,
    (_e, args: { keybindings: Record<string, string> }) => {
      const { saveSettings } = agentRequire('settings');
      saveSettings({ keybindings: args.keybindings ?? {} });
      const dto = settingsToDTO();
      broadcast(CH.EVT_SETTINGS_CHANGED, dto);
      return dto.keybindings;
    },
  );

  ipcMain.handle(CH.STATUSLINE_GET, () => ({
    fields: settingsToDTO().statusline.fields,
    available: STATUSLINE_FIELD_CATALOG,
  }));
  ipcMain.handle(
    CH.STATUSLINE_SET,
    (_e, args: { fields: string[] }) => {
      const { saveSettings } = agentRequire('settings');
      saveSettings({ statusline: { fields: args.fields ?? [] } });
      const dto = settingsToDTO();
      broadcast(CH.EVT_SETTINGS_CHANGED, dto);
      return dto.statusline;
    },
  );

  ipcMain.handle(CH.FLAGS_GET, () => readFlags());
  ipcMain.handle(
    CH.FLAGS_SET,
    (_e, args: { name: string; value: boolean }) => {
      writeFlag(args.name, args.value);
      return readFlags();
    },
  );

  // ── Phase 8 — Permissions ───────────────────────────────────────────
  ipcMain.handle(CH.PERMISSIONS_GET, () => buildPolicyDTO());
  ipcMain.handle(
    CH.PERMISSIONS_SAVE,
    (_e, args: { policy: PermissionPolicyDTO; scope?: 'user' | 'project' }) => {
      const { savePolicy } = agentRequire('permissions');
      const corePolicy = policyDTOToCore(args.policy);
      savePolicy(corePolicy, args.scope ?? 'user');
      // Mode lives in settings.json — only write when the DTO actually
      // changed it. Saving rules used to also rewrite permissionMode, which
      // touched settings.json on every rule edit and could race with other
      // settings writes.
      if (args.policy.mode) {
        const { loadSettings, saveSettings } = agentRequire('settings');
        const current = (loadSettings() as { permissionMode?: string }).permissionMode || 'default';
        if (current !== args.policy.mode) {
          saveSettings({ permissionMode: args.policy.mode });
        }
      }
      return buildPolicyDTO();
    },
  );

  ipcMain.handle(CH.PERMISSIONS_SHADOW, () => buildShadowWarnings());

  ipcMain.handle(
    CH.PERMISSIONS_TEST,
    (_e, args: PermissionTestRequestDTO): PermissionTestResultDTO => {
      const { loadPolicy, evaluateWithModeDetailed } = agentRequire('permissions');
      const { loadSettings } = agentRequire('settings');
      const policy = loadPolicy() as { policy: 'allow' | 'ask' | 'deny'; rules: any[] };
      const mode = (loadSettings()?.permissionMode || 'default') as
        | 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
      // Map UI fields to the ctx shape evaluate() consumes (path/url, not pathPrefix).
      const evalCtx: any = { tool: args.tool };
      if (args.command) evalCtx.command = args.command;
      if (args.filePath) evalCtx.path = args.filePath;
      if (args.domain) evalCtx.url = `https://${args.domain}/`;
      if (args.cwd) evalCtx.cwd = args.cwd;

      // Build condition overrides — only when the user supplied them. This
      // way the sandbox simulates "branch=hotfix at 03:00 on friday" without
      // mutating git/clock, but a blank field falls through to the live
      // runtime values (so cwd/branch tests reflect real state by default).
      const overrides: any = {};
      if (typeof args.branch === 'string' && args.branch.trim()) overrides.branch = args.branch.trim();
      if (typeof args.hour === 'number' || typeof args.weekday === 'number') {
        const ref = new Date();
        if (typeof args.hour === 'number' && args.hour >= 0 && args.hour <= 23) {
          ref.setHours(args.hour, 0, 0, 0);
        }
        if (typeof args.weekday === 'number' && args.weekday >= 0 && args.weekday <= 6) {
          // Shift `ref` so getDay() returns the requested weekday without
          // changing the hour we just set.
          const delta = args.weekday - ref.getDay();
          ref.setDate(ref.getDate() + delta);
        }
        overrides.now = ref;
      }
      const hasOverrides = Object.keys(overrides).length > 0;

      // Single source of truth — same engine the runtime uses, with optional
      // overrides for the simulated dimensions. Returns ruleIdx so the UI
      // shows exactly which rule fired (or -1 for policy-default / mode).
      const detailed = evaluateWithModeDetailed(
        policy,
        mode,
        evalCtx,
        hasOverrides ? overrides : undefined,
      ) as { action: 'allow' | 'ask' | 'deny'; ruleIdx: number; source: 'mode' | 'rule' | 'policy-default' };

      const matchedRule = detailed.ruleIdx >= 0
        ? (() => {
            const r = policy.rules[detailed.ruleIdx];
            const matcher = r.command || r.pathPrefix || (r.domain ? `domain:${r.domain}` : '*');
            return {
              tool: r.tool,
              matcher,
              action: r.action as 'allow' | 'ask' | 'deny',
              ruleIdx: detailed.ruleIdx,
            };
          })()
        : undefined;

      const reason =
        detailed.source === 'rule' && matchedRule
          ? `regra "${matchedRule.tool}(${matchedRule.matcher})" → ${detailed.action}`
          : detailed.source === 'mode'
            ? `mode=${mode} forçou ${detailed.action} antes do rule engine`
            : `nenhuma regra bateu — policy default = ${policy.policy}, mode=${mode}`;

      return {
        decision: detailed.action,
        matchedRule,
        source: detailed.source,
        reason,
      };
    },
  );

  ipcMain.handle(
    CH.PERMISSIONS_MODE_SET,
    (_e, args: { mode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' }) => {
      const { saveSettings } = agentRequire('settings');
      saveSettings({ permissionMode: args.mode });
      return buildPolicyDTO();
    },
  );

  ipcMain.handle(CH.PERMISSIONS_TRUST_LIST, (): TrustedFolderDTO[] => {
    const { loadSettings } = agentRequire('settings');
    const s = loadSettings() as { workingDirs?: string[] };
    return (s.workingDirs || []).map((p) => ({ path: p }));
  });
  ipcMain.handle(
    CH.PERMISSIONS_TRUST_ADD,
    (_e, args: { path: string }) => {
      const { loadSettings, saveSettings } = agentRequire('settings');
      const current = (loadSettings() as { workingDirs?: string[] }).workingDirs || [];
      if (current.includes(args.path)) return { ok: false, message: 'já adicionado' };
      saveSettings({ workingDirs: [...current, args.path] });
      return { ok: true };
    },
  );
  ipcMain.handle(
    CH.PERMISSIONS_TRUST_REMOVE,
    (_e, args: { path: string }) => {
      const { loadSettings, saveSettings } = agentRequire('settings');
      const current = (loadSettings() as { workingDirs?: string[] }).workingDirs || [];
      saveSettings({ workingDirs: current.filter((p) => p !== args.path) });
      return { ok: true };
    },
  );

  // ── Phase 8 — Hooks ─────────────────────────────────────────────────
  ipcMain.handle(CH.HOOKS_LIST, () => buildHooksList());
  ipcMain.handle(
    CH.HOOKS_SAVE,
    (_e, args: { hooks: HookDTO[]; scope?: 'user' | 'project' }) => {
      const { saveHooks } = agentRequire('hooks');
      const file = hooksDTOsToFile(args.hooks);
      saveHooks(file, args.scope ?? 'user');
      return buildHooksList();
    },
  );
  ipcMain.handle(
    CH.HOOKS_TEST,
    async (
      _e,
      args: { hook: HookDTO; mockToolName?: string; mockToolInput?: any; runHttp?: boolean },
    ): Promise<HookTestResultDTO> => {
      const { testHook } = agentRequire('hooks');
      const coreHook = hookDTOToCore(args.hook);
      const result = await testHook(
        coreHook,
        {
          toolName: args.mockToolName,
          toolInput: args.mockToolInput || {},
        },
        { runHttp: Boolean(args.runHttp) },
      );
      return result as HookTestResultDTO;
    },
  );

  // ── Phase 10 — Usage / Cost ──────────────────────────────────────────

  ipcMain.handle(CH.USAGE_AGGREGATE, (): UsageAggregateDTO => {
    const stats = cachedUsage();
    const { groupByMonth } = agentRequire('usage-aggregator');
    const months = groupByMonth(stats.daily, stats.models);
    return usageStatsToDTO(stats, months);
  });

  ipcMain.handle(
    CH.USAGE_HEATMAP,
    (_e, args: { daysWindow?: number }): UsageHeatmapDTO => {
      const { filterDaily, heatLevel } = agentRequire('usage-aggregator');
      const stats = cachedUsage();
      const window = args?.daysWindow ?? 90;
      const filtered = filterDaily(stats.daily, window) as Array<{ date: string; tokens: number; events: number }>;
      const max = filtered.reduce((m, d) => Math.max(m, d.tokens), 0) || 1;
      return {
        daysWindow: window,
        max,
        days: filtered.map((d) => ({
          date: d.date,
          tokens: d.tokens,
          events: d.events,
          level: heatLevel(d.tokens, max),
        })),
      };
    },
  );

  ipcMain.handle(CH.USAGE_STREAKS, (): UsageStreaksDTO => {
    const stats = cachedUsage();
    return {
      current: stats.currentStreak,
      longest: stats.longestStreak,
      firstDate: stats.firstDate,
      lastDate: stats.lastDate,
      activeDays: stats.activeDays,
      totalDays: stats.totalDays,
      mostActiveDay: stats.mostActiveDay,
      mostActiveDayEvents: stats.mostActiveDayEvents,
    };
  });

  // Returns a tail of the events.jsonl stream filtered by type. Reading the
  // whole 100MB-cap file is fine on disk-buffered reads; the renderer caps
  // limit at 5000 to keep the IPC payload small.
  ipcMain.handle(
    CH.USAGE_EVENTS,
    (_e, args: { types?: string[]; limit?: number } = {}): UsageEventDTO[] => {
      const limit = Math.min(Math.max(args.limit ?? 200, 1), 5000);
      const typeSet = args.types && args.types.length > 0 ? new Set(args.types) : null;
      const homeOs = require('os').homedir();
      const eventsPath = path.join(homeOs, '.makestudio', 'events.jsonl');
      if (!fs.existsSync(eventsPath)) return [];
      const out: UsageEventDTO[] = [];
      try {
        const raw = fs.readFileSync(eventsPath, 'utf8');
        // Walk lines from the end so we slice tail without parsing the whole file.
        const lines = raw.split('\n');
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          const line = lines[i];
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (typeSet && !typeSet.has(ev.type)) continue;
            if (ev.type !== 'token_usage') continue;
            out.push({
              at: ev.ts,
              provider: ev.provider ?? 'unknown',
              model: ev.model ?? 'unknown',
              tier: ev.tier,
              promptTokens: Number(ev.promptTokens ?? 0),
              completionTokens: Number(ev.completionTokens ?? 0),
              cacheReads: Number(ev.cacheReads ?? 0),
              cacheWrites: Number(ev.cacheWrites ?? 0),
            });
          } catch { /* skip */ }
        }
      } catch { /* unreadable */ }
      return out;
    },
  );

  ipcMain.handle(
    CH.USAGE_EXPORT_CSV,
    async (
      e: IpcMainInvokeEvent,
      args: UsageCsvExportRequestDTO,
    ): Promise<UsageCsvExportResultDTO> => {
      const { exportUsageCsv, filterDaily } = agentRequire('usage-aggregator');
      // Window-aware export: a janela aplica-se à série diária (eixo natural)
      // E aos models. Caso contrário daily refletia 30d mas models eram o
      // total acumulado — incoerência semântica que o usuário não esperaria.
      // models são re-agregados a partir dos token_usage events que caem na
      // janela, garantindo que daily.tokens = sum(models.tokensTotal).
      let stats = cachedUsage();
      if (args.daysWindow) {
        const filteredDaily = filterDaily(stats.daily, args.daysWindow);
        const filteredModels = aggregateModelsForWindow(args.daysWindow);
        stats = { ...stats, daily: filteredDaily, models: filteredModels };
      }
      const csv = exportUsageCsv(stats, args.kind);
      const win = BrowserWindow.fromWebContents(e.sender);
      const today = new Date().toISOString().slice(0, 10);
      const suffix = args.daysWindow ? `-last${args.daysWindow}d` : '';
      const defaultName = `usage-${args.kind}${suffix}-${today}.csv`;
      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: defaultName,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
          })
        : await dialog.showSaveDialog({
            defaultPath: defaultName,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
          });
      if (result.canceled || !result.filePath) {
        return { filePath: '', bytes: 0, cancelled: true };
      }
      try {
        fs.writeFileSync(result.filePath, csv, 'utf8');
        return {
          filePath: result.filePath,
          bytes: Buffer.byteLength(csv, 'utf8'),
          cancelled: false,
        };
      } catch (err: any) {
        throw new Error(`Falha ao escrever CSV: ${err?.message ?? err}`);
      }
    },
  );

  // ── Phase 10 — Debug logs ────────────────────────────────────────────

  ipcMain.handle(CH.DEBUG_LOGS_LIST_SESSIONS, (): DebugLogSessionDTO[] => {
    const { listDebugSessions } = agentRequire('debug-log');
    return listDebugSessions({ withCounts: true });
  });

  ipcMain.handle(
    CH.DEBUG_LOGS_TAIL,
    (_e, args: DebugLogTailRequestDTO = {}): DebugLogEntryDTO[] => {
      const { tailDebugLog } = agentRequire('debug-log');
      return tailDebugLog(args ?? {});
    },
  );

  // followId → unsubscribe. Map per-window so a window close cleans up
  // its follows; the cleanup handler is set right below.
  ipcMain.handle(
    CH.DEBUG_LOGS_FOLLOW_START,
    (e: IpcMainInvokeEvent, args: { sessionId?: string; types?: string[] }): DebugLogFollowStartDTO => {
      const { followDebugLog, getSessionId } = agentRequire('debug-log');
      const followId = randomUUID();
      const sessionId = args.sessionId ?? getSessionId();
      const sender = e.sender;
      const unsub = followDebugLog(
        { sessionId, types: args.types },
        (entry: DebugLogEntryDTO) => {
          if (sender.isDestroyed()) {
            const fn = debugFollows.get(followId);
            if (fn) {
              fn();
              debugFollows.delete(followId);
            }
            return;
          }
          sender.send(CH.EVT_DEBUG_LOG_LINE, { followId, entry });
        },
      );
      debugFollows.set(followId, unsub);
      sender.once('destroyed', () => {
        const fn = debugFollows.get(followId);
        if (fn) {
          fn();
          debugFollows.delete(followId);
        }
      });
      return { followId, sessionId };
    },
  );

  ipcMain.handle(
    CH.DEBUG_LOGS_FOLLOW_STOP,
    (_e, args: { followId: string }): { ok: boolean } => {
      const fn = debugFollows.get(args.followId);
      if (fn) {
        fn();
        debugFollows.delete(args.followId);
        return { ok: true };
      }
      return { ok: false };
    },
  );

  // ── Phase 10 — Doctor + Health ───────────────────────────────────────

  // ── Phase 16 — Tips ──────────────────────────────────────────────────
  ipcMain.handle(CH.TIPS_LIST, (): import('../../src/repl/ipc/types').TipDTO[] => {
    const { TIPS } = agentRequire<typeof import('../../src/repl/tips')>('tips');
    return TIPS.map((t) => ({ id: t.id, text: t.text }));
  });

  ipcMain.handle(CH.TIPS_PICK_NEXT, (): { tip: import('../../src/repl/ipc/types').TipDTO | null } => {
    const { bumpStartupAndPickTip, TIPS } = agentRequire<typeof import('../../src/repl/tips')>('tips');
    const text = bumpStartupAndPickTip();
    if (!text) return { tip: null };
    const found = TIPS.find((t) => t.text === text);
    return { tip: found ? { id: found.id, text: found.text } : { id: 'unknown', text } };
  });

  ipcMain.handle(CH.TIPS_DISMISS, (_e, args?: { disable?: boolean }): { ok: boolean; tipsDisabled: boolean } => {
    try {
      const { loadSettings, saveSettings } = agentRequire<typeof import('../../src/repl/settings')>('settings');
      const s = loadSettings();
      // If `disable` is explicitly passed, set directly; otherwise toggle.
      const next = args?.disable !== undefined ? args.disable : !s.tipsDisabled;
      saveSettings({ tipsDisabled: next });
      return { ok: true, tipsDisabled: next };
    } catch {
      return { ok: false, tipsDisabled: false };
    }
  });

  // ── Feedback ────────────────────────────────────────────────────────────
  ipcMain.handle(
    CH.FEEDBACK_SEND,
    async (_e, args: { category: string; text: string; attachLogs?: boolean }): Promise<{ ok: boolean; error?: string }> => {
      const { category, text, attachLogs } = args ?? {};
      if (!text?.trim()) return { ok: false, error: 'Texto não pode estar vazio' };

      let recentLogs: string[] = [];
      if (attachLogs) {
        try {
          const { tailDebugLog } = agentRequire('debug-log');
          const entries = tailDebugLog({ limit: 50 }) as Array<{ ts: string; level: string; msg: string }>;
          recentLogs = entries.map((e) => `[${e.ts}] ${e.level}: ${e.msg}`);
        } catch { /* non-fatal */ }
      }

      const payload = {
        category: category ?? 'other',
        text: text.trim(),
        logs: recentLogs,
        appVersion: app.getVersion(),
        platform: process.platform,
        timestamp: new Date().toISOString(),
      };

      // Try API first, fall back to local file
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        await getApiClient().post('/feedback', payload);
        return { ok: true };
      } catch (apiErr: any) {
        // Save locally as fallback
        try {
          const fbDir = path.join(os.homedir(), '.makestudio', 'feedback');
          fs.mkdirSync(fbDir, { recursive: true });
          const fname = path.join(fbDir, `feedback-${Date.now()}.json`);
          fs.writeFileSync(fname, JSON.stringify(payload, null, 2));
          diagLog('feedback saved locally (api unavailable)', { path: fname, apiErr: apiErr?.message });
          return { ok: true };
        } catch (fsErr: any) {
          return { ok: false, error: fsErr?.message ?? 'Falha ao salvar feedback' };
        }
      }
    },
  );

  ipcMain.handle(CH.HEALTH_CHECK, async (): Promise<HealthReportDTO> => {
    const { runHealthChecks } = agentRequire('health');
    return await runHealthChecks();
  });

  ipcMain.handle(
    CH.DOCTOR_RUN,
    async (_e, args: DoctorRunOptionsDTO = {}): Promise<DoctorReportDTO> => {
      // core/doctor.ts vive em src/core, não em src/repl — usar require direto
      // com o path absoluto montado a partir de AGENT_REPL_DIR.
      const corePath = path.join(AGENT_REPL_DIR, '..', 'core', 'doctor');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runDoctor, detectStacks } = require(corePath);
      const cwd = process.cwd();
      const stacks = detectStacks(cwd) as Array<{
        type: string; label?: string; dir: string; framework?: string;
      }>;
      if (stacks.length === 0) {
        return { passed: true, passes: 0, stacks: [], finalResults: [] };
      }
      const report = await runDoctor({
        repoPath: cwd,
        cli: args.cli ?? 'claude',
        deep: args.deep ?? false,
        maxPasses: args.maxPasses ?? (args.skipFix ? 1 : 3),
        skipFix: args.skipFix ?? false,
      });
      return doctorReportToDTO(report);
    },
  );

  // ── Phase 12 — Skills ────────────────────────────────────────────────

  ipcMain.handle(CH.SKILLS_LIST, (): import('../../src/repl/ipc/types').SkillDTO[] => {
    const { loadAllSkills } = agentRequire('skills');
    const skills = loadAllSkills(process.cwd()) as Array<{
      name: string; description: string; source: 'bundled' | 'user' | 'project';
      args?: string[]; whenToUse?: string; allowedTools?: string[]; disableModelInvocation?: boolean;
    }>;
    return skills.map((s) => ({
      id: `${s.source}:${s.name}`,
      name: s.name,
      description: s.description,
      source: s.source,
      args: s.args,
      whenToUse: s.whenToUse,
      allowedTools: s.allowedTools,
      disableModelInvocation: s.disableModelInvocation,
    }));
  });

  ipcMain.handle(
    CH.SKILLS_GET,
    (_e, args: { name: string }): import('../../src/repl/ipc/types').SkillBodyDTO | null => {
      const { getSkillBody } = agentRequire('skills');
      const s = getSkillBody(args.name, process.cwd()) as any;
      if (!s) return null;
      return {
        name: s.name,
        source: s.source,
        description: s.description ?? '',
        whenToUse: s.whenToUse,
        argumentHint: s.argumentHint,
        args: s.args,
        allowedTools: s.allowedTools,
        body: s.body ?? '',
        filePath: s.path,
      };
    },
  );

  ipcMain.handle(
    CH.SKILLS_SAVE,
    (_e, args: import('../../src/repl/ipc/types').SkillSaveDTO): { ok: true; filePath: string } => {
      const { saveSkill } = agentRequire('skills');
      const filePath = saveSkill({ ...args.skill, scope: args.scope, cwd: process.cwd() }) as string;
      return { ok: true, filePath };
    },
  );

  ipcMain.handle(
    CH.SKILLS_DELETE,
    (_e, args: { scope: 'user' | 'project'; name: string }): { ok: boolean } => {
      const { deleteSkill } = agentRequire('skills');
      return { ok: Boolean(deleteSkill(args.scope, args.name, process.cwd())) };
    },
  );

  // SKILLS_RUN — expand only (test mode). Renderer mostra o prompt expandido
  // sem submeter ao agent, pra usuário poder validar antes de invocar via /name.
  ipcMain.handle(
    CH.SKILLS_RUN,
    async (_e, args: { name: string; argsString?: string }): Promise<{ ok: boolean; expanded?: string; error?: string }> => {
      const { findSkill, loadAllSkills, expandSkill } = agentRequire('skills');
      const skills = loadAllSkills(process.cwd());
      const skill = findSkill(skills, args.name);
      if (!skill) return { ok: false, error: `skill "${args.name}" não encontrado` };
      try {
        const expanded = await expandSkill(skill, (args.argsString ?? '').split(/\s+/).filter(Boolean), process.cwd());
        return { ok: true, expanded };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ── Phase 12 — Custom Agents ─────────────────────────────────────────

  ipcMain.handle(CH.AGENTS_LIST, (): import('../../src/repl/ipc/types').CustomAgentDTO[] => {
    const { loadCustomAgents, builtInAgentNames } = agentRequire('ai/custom-agents');
    const customs = loadCustomAgents(process.cwd()) as Array<any>;
    const builtins = builtInAgentNames() as string[];
    const sourceMap: Record<string, import('../../src/repl/ipc/types').CustomAgentDTO['source']> = {
      'user-makestudio': 'user',
      'project-makestudio': 'project',
      'user-claude': 'claude-user',
      'project-claude': 'claude-project',
    };
    const dtos: import('../../src/repl/ipc/types').CustomAgentDTO[] = customs.map((a) => ({
      id: `${a.source}:${a.name}`,
      name: a.name,
      description: a.description,
      source: sourceMap[a.source] ?? 'user',
      tools: a.tools,
      disallowedTools: a.disallowedTools,
      model: a.model,
      maxTurns: a.maxTurns,
      memoryScope: a.memory ?? 'none',
      bodyPreview: typeof a.prompt === 'string' ? a.prompt.slice(0, 240) : undefined,
    }));
    // Built-ins read-only (no body em disco — prompts moram em subagent-config.ts)
    for (const name of builtins) {
      dtos.unshift({
        id: `builtin:${name}`,
        name,
        description: '(built-in)',
        source: 'user',
        memoryScope: 'none',
        bodyPreview: undefined,
      });
    }
    return dtos;
  });

  ipcMain.handle(
    CH.AGENTS_GET,
    (_e, args: { name: string }): import('../../src/repl/ipc/types').CustomAgentBodyDTO | null => {
      const { findCustomAgent, builtInAgentNames } = agentRequire('ai/custom-agents');
      const builtins = builtInAgentNames() as string[];
      if (builtins.includes(args.name)) {
        return {
          name: args.name,
          source: 'builtin',
          description: '(built-in)',
          prompt: 'Built-in agent — system prompt em subagent-config.ts',
          memory: 'none',
          readOnly: true,
        };
      }
      // findCustomAgent(cwd, name) — não passar a lista pré-carregada,
      // a função reconcilia precedência dos 4 paths internamente.
      const a = findCustomAgent(process.cwd(), args.name) as any;
      if (!a) return null;
      const sourceMap: Record<string, import('../../src/repl/ipc/types').CustomAgentBodyDTO['source']> = {
        'user-makestudio': 'user',
        'project-makestudio': 'project',
        'user-claude': 'claude-user',
        'project-claude': 'claude-project',
      };
      return {
        name: a.name,
        source: sourceMap[a.source] ?? 'user',
        description: a.description ?? '',
        prompt: a.prompt ?? '',
        tools: a.tools,
        disallowedTools: a.disallowedTools,
        model: a.model,
        maxTurns: a.maxTurns,
        baseAgent: a.baseAgent,
        memory: a.memory ?? 'none',
        filePath: a.path,
      };
    },
  );

  ipcMain.handle(
    CH.AGENTS_SAVE,
    (_e, args: import('../../src/repl/ipc/types').CustomAgentSaveDTO): { ok: true; filePath: string } => {
      const { saveCustomAgent } = agentRequire('ai/custom-agents');
      const filePath = saveCustomAgent({ ...args.agent, scope: args.scope, cwd: process.cwd() }) as string;
      return { ok: true, filePath };
    },
  );

  ipcMain.handle(
    CH.AGENTS_DELETE,
    (_e, args: { scope: 'user' | 'project'; name: string }): { ok: boolean } => {
      const { deleteCustomAgent } = agentRequire('ai/custom-agents');
      return { ok: Boolean(deleteCustomAgent(args.scope, args.name, process.cwd())) };
    },
  );

  ipcMain.handle(CH.AGENTS_HISTORY, (): import('../../src/repl/ipc/types').DispatchHistoryEntryDTO[] => {
    const pool = agentRequire('ai/subagent-pool');
    if (typeof pool.listSessions !== 'function') return [];
    const sessions = pool.listSessions() as Array<any>;
    const toIso = (v: unknown): string => {
      if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
      if (typeof v === 'string') return v;
      return new Date(0).toISOString();
    };
    return sessions.map((s) => ({
      id: s.id,
      subagentType: s.subagentType ?? 'unknown',
      // subagent-pool emite SessionSummary com createdAt/updatedAt como
      // `number` (Date.now). DTO declara string ISO — converter aqui pra
      // não quebrar consumidores que assumem o contrato.
      createdAt: toIso(s.createdAt),
      updatedAt: toIso(s.updatedAt),
      messageCount: s.messageCount ?? 0,
      totalTokens: s.totalTokens ?? 0,
      description: s.description,
    }));
  });

  // ── Phase 12 — Plugins ───────────────────────────────────────────────

  ipcMain.handle(CH.PLUGINS_LIST, (): import('../../src/repl/ipc/types').PluginInfoDTO[] => {
    const { listPlugins } = agentRequire('../core/plugin-manager');
    const list = listPlugins() as Array<any>;
    return list.map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      enabled: Boolean(p.enabled),
      source: p.source,
      installedAt: p.installedAt,
      contributionCount: 0,
      path: p.path,
    }));
  });

  ipcMain.handle(
    CH.PLUGINS_CONTRIBUTIONS,
    (_e, args: { name: string }): import('../../src/repl/ipc/types').PluginContributionDTO | null => {
      const { pluginRegistry } = agentRequire('../core/plugin-registry');
      const { getPluginContributions } = agentRequire('plugin-repl-bridge');
      const all = pluginRegistry.getAll?.() as Array<any> | undefined;
      if (!Array.isArray(all)) return null;
      const plugin = all.find((p) => p.name === args.name);
      if (!plugin) return null;
      return getPluginContributions(plugin);
    },
  );

  ipcMain.handle(
    CH.PLUGINS_I18N,
    async (
      _e,
      args: {
        locale: string;
        items: Array<{ name: string; description: string }>;
      },
    ): Promise<Record<string, string>> => {
      if (!agent?.ctx) return {};
      try {
        const { translatePluginDescriptions } = agentRequire('plugin-i18n');
        return await translatePluginDescriptions(agent.ctx, args.items, args.locale);
      } catch {
        // Best-effort — caller treats {} as "fall back to original".
        return {};
      }
    },
  );

  ipcMain.handle(
    CH.PLUGINS_INSTALL,
    async (
      e: IpcMainInvokeEvent,
      args: { source: string },
    ): Promise<{ ok: boolean; manifest?: import('../../src/repl/ipc/types').PluginInfoDTO; error?: string }> => {
      const { installPluginAsync } = agentRequire('../core/plugin-manager');
      try {
        const manifest = await installPluginAsync(args.source, (event: any) => {
          if (e.sender.isDestroyed()) return;
          e.sender.send(CH.EVT_PLUGIN_PROGRESS, {
            source: args.source,
            phase: event.phase,
            line: event.line,
            error: event.error,
            manifest: event.manifest
              ? {
                  name: event.manifest.name,
                  version: event.manifest.version,
                  enabled: event.manifest.enabled,
                  source: event.manifest.source,
                  installedAt: event.manifest.installedAt,
                  contributionCount: 0,
                  path: event.manifest.path,
                }
              : undefined,
          });
        });
        if (!manifest) return { ok: false, error: 'Falha na instalação — verifique o log' };
        return {
          ok: true,
          manifest: {
            name: manifest.name,
            version: manifest.version,
            enabled: manifest.enabled,
            source: manifest.source,
            installedAt: manifest.installedAt,
            contributionCount: 0,
            path: manifest.path,
          },
        };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.PLUGINS_REMOVE,
    (_e, args: { name: string }): { ok: boolean } => {
      const { removePlugin } = agentRequire('../core/plugin-manager');
      return { ok: Boolean(removePlugin(args.name)) };
    },
  );

  ipcMain.handle(
    CH.PLUGINS_TOGGLE,
    (_e, args: { name: string; enabled: boolean }): { ok: boolean; requiresRestart: boolean } => {
      const { togglePlugin } = agentRequire('../core/plugin-manager');
      const ok = Boolean(togglePlugin(args.name, args.enabled));
      // togglePlugin atualiza o JSON mas não recarrega — efetivar requer restart.
      return { ok, requiresRestart: ok };
    },
  );

  // ── Phase 13 — MCP ────────────────────────────────────────────────────

  ipcMain.handle(CH.MCP_LIST, (): import('../../src/repl/ipc/types').McpServerStatusDTO[] => {
    try {
      const { listMcpServers } = agentRequire('mcp');
      return listMcpServers().map((s: any) => ({
        name: s.name,
        status: s.status,
        tools: s.tools,
        resources: s.resources,
        prompts: s.prompts,
        capabilities: s.capabilities,
        lastError: s.lastError,
        startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : new Date(0).toISOString(),
        restarts: s.restarts ?? 0,
        command: s.command,
        args: s.args,
        env: s.env,
      }));
    } catch { return []; }
  });

  ipcMain.handle(CH.MCP_TOOLS, (): import('../../src/repl/ipc/types').McpToolDTO[] => {
    try {
      const { listMcpServers } = agentRequire('mcp');
      const servers: any[] = listMcpServers();
      const tools: import('../../src/repl/ipc/types').McpToolDTO[] = [];
      for (const s of servers) {
        const { getMcpServerDetail } = agentRequire('mcp');
        const detail = getMcpServerDetail(s.name, 0);
        if (detail?.tools) {
          for (const t of detail.tools) {
            tools.push({ serverName: s.name, name: t.name, description: t.description, inputSchema: t.inputSchema });
          }
        }
      }
      return tools;
    } catch { return []; }
  });

  ipcMain.handle(
    CH.MCP_DETAIL,
    (_e, args: { name: string; logsLimit?: number }): import('../../src/repl/ipc/types').McpServerDetailDTO | null => {
      try {
        const { getMcpServerDetail } = agentRequire('mcp');
        const d = getMcpServerDetail(args.name, args.logsLimit ?? 200);
        if (!d) return null;
        return {
          name: d.name,
          status: d.status,
          tools: (d.tools ?? []).map((t: any) => ({ serverName: d.name, name: t.name, description: t.description, inputSchema: t.inputSchema })),
          resources: (d.resources ?? []).map((r: any) => ({ serverName: d.name, uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
          prompts: (d.prompts ?? []).map((p: any) => ({ serverName: d.name, name: p.name, description: p.description, arguments: p.arguments })),
          logs: d.logs ?? [],
          lastError: d.lastError,
          startedAt: d.startedAt ? new Date(d.startedAt).toISOString() : new Date(0).toISOString(),
          command: d.command,
          args: d.args,
        };
      } catch { return null; }
    },
  );

  ipcMain.handle(
    CH.MCP_LOGS,
    (_e, args: { name: string; limit?: number }): string[] => {
      try {
        const { getMcpStderr } = agentRequire('mcp');
        return getMcpStderr(args.name, args.limit ?? 200);
      } catch { return []; }
    },
  );

  ipcMain.handle(
    CH.MCP_ADD,
    async (_e, req: import('../../src/repl/ipc/types').McpAddRequestDTO): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { addMcpServer } = agentRequire('mcp');
        const cwd = agent?.ctx?.cwd ?? process.cwd();
        const result = await addMcpServer(req.name, {
          command: req.command,
          args: req.args ?? [],
          env: req.env,
        }, req.scope ?? 'user', req.cwd ?? cwd);
        // addMcpServer returns { ok, error? } — propagate it so validation errors reach the renderer.
        return result && typeof result.ok === 'boolean' ? result : { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.MCP_REMOVE,
    async (_e, args: { name: string; scope?: 'user' | 'project' }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { removeMcpServer } = agentRequire('mcp');
        const cwd = agent?.ctx?.cwd ?? process.cwd();
        removeMcpServer(args.name, args.scope ?? 'user', cwd);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.MCP_RESTART,
    async (_e, args: { name: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { restartMcpServer } = agentRequire('mcp');
        const cwd = agent?.ctx?.cwd ?? process.cwd();
        return await restartMcpServer(args.name, cwd);
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ── Phase 13 — Cluster ─────────────────────────────────────────────────

  ipcMain.handle(CH.CLUSTER_CONFIG_GET, (): import('../../src/repl/ipc/types').ClusterConfigDTO => {
    try {
      const { loadClusterConfig } = agentRequire('cluster/config');
      const { getIdentity } = agentRequire('cluster/identity');
      const cfg = loadClusterConfig();
      const ident = getIdentity();
      return {
        enabled: cfg.enabled,
        peerId: ident.peerId,
        pubkey: ident.pubkeyHex,
        listenPort: cfg.listenPort,
        multicastGroup: cfg.multicastGroup,
        multicastPort: cfg.multicastPort,
      };
    } catch (err: any) {
      return { enabled: false, peerId: 'local', listenPort: 42042, multicastGroup: '239.255.42.42', multicastPort: 42042 };
    }
  });

  ipcMain.handle(
    CH.CLUSTER_CONFIG_SET,
    (_e, patch: Partial<import('../../src/repl/ipc/types').ClusterConfigDTO>): { ok: boolean; error?: string } => {
      try {
        // Validate port fields — must be integers in [1024, 65535].
        for (const key of ['listenPort', 'multicastPort'] as const) {
          if (patch[key] !== undefined) {
            const p = Number(patch[key]);
            if (!Number.isInteger(p) || p < 1024 || p > 65535) {
              return { ok: false, error: `${key} must be an integer between 1024 and 65535` };
            }
            (patch as any)[key] = p;
          }
        }
        // Validate multicast group — must be 224.0.0.0/4 range.
        if (patch.multicastGroup !== undefined) {
          if (!/^22[4-9]\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^2[3-9][0-9]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(patch.multicastGroup)) {
            return { ok: false, error: 'multicastGroup must be in the 224.0.0.0/4 multicast range' };
          }
        }
        const { loadClusterConfig, saveClusterConfig } = agentRequire('cluster/config');
        const current = loadClusterConfig();
        saveClusterConfig({ ...current, ...patch });
        return { ok: true };
      } catch { return { ok: false }; }
    },
  );

  ipcMain.handle(
    CH.CLUSTER_ENABLE,
    async (_e, args: { enable: boolean }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { loadClusterConfig, saveClusterConfig } = agentRequire('cluster/config');
        const cfg = loadClusterConfig();
        saveClusterConfig({ ...cfg, enabled: args.enable });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(CH.CLUSTER_PEERS, (): import('../../src/repl/ipc/types').ClusterSnapshotDTO => {
    try {
      const { getClusterSnapshot } = agentRequire('cluster/snapshot');
      const snap = getClusterSnapshot();
      return {
        ...snap,
        swimStats: snap.swimStats ?? { alive: 0, suspect: 0, faulty: 0, pings: 0, indirectPings: 0 },
      } as import('../../src/repl/ipc/types').ClusterSnapshotDTO;
    } catch (err: any) {
      return {
        selfPeerId: 'local', enabled: false, listenPort: 42042,
        multicastGroup: '239.255.42.42', multicastPort: 42042,
        swimRunning: false, autoSyncRunning: false, peers: [], trust: [],
        swimStats: { alive: 0, suspect: 0, faulty: 0, pings: 0, indirectPings: 0 },
        discoveryStats: { peers: 0 },
      };
    }
  });

  ipcMain.handle(CH.CLUSTER_TRUST_LIST, (): import('../../src/repl/ipc/types').ClusterTrustEntryDTO[] => {
    try {
      const { listPeerTrust } = agentRequire('cluster/trust');
      return (listPeerTrust() as any[]).map((t: any) => ({
        peerId: t.peerId,
        global: { allowBash: Boolean(t.global?.allowBash), allowWrite: Boolean(t.global?.allowWrite) },
        scopes: (t.scopes ?? []).map((s: any) => ({ path: s.path, allowBash: Boolean(s.allowBash), allowWrite: Boolean(s.allowWrite) })),
      }));
    } catch { return []; }
  });

  ipcMain.handle(
    CH.CLUSTER_TRUST_ADD,
    (_e, req: import('../../src/repl/ipc/types').ClusterTrustSetRequestDTO): { ok: boolean } => {
      try {
        const { setPeerTrust, revokePeerTrust } = agentRequire('cluster/trust');
        // `remove: true` in the DTO means revoke, not set.
        if (req.remove) {
          revokePeerTrust(req.peerId, req.scope?.path);
          return { ok: true };
        }
        const opts: any = { trust: {} };
        if (req.global) opts.trust = req.global;
        if (req.scope) { opts.trust = { allowBash: req.scope.allowBash, allowWrite: req.scope.allowWrite }; opts.scope = req.scope.path; }
        setPeerTrust(req.peerId, opts);
        return { ok: true };
      } catch { return { ok: false }; }
    },
  );

  ipcMain.handle(
    CH.CLUSTER_TRUST_REMOVE,
    (_e, args: { peerId: string; scope?: string }): { ok: boolean } => {
      try {
        const { revokePeerTrust } = agentRequire('cluster/trust');
        revokePeerTrust(args.peerId, args.scope);
        return { ok: true };
      } catch { return { ok: false }; }
    },
  );

  ipcMain.handle(
    CH.CLUSTER_SYNC_NOW,
    async (_e, args: { peerId: string }): Promise<{ ok: boolean; pulled?: number; error?: string }> => {
      // Validate peerId format — cluster uses 'm-<hex>' fingerprints.
      if (typeof args.peerId !== 'string' || !/^m-[0-9a-f]{8,}$/.test(args.peerId)) {
        return { ok: false, error: 'invalid peerId format' };
      }
      try {
        const { pullMemoryFromPeer } = agentRequire('cluster/client');
        const res = await pullMemoryFromPeer(args.peerId);
        return { ok: true, pulled: res.pulled ?? 0 };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // Fix MEMORY_SYNC_STATUS — replaced stub with real cluster snapshot
  // (handler was registered earlier in Phase 6, we re-register to override)
  // Note: ipcMain.handle throws if already registered, so we remove first.
  ipcMain.removeHandler(CH.MEMORY_SYNC_STATUS);
  ipcMain.handle(CH.MEMORY_SYNC_STATUS, (): { peerId: string; peers: number; lastSync: string | null; conflicts: number } => {
    try {
      const { getClusterSnapshot } = agentRequire('cluster/snapshot');
      const snap = getClusterSnapshot();
      return {
        peerId: snap.selfPeerId,
        peers: snap.peers.filter((p: any) => p.swimState === 'alive').length,
        lastSync: snap.lastSyncAt ?? null,
        conflicts: 0,
      };
    } catch {
      return { peerId: 'local', peers: 0, lastSync: null, conflicts: 0 };
    }
  });

  // ── Phase 12 — Boilerplates ──────────────────────────────────────────

  ipcMain.handle(CH.BOILERPLATE_LIST, (): import('../../src/repl/ipc/types').BoilerplateDTO[] => {
    const { getBoilerplates } = agentRequire('../core/boilerplate-registry');
    const { loadBoilerplateManifest } = agentRequire('../core/boilerplate-manifest');
    const list = getBoilerplates() as Array<any>;
    return list.map((b) => {
      const exists = b.localPath ? fs.existsSync(b.localPath) : false;
      let hasManifest = false;
      if (exists && b.localPath) {
        try { hasManifest = loadBoilerplateManifest(b.localPath) !== null; } catch { /* */ }
      }
      return {
        slug: b.slug,
        name: b.name,
        description: b.description,
        difficulty: b.difficulty ?? 0,
        stacks: Array.isArray(b.stacks) ? b.stacks : [],
        localPath: b.localPath,
        exists,
        hasManifest,
      };
    });
  });

  ipcMain.handle(
    CH.BOILERPLATE_PROMPTS,
    (_e, args: { slug: string }): import('../../src/repl/ipc/types').BoilerplatePromptDTO[] => {
      const { getBoilerplates } = agentRequire('../core/boilerplate-registry');
      const { loadBoilerplateManifest } = agentRequire('../core/boilerplate-manifest');
      const list = getBoilerplates() as Array<any>;
      const bp = list.find((b) => b.slug === args.slug);
      if (!bp?.localPath) return [];
      const manifest = loadBoilerplateManifest(bp.localPath);
      if (!manifest) return [];
      return manifest.prompts.map((p) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        required: p.required,
        default: p.default,
        choices: p.choices,
      }));
    },
  );

  ipcMain.handle(
    CH.BOILERPLATE_APPLY,
    async (
      e: IpcMainInvokeEvent,
      args: import('../../src/repl/ipc/types').BoilerplateApplyRequestDTO,
    ): Promise<import('../../src/repl/ipc/types').BoilerplateApplyResultDTO> => {
      const { getBoilerplates, copyBoilerplate } = agentRequire('../core/boilerplate-registry');
      const { applyManifestSubstitutions } = agentRequire('../core/boilerplate-manifest');
      const list = getBoilerplates() as Array<any>;
      const bp = list.find((b) => b.slug === args.slug);
      if (!bp) return { ok: false, filesScanned: 0, filesChanged: 0, targetDir: args.targetDir, error: `boilerplate "${args.slug}" não encontrado` };
      const emit = (event: import('../../src/repl/ipc/types').BoilerplateApplyProgressDTO): void => {
        if (e.sender.isDestroyed()) return;
        e.sender.send(CH.EVT_BOILERPLATE_PROGRESS, event);
      };
      try {
        emit({ phase: 'start', log: `${args.slug} → ${args.targetDir}` });
        emit({ phase: 'copy', log: 'copiando arquivos…' });
        copyBoilerplate(bp, args.targetDir);
        emit({ phase: 'walk', log: 'aplicando templates…' });
        const result = await applyManifestSubstitutions(args.targetDir, args.answers, (ev: any) => {
          emit({ phase: ev.phase, file: ev.file, filesProcessed: ev.filesProcessed, totalFiles: ev.totalFiles, log: ev.log });
        });
        emit({ phase: 'done', log: `${result.filesChanged} arquivos modificados de ${result.filesScanned} escaneados` });
        return { ok: true, filesScanned: result.filesScanned, filesChanged: result.filesChanged, targetDir: args.targetDir };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        emit({ phase: 'error', error: msg });
        return { ok: false, filesScanned: 0, filesChanged: 0, targetDir: args.targetDir, error: msg };
      }
    },
  );

  // ── Phase 14 — Projects ───────────────────────────────────────────────

  ipcMain.handle(CH.PROJECTS_LIST, async (): Promise<import('../../src/repl/ipc/types').ProjectDTO[]> => {
    const tenantId = agent?.ctx?.user?.tenantId;
    if (!agent?.ctx || !tenantId) return [];
    try {
      const projects = await agent.ctx.fetchProjects();
      return (projects as any[]).map((p) => ({
        id: p.id ?? p._id ?? '',
        name: p.name ?? '',
        localPath: p.localPath,
        status: p.status,
        tenantId: p.tenantId ?? tenantId,
        description: p.description,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));
    } catch { return []; }
  });

  ipcMain.handle(
    CH.PROJECTS_SET_ACTIVE,
    async (_e, args: { id: string; name: string; localPath?: string; tenantId?: string }): Promise<{ ok: boolean }> => {
      if (!agent?.ctx) return { ok: false };
      try {
        const tenantId = args.tenantId ?? agent.ctx.user?.tenantId ?? '';
        agent.ctx.setActiveProject({
          id: args.id,
          name: args.name,
          localPath: args.localPath,
          tenantId,
        });
        broadcast(CH.EVT_PROJECT_ACTIVE, {
          id: args.id,
          name: args.name,
          localPath: args.localPath,
          tenantId,
        } as import('../../src/repl/ipc/types').ProjectDTO);
        return { ok: true };
      } catch { return { ok: false }; }
    },
  );

  ipcMain.handle(
    CH.PROJECTS_NEW,
    async (_e, args: { name: string; localPath?: string }): Promise<{ ok: boolean; project?: import('../../src/repl/ipc/types').ProjectDTO; error?: string }> => {
      const tenantId = agent?.ctx?.user?.tenantId;
      if (!tenantId) return { ok: false, error: 'not authenticated' };
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        const api = getApiClient();
        const res = await api.post('/dark-factory/projects', {
          name: args.name.trim(),
          localPath: args.localPath,
        }, { headers: { 'x-tenant-id': tenantId }, timeout: 15_000 });
        const p = res.data?.data ?? res.data;
        return { ok: true, project: { id: p.id ?? p._id, name: p.name, tenantId, localPath: args.localPath } };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ── Phase 14 — Tasks ──────────────────────────────────────────────────

  ipcMain.handle(
    CH.TASKS_LIST,
    async (_e, args: { projectId: string }): Promise<import('../../src/repl/ipc/types').TaskDTO[]> => {
      if (!agent?.ctx?.user?.tenantId) return [];
      try {
        const tasks = await agent.ctx.fetchTasks(args.projectId);
        return (tasks as any[]).map((t) => ({
          id: t.id ?? t._id ?? '',
          projectId: t.projectId ?? args.projectId,
          title: t.title ?? '',
          description: t.description,
          status: t.status ?? 'pending',
          assignee: t.assignee,
          createdAt: t.createdAt ?? new Date(0).toISOString(),
          updatedAt: t.updatedAt ?? new Date(0).toISOString(),
          prUrl: t.prUrl,
        }));
      } catch { return []; }
    },
  );

  ipcMain.handle(
    CH.TASKS_RUN,
    async (_e, args: { taskId: string; projectId: string }): Promise<{ ok: boolean; error?: string }> => {
      const tenantId = agent?.ctx?.user?.tenantId;
      if (!tenantId) return { ok: false, error: 'not authenticated' };
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        const api = getApiClient();
        await api.post(`/dark-factory/tasks/${args.taskId}/run`, {}, {
          headers: { 'x-tenant-id': tenantId }, timeout: 30_000,
        });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.TASKS_MOVE,
    async (_e, args: { taskId: string; status: string }): Promise<{ ok: boolean; error?: string }> => {
      const tenantId = agent?.ctx?.user?.tenantId;
      if (!tenantId) return { ok: false, error: 'not authenticated' };
      const validStatuses = ['pending', 'in-progress', 'verification', 'done'] as const;
      if (!validStatuses.includes(args.status as any)) return { ok: false, error: 'invalid status' };
      if (!/^[0-9a-f-]{8,}$/i.test(args.taskId)) return { ok: false, error: 'invalid taskId' };
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        const api = getApiClient();
        await api.patch(`/dark-factory/tasks/${args.taskId}`, { status: args.status }, {
          headers: { 'x-tenant-id': tenantId }, timeout: 15_000,
        });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.DUMS_LIST,
    async (_e, args: { projectId: string }): Promise<import('../../src/repl/ipc/types').DumDTO[]> => {
      if (!agent?.ctx?.user?.tenantId) return [];
      try {
        const dums = await agent.ctx.fetchDums(args.projectId);
        return (dums as any[]).map((d) => ({
          id: d.id ?? d._id ?? '',
          projectId: d.projectId ?? args.projectId,
          dumNumber: d.dumNumber ?? d.number ?? '',
          title: d.title ?? '',
          status: d.status ?? 'pending',
          artifactsCount: d.artifactsCount ?? 0,
          createdAt: d.createdAt ?? new Date(0).toISOString(),
          updatedAt: d.updatedAt ?? new Date(0).toISOString(),
        }));
      } catch { return []; }
    },
  );

  ipcMain.handle(
    CH.DUMS_DETAIL,
    async (_e, args: { dumId: string }): Promise<import('../../src/repl/ipc/types').DumDetailDTO | null> => {
      const tenantId = agent?.ctx?.user?.tenantId;
      if (!tenantId) return null;
      try {
        const { getApiClient } = agentRequire('../network/api-client');
        const api = getApiClient();
        const res = await api.get(`/dark-factory/dums/${args.dumId}`, {
          headers: { 'x-tenant-id': tenantId }, timeout: 15_000,
        });
        const d = res.data?.data ?? res.data;
        return {
          id: d.id ?? d._id ?? '',
          projectId: d.projectId ?? '',
          dumNumber: d.dumNumber ?? d.number ?? '',
          title: d.title ?? '',
          status: d.status ?? 'pending',
          artifactsCount: d.artifactsCount ?? 0,
          createdAt: d.createdAt ?? new Date(0).toISOString(),
          updatedAt: d.updatedAt ?? new Date(0).toISOString(),
          specFull: d.specFull ?? d.spec ?? '',
          tasks: (d.tasks ?? []).map((t: any) => ({
            id: t.id ?? t._id ?? '',
            projectId: t.projectId ?? d.projectId ?? '',
            title: t.title ?? '',
            description: t.description,
            status: t.status ?? 'pending',
            assignee: t.assignee,
            createdAt: t.createdAt ?? new Date(0).toISOString(),
            updatedAt: t.updatedAt ?? new Date(0).toISOString(),
            prUrl: t.prUrl,
          })),
          artifacts: (d.artifacts ?? []).map((a: any) => ({
            path: a.path ?? '',
            size: a.size ?? 0,
            contentPreview: a.contentPreview,
          })),
        };
      } catch { return null; }
    },
  );

  // ── Phase 14 — Plan ───────────────────────────────────────────────────

  ipcMain.handle(
    CH.PLAN_GET,
    async (_e, args?: { dumNumber?: string }): Promise<import('../../src/repl/ipc/types').PlanFileDTO | null> => {
      try {
        const { readPlan, planFilePath } = agentRequire('../core/plan-mode');
        const cwd = agent?.ctx?.activeProject?.localPath ?? agent?.ctx?.cwd ?? process.cwd();
        const dum = args?.dumNumber ?? '0';
        const content = readPlan(cwd, dum);
        if (!content) return null;
        const fp = planFilePath(cwd, dum);
        return {
          path: fp,
          content,
          bytes: Buffer.byteLength(content, 'utf8'),
        };
      } catch { return null; }
    },
  );

  ipcMain.handle(
    CH.PLAN_SAVE,
    async (_e, args: { content: string; dumNumber?: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { planFilePath, ensurePlanFile } = agentRequire('../core/plan-mode');
        const cwd = agent?.ctx?.activeProject?.localPath ?? agent?.ctx?.cwd ?? process.cwd();
        const dum = args.dumNumber ?? '0';
        ensurePlanFile(cwd, dum);
        const fp = planFilePath(cwd, dum);
        const tmpPath = fp + '.tmp';
        fs.writeFileSync(tmpPath, args.content, 'utf8');
        fs.renameSync(tmpPath, fp);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ── Phase 14 — Worktree ───────────────────────────────────────────────

  ipcMain.handle(
    CH.WORKTREE_LIST,
    (_e, args?: { cwd?: string }): import('../../src/repl/ipc/types').WorktreeListItemDTO[] => {
      try {
        const { listWorktrees } = agentRequire('../core/worktree');
        const cwd = args?.cwd ?? agent?.ctx?.cwd ?? process.cwd();
        return listWorktrees(cwd);
      } catch { return []; }
    },
  );

  ipcMain.handle(
    CH.WORKTREE_CREATE,
    async (_e, args: { dumNumber: string; cwd?: string }): Promise<{ ok: boolean; handle?: any; error?: string }> => {
      try {
        const { enterWorktreeForDum } = agentRequire('../core/worktree');
        const cwd = args.cwd ?? agent?.ctx?.cwd ?? process.cwd();
        const handle = enterWorktreeForDum(cwd, args.dumNumber);
        broadcast(CH.EVT_WORKTREE, {
          active: true,
          branch: handle.branch,
          path: handle.worktreePath,
          originalCwd: handle.originalRepo,
        });
        return { ok: true, handle: { branch: handle.branch, worktreePath: handle.worktreePath } };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.WORKTREE_MERGE,
    async (_e, args: { worktreePath: string; branch: string; baseSha: string; originalRepo: string; originalBranch: string | null }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { exitWorktreeAndMerge } = agentRequire('../core/worktree');
        const originalRepo = args.originalRepo || agent?.ctx?.cwd || process.cwd();
        exitWorktreeAndMerge({ ...args, originalRepo });
        broadcast(CH.EVT_WORKTREE, { active: false });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.WORKTREE_CLEANUP,
    async (_e, args: { worktreePath: string; branch: string; baseSha: string; originalRepo: string; originalBranch: string | null }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { exitWorktreeAndDiscard } = agentRequire('../core/worktree');
        const originalRepo = args.originalRepo || agent?.ctx?.cwd || process.cwd();
        exitWorktreeAndDiscard({ ...args, originalRepo });
        broadcast(CH.EVT_WORKTREE, { active: false });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ── Phase 14 — Coordinator snapshot ──────────────────────────────────

  ipcMain.handle(
    CH.COORDINATOR_STATUS,
    (): import('../../src/repl/ipc/types').CoordinatorSnapshotDTOv2 => {
      if (!agent?.ctx) return { active: false, workers: [], scratchpadFiles: [] };
      try {
        const ctx = agent.ctx;
        const workers: import('../../src/repl/ipc/types').WorkerSnapshotDTO[] = [];
        if (ctx.coordinatorWorkers) {
          for (const [id, w] of ctx.coordinatorWorkers.entries()) {
            workers.push({
              id,
              status: w.status ?? 'running',
              mode: w.mode,
              subagentType: w.subagentType,
              startedAt: w.startedAt ? new Date(w.startedAt).toISOString() : new Date(0).toISOString(),
              tokens: w.tokens,
              lastMessage: w.lastMessage,
            });
          }
        }
        return {
          active: Boolean(ctx.coordinatorActive),
          sessionId: ctx.sessionId,
          workers,
          scratchpadFiles: [],
        };
      } catch { return { active: false, workers: [], scratchpadFiles: [] }; }
    },
  );

  // ── Phase 15 — Git ────────────────────────────────────────────────────

  ipcMain.handle(
    CH.GIT_STATUS,
    async (_e, args?: { cwd?: string }): Promise<import('../../src/repl/ipc/types').GitStatusDTO> => {
      try {
        const { gitStatus } = agentRequire('../core/git-ops');
        const cwd = args?.cwd ?? agent?.ctx?.cwd ?? process.cwd();
        return await new Promise((resolve) => setImmediate(() => resolve(gitStatus(cwd))));
      } catch {
        return { branch: 'HEAD', dirty: false, ahead: 0, behind: 0, files: [] };
      }
    },
  );

  ipcMain.handle(
    CH.GIT_DIFF,
    async (_e, args: import('../../src/repl/ipc/types').GitDiffRequestDTO): Promise<import('../../src/repl/ipc/types').GitDiffDTO> => {
      try {
        const { gitDiff } = agentRequire('../core/git-ops');
        const cwd = args?.cwd ?? agent?.ctx?.cwd ?? process.cwd();
        return await new Promise((resolve) => setImmediate(() =>
          resolve(gitDiff(cwd, { path: args?.path, staged: args?.staged, baseRef: args?.baseRef }))));
      } catch {
        return { raw: '', insertions: 0, deletions: 0, truncated: false };
      }
    },
  );

  ipcMain.handle(
    CH.GIT_COMMIT,
    async (_e, args: import('../../src/repl/ipc/types').GitCommitRequestDTO): Promise<{
      ok: boolean;
      data?: unknown;
      error?: string;
    }> => {
      const cwd = args.cwd ?? agent?.ctx?.cwd ?? process.cwd();
      try {
        if (args.op === 'branches') {
          const { listBranches } = agentRequire('../core/git-ops');
          return { ok: true, data: listBranches(cwd) };
        }
        if (args.op === 'suggest') {
          // Suggest commit message using git diff summary
          const { gitDiff } = agentRequire('../core/git-ops');
          const diff = gitDiff(cwd, { staged: true });
          const short = diff.raw.slice(0, 3_000);
          return { ok: true, data: { message: short ? `feat: update ${short.split('\n').length} lines` : 'chore: update files' } };
        }
        if (args.op === 'commit') {
          const { commitAllFiles } = agentRequire('../core/git-ops');
          if (!args.message) return { ok: false, error: 'message required' };
          const result = commitAllFiles(cwd, args.message);
          return { ok: true, data: result };
        }
        if (args.op === 'push') {
          const { getCurrentBranch, pushBranch } = agentRequire('../core/git-ops');
          const branch = getCurrentBranch(cwd);
          const ok = pushBranch(cwd, branch);
          return { ok, error: ok ? undefined : 'Push failed' };
        }
        if (args.op === 'cpp') {
          // commit + push + pr
          const { commitAllFiles, getCurrentBranch, pushBranch } = agentRequire('../core/git-ops');
          const { createPR, ghPreflightAsync } = agentRequire('../repl/pr-helpers');
          if (!args.message) return { ok: false, error: 'message required' };
          const commitResult = commitAllFiles(cwd, args.message);
          const branch = getCurrentBranch(cwd);
          const pushed = pushBranch(cwd, branch);
          if (!pushed) return { ok: false, error: 'Push failed' };
          const pre = await ghPreflightAsync(cwd);
          if (!pre.ok) return { ok: false, error: pre.error };
          const pr = createPR(cwd, {
            title: args.prTitle ?? args.message,
            body: args.prBody ?? '',
            base: args.base ?? 'develop',
          });
          return { ok: true, data: { commit: commitResult, pr } };
        }
        return { ok: false, error: `unknown op: ${args.op}` };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.GIT_PR,
    async (_e, args: { op: string; state?: string; number?: number; create?: import('../../src/repl/ipc/types').PRCreateRequestDTO; cwd?: string }): Promise<{
      ok: boolean;
      data?: unknown;
      error?: string;
    }> => {
      const cwd = args.cwd ?? agent?.ctx?.cwd ?? process.cwd();
      try {
        const { ghPreflightAsync, listPRs, viewPR, listPRComments, createPR } = agentRequire('../repl/pr-helpers');
        const pre = await ghPreflightAsync(cwd);
        if (!pre.ok) return { ok: false, error: pre.error };
        if (args.op === 'list') {
          return { ok: true, data: listPRs(cwd, (args.state as any) ?? 'open') };
        }
        if (args.op === 'view' && args.number) {
          return { ok: true, data: viewPR(cwd, args.number) };
        }
        if (args.op === 'comments' && args.number) {
          return { ok: true, data: listPRComments(cwd, args.number) };
        }
        if (args.op === 'create' && args.create) {
          return { ok: true, data: createPR(cwd, args.create) };
        }
        return { ok: false, error: `unknown op: ${args.op}` };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    CH.SECURITY_REVIEW_RUN,
    async (_e, args: { cli?: string; base?: string; cwd?: string }): Promise<import('../../src/repl/ipc/types').SecurityReviewDTO> => {
      const t0 = Date.now();
      const cwd = args.cwd ?? agent?.ctx?.cwd ?? process.cwd();
      const base = args.base ?? 'HEAD~10';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fsmod = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const outputDir = path.join(cwd, '.makestudio', 'security-reviews');
      const outputFile = path.join(outputDir, `${ts}.md`);
      try {
        fsmod.mkdirSync(outputDir, { recursive: true });
        const { buildSecurityReviewPrompt } = agentRequire('../commands/security-review');
        const { runLocalCLI } = agentRequire('../commands/execute');
        const prompt = buildSecurityReviewPrompt(cwd, base, outputFile);
        fsmod.writeFileSync(outputFile, '', 'utf8');
        await runLocalCLI(args.cli ?? 'claude', prompt, cwd);
        const content = fsmod.existsSync(outputFile) ? fsmod.readFileSync(outputFile, 'utf8') : '';
        const { parseSecurityReviewMarkdown } = agentRequire('../repl/security-parser');
        const issues = parseSecurityReviewMarkdown(content);
        const summary = { high: 0, medium: 0, low: 0 };
        for (const i of issues) {
          if (i.severity === 'High') summary.high++;
          else if (i.severity === 'Medium') summary.medium++;
          else summary.low++;
        }
        return {
          ranAt: new Date(t0).toISOString(),
          base,
          durationMs: Date.now() - t0,
          reportPath: outputFile,
          issues,
          summary,
          truncated: content.length > 120_000,
        };
      } catch (err: any) {
        throw new Error(err?.message ?? 'Security review failed');
      }
    },
  );
}

// followId → unsubscribe pra debug-log follow; Map é módulo-level porque
// múltiplos handlers + window-close listener precisam acessar.
const debugFollows = new Map<string, () => void>();

// ── Phase 7 helpers ────────────────────────────────────────────────────
function scheduleToDTO(s: any): ScheduleDTO {
  return {
    id: s.id,
    name: s.name,
    cron: s.cron,
    command: s.command,
    enabled: Boolean(s.enabled),
    lastRunAt: s.lastRunAt,
    nextRunAt: s.nextRunAt,
  };
}

// ── Phase 8 helpers ────────────────────────────────────────────────────

function ruleToDTO(r: any): PermissionRuleDTO {
  return {
    tool: r.tool,
    matcher: r.command || r.pathPrefix || r.domain,
    pathPrefix: r.pathPrefix,
    domain: r.domain,
    action: r.action,
    conditions:
      Array.isArray(r.conditions) && r.conditions.length > 0
        ? r.conditions
            .map((c: any) =>
              `${c.negate ? '!' : ''}${c.kind}(${c.value})`,
            )
            .join(' && ')
        : undefined,
  };
}

function ruleDTOToCore(r: PermissionRuleDTO): any {
  // Parse condition string back into structured array if present.
  let conditions: any[] | undefined;
  if (r.conditions && r.conditions.trim()) {
    conditions = [];
    for (const raw of r.conditions.split('&&').map((s) => s.trim()).filter(Boolean)) {
      let s = raw;
      let negate = false;
      if (s.startsWith('!')) { negate = true; s = s.slice(1).trim(); }
      const m = s.match(/^(cwd|branch|hour|weekday)\((.*)\)$/);
      if (m) conditions.push({ kind: m[1], value: m[2].trim(), negate });
    }
    if (conditions.length === 0) conditions = undefined;
  }
  // Decide which matcher slot to populate based on the tool.
  const COMMAND_TOOLS = new Set(['Bash', 'shell_run']);
  const out: any = { tool: r.tool, action: r.action };
  if (r.pathPrefix) out.pathPrefix = r.pathPrefix;
  else if (r.domain) out.domain = r.domain;
  else if (r.matcher) {
    if (COMMAND_TOOLS.has(r.tool)) out.command = r.matcher;
    else out.pathPrefix = r.matcher;
  }
  if (conditions) out.conditions = conditions;
  return out;
}

function buildPolicyDTO(): PermissionPolicyDTO {
  const { loadPolicy } = agentRequire('permissions');
  const { loadSettings } = agentRequire('settings');
  const policy = loadPolicy() as { policy: 'allow' | 'ask' | 'deny'; rules: any[] };
  const mode = (loadSettings()?.permissionMode || 'default') as
    | 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
  return {
    policy: policy.policy,
    mode,
    rules: policy.rules.map(ruleToDTO),
  };
}

function policyDTOToCore(dto: PermissionPolicyDTO): any {
  return {
    policy: dto.policy,
    rules: dto.rules.map(ruleDTOToCore),
  };
}

function buildShadowWarnings(): ShadowWarningDTO[] {
  const { loadPolicy, detectShadowedRules } = agentRequire('permissions');
  return detectShadowedRules(loadPolicy()) as ShadowWarningDTO[];
}

function buildHooksList(): HookDTO[] {
  const { loadHooks } = agentRequire('hooks');
  const file = loadHooks() as Record<string, any[] | undefined>;
  const out: HookDTO[] = [];
  // Deterministic IDs — `<event>-<positionInEvent>`. Stays stable across
  // reloads as long as the on-disk order is preserved (saveHooks rewrites
  // the file with the same array order it received). Avoids the global-
  // counter footgun where concurrent loadHooks() calls produced different
  // IDs for the same row.
  for (const [event, entries] of Object.entries(file)) {
    if (!entries) continue;
    let idx = 0;
    for (const raw of entries) {
      // Legacy string-only command hook.
      const hook =
        typeof raw === 'string'
          ? { type: 'command' as const, command: raw }
          : (raw as any);
      out.push({
        id: `${event}-${idx++}`,
        event: event as any,
        type: hook.type,
        if: hook.if,
        timeout: hook.timeout,
        async: hook.async,
        command: hook.command,
        url: hook.url,
        method: hook.method,
        headers: hook.headers,
        prompt: hook.prompt,
        model: hook.model,
        vetoIfContains: hook.vetoIfContains,
        subagent_type: hook.subagent_type,
        task: hook.task,
      });
    }
  }
  return out;
}

function hookDTOToCore(dto: HookDTO): any {
  const base: any = { type: dto.type };
  if (dto.if !== undefined) base.if = dto.if;
  if (dto.timeout !== undefined) base.timeout = dto.timeout;
  if (dto.async !== undefined) base.async = dto.async;
  switch (dto.type) {
    case 'command':
      base.command = dto.command || '';
      break;
    case 'http':
      base.url = dto.url || '';
      if (dto.method) base.method = dto.method;
      if (dto.headers) base.headers = dto.headers;
      break;
    case 'prompt':
      base.prompt = dto.prompt || '';
      if (dto.model) base.model = dto.model;
      if (dto.vetoIfContains) base.vetoIfContains = dto.vetoIfContains;
      break;
    case 'agent':
      base.subagent_type = dto.subagent_type || '';
      base.task = dto.task || '';
      if (dto.vetoIfContains) base.vetoIfContains = dto.vetoIfContains;
      break;
  }
  return base;
}

function hooksDTOsToFile(dtos: HookDTO[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const d of dtos) {
    if (!out[d.event]) out[d.event] = [];
    out[d.event].push(hookDTOToCore(d));
  }
  return out;
}

// ── Phase 9 helpers ────────────────────────────────────────────────────

function settingsToDTO(): SettingsDTO {
  const { loadSettings } = agentRequire('settings');
  const s = loadSettings() as Record<string, any>;
  return {
    theme: s.theme,
    outputStyle: s.outputStyle,
    vimMode: Boolean(s.vimMode),
    fastMode: Boolean(s.fastMode),
    keybindings: { ...(s.keybindings || {}) },
    statusline: { fields: [...(s.statusline?.fields || [])] },
    workingDirs: [...(s.workingDirs || [])],
    permissionMode: s.permissionMode,
    tipsDisabled: s.tipsDisabled,
    suggestionsDisabled: s.suggestionsDisabled,
    awaySummaryDisabled: s.awaySummaryDisabled,
    magicDocsDisabled: s.magicDocsDisabled,
    fileHistoryDisabled: s.fileHistoryDisabled,
    autoVerifyEnabled: s.autoVerifyEnabled,
    verbose: s.verbose,
    inputPaste: s.inputPaste ? { ...s.inputPaste } : undefined,
    inputAtFile: s.inputAtFile ? { ...s.inputAtFile } : undefined,
    uiScale: typeof s.uiScale === 'number' ? s.uiScale : undefined,
  };
}

// ── Phase 10 helpers ───────────────────────────────────────────────────

// Cache curto pra computeUsage(). 4 handlers de USAGE_* eram disparados em
// cada refresh da UsagePage (refresh button invalida o queryKey 'usage' →
// dispara aggregate + heatmap simultâneos = 2 reads do events.jsonl em
// paralelo, somados a streaks ad-hoc). Com a TTL abaixo, o burst de 4
// invokes em <100ms compartilha um único parse. 5s é seguro porque a UI
// só dispara invalidação manualmente; entre refreshes o usuário fica
// olhando o snapshot.
const USAGE_CACHE_TTL_MS = 5_000;
let usageCache: { stats: any; at: number } | null = null;
function cachedUsage(): any {
  const now = Date.now();
  if (usageCache && now - usageCache.at < USAGE_CACHE_TTL_MS) {
    return usageCache.stats;
  }
  const { computeUsage } = agentRequire('usage-aggregator');
  const stats = computeUsage();
  usageCache = { stats, at: now };
  return stats;
}

/**
 * Re-agrega models[] limitando aos token_usage events que caíram na janela
 * de N dias. Necessário pra coerência do CSV export quando daysWindow está
 * setado: caso contrário daily seria filtrado mas models continuaria
 * refletindo a totalidade da série. Reusamos o pricing/cache-ratio compute
 * inline em vez de duplicar a lógica do reducer principal.
 */
function aggregateModelsForWindow(days: number): any[] {
  const homeOs = require('os').homedir();
  const eventsFiles = [
    path.join(homeOs, '.makestudio', 'events.jsonl.old'),
    path.join(homeOs, '.makestudio', 'events.jsonl'),
  ];
  const cutoffMs = Date.now() - days * 86_400_000;
  const byModel = new Map<string, any>();
  const { estimateCost } = agentRequire('costs');
  for (const file of eventsFiles) {
    if (!fs.existsSync(file)) continue;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev?.type !== 'token_usage') continue;
      const ts = Date.parse(ev.ts);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      const provider = ev.provider ?? 'unknown';
      const model = ev.model ?? 'unknown';
      const key = `${provider}::${model}`;
      if (!byModel.has(key)) {
        byModel.set(key, {
          model, provider,
          tokensIn: 0, tokensOut: 0, tokensTotal: 0, events: 0,
          cacheReads: 0, cacheWrites: 0, cacheHitRatio: 0, costUSD: 0,
        });
      }
      const m = byModel.get(key);
      m.tokensIn += Number(ev.promptTokens ?? 0);
      m.tokensOut += Number(ev.completionTokens ?? 0);
      m.tokensTotal += Number(ev.totalTokens ?? (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0));
      m.cacheReads += Number(ev.cacheReads ?? 0);
      m.cacheWrites += Number(ev.cacheWrites ?? 0);
      m.events += 1;
    }
  }
  for (const m of byModel.values()) {
    const denom = m.tokensIn + m.cacheReads;
    m.cacheHitRatio = denom > 0 ? m.cacheReads / denom : 0;
    m.costUSD = estimateCost(m.model, m.tokensIn, m.tokensOut);
  }
  return Array.from(byModel.values()).sort((a, b) => b.tokensTotal - a.tokensTotal);
}

function usageStatsToDTO(stats: any, months: any[]): UsageAggregateDTO {
  const totalTokens = Math.max(stats.totalTokens || 0, 1);
  const models = (stats.models ?? []).map((m: any) => ({
    model: m.model,
    provider: m.provider,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    totalTokens: m.tokensTotal,
    events: m.events,
    percentOfTotal: stats.totalTokens > 0 ? (m.tokensTotal / totalTokens) * 100 : 0,
    cacheReads: m.cacheReads ?? 0,
    cacheWrites: m.cacheWrites ?? 0,
    cacheHitRatio: m.cacheHitRatio ?? 0,
    costUSD: m.costUSD ?? 0,
  }));
  return {
    totalEvents: stats.totalEvents,
    totalTokens: stats.totalTokens,
    totalSessions: stats.totalSessions,
    activeDays: stats.activeDays,
    totalDays: stats.totalDays,
    firstDate: stats.firstDate,
    lastDate: stats.lastDate,
    favoriteModel: stats.favoriteModel,
    longestSessionMs: stats.longestSessionMs,
    totalCacheReads: stats.totalCacheReads ?? 0,
    totalCacheWrites: stats.totalCacheWrites ?? 0,
    cacheHitRatioGlobal: stats.cacheHitRatioGlobal ?? 0,
    totalCostUSD: stats.totalCostUSD ?? 0,
    daily: stats.daily,
    models,
    months,
    streaks: {
      current: stats.currentStreak,
      longest: stats.longestStreak,
      firstDate: stats.firstDate,
      lastDate: stats.lastDate,
      activeDays: stats.activeDays,
      totalDays: stats.totalDays,
      mostActiveDay: stats.mostActiveDay,
      mostActiveDayEvents: stats.mostActiveDayEvents,
    },
  };
}

function doctorReportToDTO(report: any): DoctorReportDTO {
  return {
    passed: Boolean(report.passed),
    passes: report.passes ?? 0,
    stacks: (report.stacks ?? []).map((s: any) => ({
      type: s.type,
      label: s.label ?? s.type,
      dir: s.dir,
      framework: s.framework,
    })),
    finalResults: (report.finalResults ?? []).map((r: any) => ({
      stack: typeof r.stack === 'string' ? r.stack : (r.stack?.type ?? 'unknown'),
      label: typeof r.stack === 'object' && r.stack?.label ? r.stack.label : (r.label ?? 'stack'),
      phase: r.phase ?? 'unknown',
      success: Boolean(r.success),
      // core/doctor.ts:DoctorCheckResult.errors é uma `string` (stderr/stdout
      // capturado). DTO expõe `string[]` pra UI conseguir renderizar com
      // markup por linha — split + drop linhas vazias preserva a info.
      errors: typeof r.errors === 'string'
        ? r.errors.split(/\r?\n/).filter((line: string) => line.trim().length > 0)
        : Array.isArray(r.errors)
          ? r.errors.map(String).filter((line: string) => line.trim().length > 0)
          : [],
      durationMs: r.durationMs ?? 0,
    })),
  };
}

// Available fields in the TUI statusline. Hardcoded catalog because the
// agent-core lists them implicitly via field renderers in
// src/repl/tui/StatusLine.tsx — we don't want to introspect the React tree.
const STATUSLINE_FIELD_CATALOG: StatuslineFieldDTO[] = [
  { name: 'status', description: 'Indicador rodando/ocioso' },
  { name: 'msgs', description: 'Quantidade de mensagens da sessão' },
  { name: 'ctx', description: '% de contexto consumido' },
  { name: 'tokens', description: 'Total de tokens da sessão' },
  { name: 'cache', description: '% de cache hit' },
  { name: 'rules', description: 'Permission rules carregadas' },
  { name: 'perms', description: 'Permission mode atual' },
  { name: 'cwd', description: 'Diretório de trabalho' },
  { name: 'git', description: 'Branch + status (limpo/sujo)' },
  { name: 'model', description: 'Modelo ativo' },
];

// Catalog of feature flags surfaced to the UI. `flags.ts` is read-only by
// design — this list captures the canonical defaults documented in the
// header comment of flags.ts plus any flag actually consulted via
// isFlagEnabled() in the codebase. Keep in sync when new flags ship.
const FLAG_CATALOG: Array<{ name: string; default: boolean; description: string }> = [
  { name: 'microCompact', default: true, description: 'Compactação automática micro entre turns pra liberar contexto' },
  { name: 'fastModel', default: true, description: 'Roteamento pro modelo "fast" em tasks leves (titles, classifiers)' },
  { name: 'cacheBoundary', default: true, description: 'Marca cache boundaries automaticamente em partes estáveis do prompt' },
  { name: 'newHooks', default: true, description: 'Sistema de hooks lifecycle (PreToolUse, PostToolUse, etc.) — fallback ao legacy se off' },
  { name: 'sessionMemory', default: true, description: 'Memória persistente associada à sessão (recall automático em sessões relacionadas)' },
];

function flagsFilePath(): string {
  return path.join(os.homedir(), '.makestudio', 'flags.json');
}

function readFlagsRaw(): Record<string, boolean> {
  try {
    const raw = fs.readFileSync(flagsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function readFlags(): FlagDTO[] {
  const current = readFlagsRaw();
  return FLAG_CATALOG.map((f) => ({
    name: f.name,
    value: f.name in current ? current[f.name] : f.default,
    default: f.default,
    description: f.description,
  }));
}

function writeFlag(name: string, value: boolean): void {
  if (!FLAG_CATALOG.some((f) => f.name === name)) {
    throw new Error(`Unknown flag: ${name}`);
  }
  const current = readFlagsRaw();
  current[name] = value;
  fs.mkdirSync(path.dirname(flagsFilePath()), { recursive: true });
  fs.writeFileSync(flagsFilePath(), JSON.stringify(current, null, 2), 'utf8');
}

function buildDaemonStatus(): DaemonStatusDTO {
  const { execSync } = require('child_process') as typeof import('child_process');
  const { daemonStatus } = agentRequire('daemon');
  const base = daemonStatus();
  let cliBinary: string | undefined;
  let cliAvailable = false;
  try {
    const which = execSync('which makestudio 2>/dev/null', {
      shell: '/bin/sh',
    })
      .toString()
      .trim();
    if (which) {
      cliBinary = which;
      cliAvailable = fs.existsSync(which);
    }
  } catch {
    /* CLI not in PATH */
  }
  const platform: DaemonStatusDTO['platform'] =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : 'other';
  return {
    installed: Boolean(base?.installed),
    running: Boolean(base?.running),
    message: String(base?.message ?? ''),
    cliBinary,
    cliAvailable,
    platform,
  };
}

// ── Phase 11 helpers ───────────────────────────────────────────────────
function buildAuthStatus(): import('../../src/repl/ipc/types').AuthStatusDTO {
  try {
    const { loadConfig } = agentRequire('../config/config');
    const { parseJwtExpiryMs } = agentRequire('../network/auth');
    const cfg = loadConfig();
    if (!cfg?.token) {
      return { authenticated: false, agentInitialized };
    }
    const expiresAt = parseJwtExpiryMs(cfg.token);
    // Expired (or unparseable) tokens are treated as unauthenticated so the
    // gate falls back to LoginPage. Refresh attempts run separately via
    // AUTH_REFRESH and re-broadcast EVT_AUTH_CHANGED on success.
    if (expiresAt == null || expiresAt <= Date.now()) {
      return { authenticated: false, agentInitialized };
    }
    return {
      authenticated: true,
      email: cfg.email,
      serverUrl: cfg.serverUrl,
      expiresAt,
      userId: cfg.userId,
      tenantId: cfg.tenantId,
      agentInitialized,
    };
  } catch {
    return { authenticated: false, agentInitialized: false };
  }
}

function buildProvidersSnapshot(): import('../../src/repl/ipc/types').ProvidersSnapshotDTO {
  const { getCatalog, isOverridden } = agentRequire('ai/providers/catalog');
  const { PROVIDER_DEFAULT_BASE_URL } = agentRequire('ai/providers/types');
  const {
    listKnownProviders,
    hasProviderKey,
    getProviderKey,
    getProviderKeySource,
    maskKey,
  } = agentRequire('../config/credentials');
  const { loadSettings } = agentRequire('settings');

  const catalog = getCatalog() as Record<string, { provider: string; model: string; baseURL?: string; maxOutputTokens?: number }>;
  const tiers: Array<'fast' | 'default' | 'image'> = ['fast', 'default', 'image'];
  const entries: import('../../src/repl/ipc/types').CatalogEntryDTO[] = tiers.map((tier) => {
    const e = catalog[tier];
    return {
      tier,
      provider: e.provider,
      model: e.model,
      baseUrl: e.baseURL,
      maxOutputTokens: e.maxOutputTokens,
      hasKey: Boolean(hasProviderKey(e.provider, e.baseURL)),
      overridden: Boolean(isOverridden(tier)),
    };
  });

  const referenced = new Set(entries.map((e) => e.provider.toLowerCase()));
  const providerNames: string[] = listKnownProviders();
  // Sempre incluir os providers do catálogo, mesmo sem key, pra UI mostrar a entrada com badge "none".
  for (const e of entries) {
    if (!providerNames.some((p) => p.toLowerCase() === e.provider.toLowerCase())) {
      providerNames.push(e.provider);
    }
  }

  const providers: import('../../src/repl/ipc/types').ProviderInfoDTO[] = providerNames.map((name) => {
    const key = getProviderKey(name);
    const source = getProviderKeySource(name) as import('../../src/repl/ipc/types').ProviderKeySource;
    return {
      name,
      hasKey: Boolean(key),
      keyMasked: key ? maskKey(key) : undefined,
      source,
      defaultBaseUrl: (PROVIDER_DEFAULT_BASE_URL as Record<string, string>)[name.toLowerCase()],
      referencedByCatalog: referenced.has(name.toLowerCase()),
    };
  });

  const settings = loadSettings() as { effort?: 'low' | 'medium' | 'high' | 'max' };
  const effort = settings.effort ?? 'medium';

  return {
    entries,
    providers,
    effort,
    costs: buildProviderCosts(),
    license: buildLicenseInfo(),
  };
}

function buildProviderCosts(): import('../../src/repl/ipc/types').ProviderCostBreakdownDTO[] {
  const { getCatalog } = agentRequire('ai/providers/catalog');
  const { pricingForModel } = agentRequire('costs');
  const catalog = getCatalog() as Record<string, { provider: string; model: string }>;
  const tiers: Array<'fast' | 'default' | 'image'> = ['fast', 'default', 'image'];
  return tiers.map((tier) => {
    const e = catalog[tier];
    const p = pricingForModel(e.model) as { in: number; out: number } | null;
    return {
      tier,
      provider: e.provider,
      model: e.model,
      inputPricePer1M: p?.in ?? 0,
      outputPricePer1M: p?.out ?? 0,
      hasPricing: p !== null,
    };
  });
}

function buildLicenseInfo(): import('../../src/repl/ipc/types').LicenseInfoDTO | undefined {
  const { getLastHeartbeat } = agentRequire('../network/heartbeat');
  const hb = getLastHeartbeat() as {
    response: { license?: any } | null;
    at: number | null;
    nextAt: number | null;
  };
  if (!hb.response?.license) return undefined;
  return {
    valid: Boolean(hb.response.license.valid),
    reason: hb.response.license.reason,
    plan: hb.response.license.plan,
    seats: hb.response.license.seats,
    tasks: hb.response.license.tasks,
    lastHeartbeatAt: hb.at ?? undefined,
    nextHeartbeatAt: hb.nextAt ?? undefined,
  };
}

/**
 * SSRF guard for the test-connection feature: a malicious renderer (or a
 * compromised webview) could pass `baseUrl: 'http://attacker.com'` and the
 * main process would happily forward the API key as Authorization. Bloqueia
 * schemes não-https (exceto http://localhost pra dev), hosts privados
 * (RFC1918 / link-local / loopback IP literals), e file://.
 */
function isSafeProviderBaseUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `unsupported scheme ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  // Allow http only for localhost (dev convenience). Everything else must be https.
  if (parsed.protocol === 'http:' && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    return { ok: false, reason: 'http scheme only allowed for localhost' };
  }
  // Block IP literals in private ranges so an attacker can't probe internal services.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0) {
      // localhost (127.x) é OK quando o scheme é http (já filtrado acima).
      if (host !== '127.0.0.1') return { ok: false, reason: 'private IP range blocked' };
    }
  }
  return { ok: true };
}

/**
 * Test connection to a provider by calling its /models endpoint with the
 * stored API key. Times out at 5s via AbortController so a hung server
 * doesn't pin the renderer button. Returns ok+latencyMs on success or
 * structured error info on failure (no throw — UI shows the result).
 */
async function testProviderConnection(
  provider: string,
  baseUrl?: string,
): Promise<import('../../src/repl/ipc/types').ProviderTestResultDTO> {
  const { getProviderKey } = agentRequire('../config/credentials');
  const { PROVIDER_DEFAULT_BASE_URL } = agentRequire('ai/providers/types');
  const key = getProviderKey(provider, baseUrl ?? null) as string | null;
  if (!key) {
    return { ok: false, error: 'No API key configured for this provider' };
  }
  const baseRaw = (baseUrl ?? (PROVIDER_DEFAULT_BASE_URL as Record<string, string>)[provider.toLowerCase()] ?? '').replace(/\/+$/, '');
  if (!baseRaw) {
    return { ok: false, error: 'Provider has no default base URL — pass baseUrl explicitly' };
  }
  const safety = isSafeProviderBaseUrl(baseRaw);
  if (safety.ok !== true) {
    return { ok: false, error: `baseUrl bloqueado: ${safety.reason}` };
  }
  const url = `${baseRaw}/models`;
  // Anthropic uses x-api-key, others use Bearer. Detect by hostname/keyword.
  const isAnthropic = provider.toLowerCase() === 'anthropic' || baseRaw.includes('anthropic.com');
  const headers: Record<string, string> = isAnthropic
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  if ((timer as any).unref) (timer as any).unref();
  const startedAt = Date.now();
  try {
    const res: any = await (globalThis as any).fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}` };
    }
    let modelEcho: string | undefined;
    try {
      const body = await res.json();
      // OpenAI: {data: [{id: 'gpt-4'}, ...]}, Anthropic: {data: [{id: 'claude-...'}]}, etc.
      if (Array.isArray(body?.data) && body.data[0]?.id) {
        modelEcho = String(body.data[0].id);
      }
    } catch { /* ignore parse — connection itself is OK */ }
    return { ok: true, latencyMs, status: res.status, modelEcho };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err?.name === 'AbortError' ? 'timeout (5s)' : (err?.message ?? String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Phase 5/6 helpers ──────────────────────────────────────────────────
function sessionToDTO(s: any): import('../../src/repl/ipc/types').SessionSummaryDTO {
  return {
    sessionId: s.sessionId,
    file: s.file,
    startedAt: s.startedAt,
    lastUpdatedAt: s.lastUpdatedAt,
    title: s.title,
    summary: s.summary,
    tags: s.tags,
    messageCount: s.messageCount,
    cwd: s.cwd,
    firstUserMessage: s.firstUserMessage,
  };
}

function checkpointToDTO(
  c: any,
): import('../../src/repl/ipc/types').RewindCheckpointDTO {
  return {
    turn: c.turn,
    startedAt: c.startedAt,
    userMessage: c.userMessage,
    fileCount: Array.isArray(c.files) ? c.files.length : 0,
    status: 'clean',
  };
}

function snapshotToDTO(
  s: any,
): import('../../src/repl/ipc/types').FileHistoryEntryDTO {
  return {
    path: s.fullPath ?? s.file,
    timestamp:
      s.createdAt instanceof Date
        ? s.createdAt.toISOString()
        : typeof s.createdAt === 'string'
          ? s.createdAt
          : new Date(s.createdAt).toISOString(),
    sizeBytes: s.sizeBytes,
  };
}

function memoryToDTO(
  t: any,
): import('../../src/repl/ipc/types').MemoryTopicDTO {
  const preview = (t.body ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
  return {
    name: t.name,
    description: t.description,
    type: t.type ?? 'user',
    tags: t.tags ?? [],
    accessCount: t.accessCount ?? 0,
    lastAccessedAt: t.lastAccessedAt,
    preview,
    bodyLength: (t.body ?? '').length,
  };
}

function messagesToMarkdown(messages: any[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role ?? 'unknown';
    const content =
      typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content, null, 2);
    lines.push(`## ${role}`);
    lines.push('');
    lines.push(content);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Window / app plumbing ───────────────────────────────────────────────
ipcMain.handle('app:version', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
}));

ipcMain.on('notification', (_event, { title, body }: { title: string; body: string }) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});

// ── File / image dialogs ────────────────────────────────────────────────
ipcMain.handle(CH.DIALOG_OPEN_FILE, async (_e, args?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[]> => {
  if (!mainWindow) return [];
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: args?.filters ?? [{ name: 'Todos', extensions: ['*'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle(CH.WINDOW_OPEN_EXTERNAL, (_e, url: string): void => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle(CH.SHELL_SHOW_ITEM, (_e, fpath: string): void => {
  if (typeof fpath === 'string') shell.showItemInFolder(fpath);
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

// ── Project file lister (@file completion) ─────────────────────────────
const FILE_LIST_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'target',
  '.idea',
  '.vscode',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.makestudio',
]);
const FILE_LIST_MAX_WALK = 6000;

function listProjectFiles(cwd: string, query: string, limit: number): string[] {
  const q = (query || '').trim().toLowerCase();
  const walked: string[] = [];
  const stack: string[] = [cwd];
  let visited = 0;
  while (stack.length > 0 && visited < FILE_LIST_MAX_WALK) {
    const dir = stack.pop() as string;
    let entries: import('fs').Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      visited++;
      if (visited > FILE_LIST_MAX_WALK) break;
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (FILE_LIST_SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(cwd, full);
      walked.push(rel);
    }
  }
  if (!q) return walked.slice(0, limit);
  // Fuzzy subsequence match, case-insensitive. Ordena por: ocorrências
  // contíguas > matches em path > matches em filename.
  const scored: Array<{ path: string; score: number }> = [];
  for (const rel of walked) {
    const lower = rel.toLowerCase();
    const score = fuzzyScore(lower, q);
    if (score > 0) scored.push({ path: rel, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  if (haystack.includes(needle)) {
    // Substring match — boost especialmente quando aparece no basename.
    const base = haystack.slice(haystack.lastIndexOf('/') + 1);
    return base.includes(needle) ? 1000 - haystack.length : 500 - haystack.length;
  }
  let hi = 0;
  let matched = 0;
  let consecutive = 0;
  let bestRun = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const c = needle[ni];
    let found = -1;
    for (let i = hi; i < haystack.length; i++) {
      if (haystack[i] === c) {
        found = i;
        break;
      }
    }
    if (found < 0) return 0;
    if (found === hi) consecutive++;
    else {
      bestRun = Math.max(bestRun, consecutive);
      consecutive = 1;
    }
    hi = found + 1;
    matched++;
  }
  bestRun = Math.max(bestRun, consecutive);
  return matched + bestRun * 4 - haystack.length * 0.05;
}

// ═══════════════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════════════

function adjustUiScale(delta: number, forceValue?: number): void {
  try {
    const dataDir = process.env.MAKESTUDIO_DATA_DIR ?? path.join(require('os').homedir(), '.makestudio');
    const settingsPath = path.join(dataDir, 'settings.json');
    let current = 1.0;
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      current = typeof raw.uiScale === 'number' ? raw.uiScale : 1.0;
    }
    const next = Math.min(2.0, Math.max(0.5, Math.round(((forceValue ?? current + delta)) * 20) / 20));
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      raw.uiScale = next;
      fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.setZoomFactor(next);
    }
    // Broadcast to renderer so settings slider updates.
    broadcast(CH.EVT_SETTINGS_CHANGED, { uiScale: next });
  } catch { /* ignore */ }
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  type MenuItem = Parameters<typeof Menu.buildFromTemplate>[0][number];
  const template: MenuItem[] = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' as const },
      { type: 'separator' as const },
      { role: 'services' as const },
      { type: 'separator' as const },
      { role: 'hide' as const },
      { role: 'hideOthers' as const },
      { role: 'unhide' as const },
      { type: 'separator' as const },
      { role: 'quit' as const },
    ]}] : []),
    {
      label: 'Arquivo',
      submenu: [
        {
          label: 'Novo bate-papo',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send(CH.EVT_NAVIGATE, { path: '/' }),
        },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'Visualizar',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        {
          label: 'Aumentar zoom',
          accelerator: 'CmdOrCtrl+=',
          click: () => adjustUiScale(0.1),
        },
        {
          label: 'Diminuir zoom',
          accelerator: 'CmdOrCtrl+-',
          click: () => adjustUiScale(-0.1),
        },
        {
          label: 'Resetar zoom (100%)',
          accelerator: 'CmdOrCtrl+0',
          click: () => adjustUiScale(0, 1.0),
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// macOS shows `app.name` in the menu bar. In dev mode (`electron .`)
// Electron defaults to "Electron" because the bundled binary's
// Info.plist hasn't been replaced. Force the brand name early — also
// affects the about panel and the dock label.
app.setName('MakeStudio Code');
if (process.platform === 'darwin') {
  try {
    app.setAboutPanelOptions({
      applicationName: 'MakeStudio Code',
      applicationVersion: app.getVersion(),
    });
  } catch { /* ignore */ }
}

app.whenReady().then(async () => {
  buildAppMenu();
  createWindow();
  createTray();

  // Global shortcut escape hatch — resets zoom to 100% even when the UI
  // is completely unreachable due to excessive zoom level.
  globalShortcut.register('CommandOrControl+Shift+0', () => adjustUiScale(0, 1.0));

  // Broadcaster é conectado cedo pra que o mensagens iniciais do bootAgent
  // (hooks SessionStart emitindo tuiLog) cheguem ao renderer.
  setBroadcaster((channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  });

  registerIpcHandlers();

  // Tentativa silenciosa de refresh quando o access token está expirado
  // mas o refreshToken ainda é válido — evita bounçar pra LoginPage quem
  // só ficou um tempo sem abrir o app.
  try {
    const { loadConfig } = agentRequire('../config/config');
    const { parseJwtExpiryMs } = agentRequire('../network/auth');
    const cfg = loadConfig();
    if (cfg?.token && cfg?.refreshToken) {
      const expiresAt = parseJwtExpiryMs(cfg.token);
      if (expiresAt == null || expiresAt <= Date.now()) {
        const { refreshAuthToken } = agentRequire('../network/api-client');
        await refreshAuthToken();
      }
    }
  } catch {
    /* refresh é best-effort; se falhar o gate cai pra LoginPage */
  }

  // Activate the session audit log BEFORE bootAgent — every event the agent
  // core emits (tool_call, tool_result, llm_request, llm_response, bash_*,
  // permission_*, info/warn/error) goes to ~/.makestudio/debug/<sid>.jsonl
  // and ~/.makestudio/debug/latest is symlinked to it. Same machinery the
  // CLI uses behind --debug; in the desktop app we always enable so any
  // weird turn (DeepSeek thinking forever, hook failures, etc.) leaves a
  // forensic trail without the user having to repro under a special flag.
  try {
    const dbg = agentRequire('debug-log');
    dbg.initDebugLog(true);
    dbg.dbgInfo('electron_boot', { pid: process.pid, cwd: process.cwd() });
  } catch { /* */ }

  // Boot do agent core — em paralelo com o carregamento da janela.
  try {
    const { bootAgent } = agentRequire('main-bootstrap');
    agent = await bootAgent();
    // O bootstrap só roda ctx.initialize() se houver token válido.
    // Espelhamos isso aqui (mesma lógica de buildAuthStatus) pra saber se
    // precisa de initialize tardio após login via UI (handler AUTH_LOGIN).
    agentInitialized = buildAuthStatus().authenticated;
    // Boot ready signal goes via the busy=false event the renderer
    // already listens to — no need to drop a banner in the chat. The
    // previous "agent pronto · cwd: ..." was visual noise that confused
    // users into thinking it was a system error or status they had to act on.

    // ── Phase 13: wire MCP event bus → broadcast ────────────────────────
    // mcp.ts emits 'server_status_changed' and 'log' (not 'status'/'stderr').
    try {
      const { mcpEvents } = agentRequire('mcp');
      mcpEvents.on('server_status_changed', (data: { name: string; status: string; error?: string; code?: number }) => {
        broadcast(CH.EVT_MCP_STATUS, {
          name: data.name,
          status: data.status,
          error: data.error,
          code: data.code,
        } as import('../../src/repl/ipc/types').McpStatusEventDTO);
      });
      mcpEvents.on('log', (data: { name: string; stream: string; lines: string[] }) => {
        broadcast(CH.EVT_MCP_LOG, {
          server: data.name,
          stream: 'stderr',
          lines: data.lines,
          ts: new Date().toISOString(),
        } as import('../../src/repl/ipc/types').McpLogEventDTO);
      });
    } catch { /* MCP bus not available — non-fatal */ }

    // ── Phase 13: wire cluster discovery events → broadcast ─────────────
    try {
      const { onStateChange } = agentRequire('cluster/swim');
      onStateChange((member: any) => {
        try {
          const { getClusterSnapshot } = agentRequire('cluster/snapshot');
          const snap = getClusterSnapshot();
          broadcast(CH.EVT_PEERS_UPDATE, snap);
        } catch { /* */ }
      });
    } catch { /* cluster not running — non-fatal */ }

    // ── Phase 16: schedule-due poller → OS notification + EVT_SCHEDULE_DUE
    try {
      const POLL_MS = 60_000;
      const schedulePoll = setInterval(() => {
        try {
          const { listAllSchedules } = agentRequire('schedule');
          const now = Date.now();
          const schedules: any[] = listAllSchedules();
          for (const s of schedules) {
            if (!s.enabled || !s.nextRunAt) continue;
            const due = new Date(s.nextRunAt).getTime();
            if (due > now || due < now - POLL_MS * 2) continue;
            broadcast(CH.EVT_SCHEDULE_DUE, { scheduleId: s.id, name: s.name ?? s.id });
            if (Notification.isSupported()) {
              new Notification({
                title: 'MakeStudio — Agenda',
                body: `Tarefa "${s.name ?? s.id}" está pronta para rodar.`,
              }).show();
            }
          }
        } catch { /* non-fatal */ }
      }, POLL_MS);
      app.on('before-quit', () => clearInterval(schedulePoll));
    } catch { /* non-fatal */ }

  } catch (err: any) {
    agentBootError = err;
    // eslint-disable-next-line no-console
    console.error('[bootAgent] failed', err);
    // Deixa a janela abrir ainda assim — useful pra dev.
    setTimeout(() => {
      broadcast(CH.EVT_MESSAGE_ADD, {
        id: `boot-err-${Date.now()}`,
        role: 'error',
        text: `Falha ao iniciar o agente: ${err.message}`,
        timestamp: Date.now(),
      });
    }, 500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async (ev) => {
  if (agent) {
    ev.preventDefault();
    try {
      await agent.shutdown();
    } catch {
      /* */
    }
    agent = null;
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STUDIO MODE — Kanban tab (BrowserView embedded, zero infra, SQLite)
// ═══════════════════════════════════════════════════════════════════════════
//
// When the renderer clicks the "Kanban" tab, the main process:
//   1. Starts the mks-kanban NestJS backend (SQLite, random port) if not yet running.
//   2. Creates a BrowserView with the kanban preload.
//   3. Positions it at y = TAB_BAR_HEIGHT so the React tab bar remains visible.
//   4. Toggles it on/off on subsequent tab clicks.
//
// Auth: a local HS256 JWT_SECRET is generated once (same as kanban product),
// and the backend's /auth/desktop-token endpoint issues a 1-year token.
// The BrowserView's preload (kanban's preload.js) bridges kanban:auth:get/set
// to the main process, which uses the same AuthSession keychain storage.

import * as crypto from 'crypto';
import * as backend from '../kanban/backendProcess';
import * as kLibrary from '../kanban/boardLibrary';
import { readSession as kReadSession, writeSession as kWriteSession, clearSession as kClearSession, AuthSession as KAuthSession } from '../kanban/authStore';

const TAB_BAR_H = 40; // must match StudioTabBar height in the renderer
let kanbanView: Electron.BrowserView | null = null;
let kanbanBackendStarted = false;
let kanbanPageLoaded = false;   // flag: URL já foi carregada — nunca recarrega
let kanbanDevToolsOpened = false; // abre DevTools apenas uma vez

// ── Local JWT secret (same pattern as kanban/main.ts) ───────────────────
function getOrCreateKanbanSecret(): string {
  const file = path.join(app.getPath('userData'), 'kanban-secret.json');
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file);
      const { safeStorage } = require('electron') as typeof import('electron');
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf-8');
    }
  } catch { /* corrupt — regenerate */ }
  const { safeStorage } = require('electron') as typeof import('electron');
  const secret = crypto.randomBytes(48).toString('hex');
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(secret)
    : Buffer.from(secret, 'utf-8');
  fs.writeFileSync(file, data, { mode: 0o600 });
  return secret;
}

// ── Ensure kanban backend is running ────────────────────────────────────
async function ensureKanbanBackend(): Promise<void> {
  if (kanbanBackendStarted) return;
  kanbanBackendStarted = true;
  try {
    const jwtSecret = getOrCreateKanbanSecret();
    const active = (() => {
      const a = kLibrary.getActive();
      if (a && fs.existsSync(a.filePath)) return a;
      const entries = kLibrary.list().filter((e) => fs.existsSync(e.filePath));
      if (entries.length > 0) return kLibrary.setActive(entries[0].id)!;
      const fresh = kLibrary.create('Meu Kanban');
      return kLibrary.setActive(fresh.id)!;
    })();
    await backend.start({ databasePath: active.filePath, jwtSecret });
    await backend.waitForHealth();
    const tokenData = await backend.fetchDesktopToken();
    kWriteSession({
      token: tokenData.token,
      accessTokenExp: tokenData.tokenExpires,
      user: tokenData.user as KAuthSession['user'],
    });
    console.log('[studio] kanban backend ready at', backend.getOrigin());
  } catch (err) {
    kanbanBackendStarted = false;
    console.error('[studio] kanban backend failed to start:', err);
    throw err;
  }
}

// ── Create / position the kanban BrowserView ────────────────────────────
function getOrCreateKanbanView(): Electron.BrowserView {
  if (kanbanView) return kanbanView;
  const { BrowserView } = require('electron') as typeof import('electron');
  const preloadPath = path.join(DESKTOP_DIST_DIR, 'products', 'kanban', 'preload.js');
  kanbanView = new BrowserView({
    webPreferences: {
      preload: fs.existsSync(preloadPath) ? preloadPath : undefined,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  return kanbanView;
}

function positionKanbanView(): void {
  if (!kanbanView || !mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  kanbanView.setBounds({ x: 0, y: TAB_BAR_H, width: w, height: Math.max(0, h - TAB_BAR_H) });
  // DevTools apenas uma vez, em dev
  if (process.env.NODE_ENV === 'development' && !kanbanDevToolsOpened) {
    kanbanDevToolsOpened = true;
    kanbanView.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── IPC: tab-bar ready (renderer tells us height is mounted) ────────────
ipcMain.handle('studio:tab-bar-ready', (_e, { height }: { height: number }) => {
  // We hardcode TAB_BAR_H above — this is just acknowledgment.
  void height;
});

// ── IPC: switch tab ──────────────────────────────────────────────────────
ipcMain.handle('studio:switch-tab', async (_e, { tab }: { tab: 'makestudio' | 'kanban' }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (tab === 'kanban') {
    // Start backend (idempotent)
    try {
      await ensureKanbanBackend();
    } catch (err) {
      console.error('[studio] could not start kanban backend:', err);
      return { error: String(err) };
    }

    const view = getOrCreateKanbanView();
    mainWindow.addBrowserView(view);
    positionKanbanView();

    // Carrega a URL apenas uma vez — nunca recarrega ao voltar para a aba
    if (!kanbanPageLoaded) {
      kanbanPageLoaded = true;
      kanbanView!.webContents.loadURL(backend.getOrigin() + '/').catch((e) =>
        console.error('[studio] kanban view load failed:', e),
      );
    }
  } else {
    // Back to MakeStudio — remove kanban view
    if (kanbanView) {
      mainWindow.removeBrowserView(kanbanView);
    }
  }
});

// ── Kanban auth bridge (same IPC channels as kanban/main.ts) ────────────
ipcMain.handle('kanban:auth:get', () => kReadSession());
ipcMain.handle('kanban:auth:set', (_e: IpcMainInvokeEvent, session: KAuthSession) => kWriteSession(session));
ipcMain.handle('kanban:auth:clear', () => kClearSession());

// ── Board library IPC ────────────────────────────────────────────────────
ipcMain.handle('boardLibrary:list', () => kLibrary.list());
ipcMain.handle('boardLibrary:active', () => kLibrary.getActive());
ipcMain.handle('boardLibrary:create', (_e: IpcMainInvokeEvent, name: string) => kLibrary.create(name));
ipcMain.handle('boardLibrary:rename', (_e: IpcMainInvokeEvent, id: string, name: string) => kLibrary.rename(id, name));
ipcMain.handle('boardLibrary:remove', (_e: IpcMainInvokeEvent, id: string, deleteFile?: boolean) => kLibrary.remove(id, deleteFile));
ipcMain.handle('boardLibrary:open', async (_e: IpcMainInvokeEvent, id: string) => {
  const entry = kLibrary.setActive(id);
  if (!entry) throw new Error(`board ${id} not in library`);
  const jwtSecret = getOrCreateKanbanSecret();
  await backend.switchTo(entry.filePath, jwtSecret);
  const tokenData = await backend.fetchDesktopToken();
  kWriteSession({ token: tokenData.token, accessTokenExp: tokenData.tokenExpires, user: tokenData.user as KAuthSession['user'] });
  if (kanbanView && !kanbanView.webContents.isDestroyed()) {
    kanbanView.webContents.loadURL(backend.getOrigin() + '/kanban').catch(() => {});
  }
  return { entry };
});

// ── Resize: reposition kanban view when window resizes ──────────────────
app.whenReady().then(() => {
  // Hook into window resize AFTER the window is created
  const origCreateWindow = createWindow;
  // Listen globally after any window is created
  app.on('browser-window-created', (_e: Electron.Event, win: BrowserWindow) => {
    win.on('resize', () => positionKanbanView());
    win.on('maximize', () => positionKanbanView());
    win.on('unmaximize', () => positionKanbanView());
  });
});

// ── Shutdown: stop kanban backend ────────────────────────────────────────
app.on('before-quit', async () => {
  if (kanbanBackendStarted) await backend.stop().catch(() => {});
});
