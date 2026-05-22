/**
 * web-router.ts
 *
 * Router equivalente ao tui-router.ts mas sem os detach/remount de Ink
 * (não aplicáveis no Electron web renderer). Delega pro `routeInput`
 * universal e apenas intercepta `console.log/error` pra direcionar
 * essas saídas ao bridge, que broadcasta eventos EVT_MESSAGE_ADD.
 *
 * Fase 1a: versão enxuta. Bloco E expande com !shell handling, spawn-as-
 * child pra comandos que antes faziam detach/remount (refine/doctor/etc).
 */

import { ReplContext } from './context';

let originalConsoleLog: typeof console.log | null = null;
let originalConsoleError: typeof console.error | null = null;

function interceptOutput(enable: boolean): void {
  if (enable && !originalConsoleLog) {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    const { getTuiBridge } = require('./tui/bridge');

    console.log = (...args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      if (text.length === 0) return;
      const bridge = getTuiBridge();
      if (bridge) bridge.addMessage({ role: 'info', text });
      else originalConsoleLog?.(...(args as unknown[] as Parameters<typeof console.log>));
    };

    console.error = (...args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      const bridge = getTuiBridge();
      if (bridge) bridge.addMessage({ role: 'error', text });
      else originalConsoleError?.(...(args as unknown[] as Parameters<typeof console.error>));
    };
  } else if (!enable && originalConsoleLog) {
    console.log = originalConsoleLog;
    console.error = originalConsoleError as typeof console.error;
    originalConsoleLog = null;
    originalConsoleError = null;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function routeInputWeb(input: string, ctx: ReplContext): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // `!command` — direct shell execution. Renderer é web, não há stdin TTY
  // a proteger; mandamos o output pras mensagens como um info multi-linha.
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    if (!cmd) return;
    const { getTuiBridge } = require('./tui/bridge');
    const bridge = getTuiBridge();
    if (!bridge) return;
    const msgId = bridge.addMessage({
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolInput: { command: cmd },
      streaming: true,
      liveLines: [],
      totalLiveLines: 0,
      startedAt: Date.now(),
    });
    const { spawn } = require('child_process');
    const proc = spawn('bash', ['-c', cmd], {
      cwd: ctx.cwd,
      env: { ...process.env },
    });
    const lines: string[] = [];
    const pushLine = (raw: Buffer) => {
      const chunk = raw.toString('utf8');
      for (const line of chunk.split('\n')) {
        if (line.length === 0) continue;
        lines.push(line);
        bridge.updateMessage(msgId, {
          liveLines: lines.slice(-12),
          totalLiveLines: lines.length,
        });
      }
    };
    proc.stdout?.on('data', pushLine);
    proc.stderr?.on('data', pushLine);
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      proc.on('exit', (code: number | null) => {
        bridge.updateMessage(msgId, {
          streaming: false,
          toolDurationMs: Date.now() - startedAt,
          toolOutput: lines.join('\n'),
          liveLines: undefined,
          totalLiveLines: undefined,
        });
        if (code !== 0 && code !== null) {
          bridge.addMessage({ role: 'info', text: `(exit ${code})` });
        }
        resolve();
      });
      proc.on('error', (err: Error) => {
        bridge.updateMessage(msgId, {
          streaming: false,
          toolDurationMs: Date.now() - startedAt,
          toolOutput: String(err),
        });
        resolve();
      });
    });
    return;
  }

  // Plain AI chat (não slash command) — força handleAIChatStream que
  // usa `showPermissionPrompt` via bridge em vez do `handleAIChat`
  // (não-stream) que cai em `readline.createInterface(process.stdin)` e
  // trava no Electron porque não há TTY. O router universal entra em
  // handleAIChat por default — só faz sentido pro CLI Ink.
  if (!trimmed.startsWith('/')) {
    interceptOutput(true);
    try {
      const { handleAIChatStream } = require('./ai/chat');
      await handleAIChatStream(input, ctx);
    } finally {
      interceptOutput(false);
    }
    return;
  }

  // Slash commands — passa pelo router universal (skills, plugins, built-ins).
  interceptOutput(true);
  try {
    const { routeInput } = require('./router');
    // routeInput do REPL terminal recebe (input, ctx, rl?) — passamos null
    // pro rl porque não há readline no Electron. Funções do router que
    // dependem de rl (resume, login interativo) caem em askTuiOrReadline
    // que detecta bridge e roteia via pendingQuestion — OK.
    await routeInput(input, ctx, null as unknown as never);
  } finally {
    interceptOutput(false);
  }
}
