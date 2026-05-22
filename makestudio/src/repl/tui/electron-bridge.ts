import { swallow } from '../../utils/log';
/**
 * Electron bridge adapter.
 *
 * Implements the TuiBridge contract AND forwards every singleton state
 * mutation of `bridge.ts` to the renderer via IPC push events.
 *
 * Strategy:
 *   - TuiBridge methods (addMessage/updateMessage/setBusy/clearMessages) —
 *     implementa direto + broadcast.
 *   - State that bridge.ts already publishes via subscriber pattern
 *     (toasts, pending picker, pending permission, usage open,
 *     transient status) — subscreve via onXxxChange e broadcasta.
 *   - State sem listener built-in (stream tokens, current tool, agent
 *     summary) — monkey-patch os setters pra broadcastar além de setar.
 */

import { broadcast } from '../ipc/broadcast';
import * as CH from '../ipc/channels';
import type {
  TuiMessageDTO,
  PickerRequest,
  PermissionRequest,
  QuestionRequest,
  ToastDTO,
  TransientStatusDTO,
  CurrentToolDTO,
  PickerItemDTO,
  PlanModeDTO,
  WorktreeDTO,
} from '../ipc/types';
import { TuiMessage } from './types';
import { installTuiBridge, uninstallTuiBridge, TuiBridge } from './bridge';
import { ReplContext } from '../context';

let nextMsgId = 1;
const liveMessages: TuiMessage[] = [];

// ─── Context pct computation ───────────────────────────────────────────
function computeContextPct(ctx: ReplContext): number {
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
    return Math.min(100, (total / maxCtx) * 100);
  } catch {
    return 0;
  }
}

// ─── TuiBridge implementation ──────────────────────────────────────────
function makeElectronBridge(ctx: ReplContext): TuiBridge {
  return {
    addMessage(m): string {
      const id = `m${nextMsgId++}`;
      const msg: TuiMessage = { ...m, id, timestamp: Date.now() };
      liveMessages.push(msg);
      broadcast(CH.EVT_MESSAGE_ADD, msg as unknown as TuiMessageDTO);
      return id;
    },

    updateMessage(id, patch): void {
      const idx = liveMessages.findIndex((m) => m.id === id);
      if (idx >= 0) liveMessages[idx] = { ...liveMessages[idx], ...patch };
      broadcast(CH.EVT_MESSAGE_UPDATE, { id, patch });
    },

    setBusy(busy, label): void {
      broadcast(CH.EVT_BUSY, { busy, label: label ?? '' });
      // Recompute context pct quando turn termina — dá feedback ao StatusBar.
      // Também dispara quando busy=true pra refletir pre-turn (user message
      // já foi adicionada no ctx.messages ao iniciar o turn).
      broadcast(CH.EVT_CONTEXT_PCT, computeContextPct(ctx));
    },

    clearMessages(): void {
      liveMessages.length = 0;
      broadcast(CH.EVT_MESSAGE_CLEAR);
      broadcast(CH.EVT_CONTEXT_PCT, computeContextPct(ctx));
    },

    getCtx(): ReplContext {
      return ctx;
    },
  };
}

export function getMessagesSnapshot(): TuiMessage[] {
  return liveMessages.slice();
}

// ─── Subscribers + monkey-patch install ────────────────────────────────
const disposers: Array<() => void> = [];

function installSubscribers(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bridge = require('./bridge');

  // Toasts
  disposers.push(
    bridge.onToastsChange(() => {
      const toasts = bridge.getToasts() as Array<{
        id: string;
        text: string;
        expiresAt: number;
        kind: 'info' | 'warn' | 'error';
      }>;
      // Publica o toast novo (último). Não tem um canal "lista" — renderer
      // gerencia a pilha de toasts a partir do push.
      const latest = toasts[toasts.length - 1];
      if (latest) {
        const payload: ToastDTO = {
          id: latest.id,
          text: latest.text,
          kind: latest.kind,
          expiresAt: latest.expiresAt,
        };
        broadcast(CH.EVT_TOAST, payload);
      }
    }),
  );

  // Pending picker — open/close
  disposers.push(
    bridge.onPendingPickerChange(() => {
      const p = bridge.getPendingPicker();
      if (p) {
        const items: PickerItemDTO[] = p.items.map((it: any) => ({
          label: String(it.label),
          detail: it.detail,
          value: it.value,
        }));
        const req: PickerRequest = {
          id: `picker-${Date.now()}`,
          items,
          title: p.title,
          placeholder: p.placeholder,
        };
        broadcast(CH.EVT_PICKER_OPEN, req);
      } else {
        broadcast(CH.EVT_PICKER_CLOSE);
      }
    }),
  );

  // Plan mode — banner top
  if (typeof bridge.onPlanModeChange === 'function') {
    disposers.push(
      bridge.onPlanModeChange(() => {
        const s = bridge.getPlanModeState();
        const payload: PlanModeDTO = {
          active: Boolean(s?.active),
          planFilePath: s?.planFilePath,
        };
        broadcast(CH.EVT_PLAN_MODE, payload);
      }),
    );
  }

  // Worktree — banner top
  if (typeof bridge.onWorktreeChange === 'function') {
    disposers.push(
      bridge.onWorktreeChange(() => {
        const s = bridge.getWorktreeState();
        const payload: WorktreeDTO = {
          active: Boolean(s?.active),
          branch: s?.branch,
          path: s?.path,
          originalCwd: s?.originalCwd,
        };
        broadcast(CH.EVT_WORKTREE, payload);
      }),
    );
  }

  // Pending question — request/close
  disposers.push(
    bridge.onPendingQuestionChange(() => {
      const q = bridge.getPendingQuestion();
      if (q) {
        const req: QuestionRequest = {
          id: `q-${Date.now()}`,
          placeholder: q.placeholder,
        };
        broadcast(CH.EVT_QUESTION_REQUEST, req);
      } else {
        broadcast(CH.EVT_QUESTION_CLOSE);
      }
    }),
  );

  // Pending permission — request/close
  disposers.push(
    bridge.onPendingPermissionChange(() => {
      const p = bridge.getPendingPermission();
      if (p) {
        const req: PermissionRequest = {
          id: `perm-${Date.now()}`,
          toolName: p.toolName,
          toolInput: p.toolInput,
          reason: p.reason,
          preview: p.preview,
          diff: p.diff,
          warning: p.warning,
        };
        broadcast(CH.EVT_PERMISSION_REQUEST, req);
      } else {
        broadcast(CH.EVT_PERMISSION_CLOSE);
      }
    }),
  );

  // Usage dashboard open/close
  if (typeof bridge.onUsageOpenChange === 'function') {
    disposers.push(
      bridge.onUsageOpenChange(() => {
        broadcast(CH.EVT_USAGE_OPEN, Boolean(bridge.getUsageOpen()));
      }),
    );
  }

  // Transient status
  if (typeof bridge.subscribeTransientStatus === 'function') {
    disposers.push(
      bridge.subscribeTransientStatus(() => {
        const text = bridge.getTransientStatus();
        if (text) {
          const payload: TransientStatusDTO = {
            text,
            ttlMs: 4000,
            setAt: Date.now(),
          };
          broadcast(CH.EVT_TRANSIENT_STATUS, payload);
        } else {
          broadcast(CH.EVT_TRANSIENT_STATUS, null);
        }
      }),
    );
  }

  // ── Subscribers for state without ad-hoc listeners ──────────────────
  // Pre-2026-05 versions of this file relied on `Object.defineProperty`
  // monkey-patches over `bridge[setterName]`. That broke after a tsx
  // upgrade that started emitting `export function` as non-configurable
  // getters — `defineProperty` then threw "Cannot redefine property",
  // the broadcast wrappers were silently dropped, and the renderer
  // stopped receiving stream-tokens / current-tool / agent-summary /
  // suggestion updates. The robust fix is to expose proper listener
  // hooks in `bridge.ts` (mirrors the pattern already used by toasts,
  // pickers, transient status, etc.) and subscribe from here.
  if (typeof bridge.onStreamTokensChange === 'function') {
    disposers.push(
      bridge.onStreamTokensChange((n: number) => {
        broadcast(CH.EVT_STREAM_TOKENS, n > 0 ? n : 0);
      }),
    );
  }

  if (typeof bridge.onCurrentToolChange === 'function') {
    disposers.push(
      bridge.onCurrentToolChange((state: { current: string | null; last: string | null }) => {
        const payload: CurrentToolDTO = { current: state.current, last: state.last };
        broadcast(CH.EVT_CURRENT_TOOL, payload);
      }),
    );
  }

  if (typeof bridge.onAgentSummaryChange === 'function') {
    disposers.push(
      bridge.onAgentSummaryChange((s: string | null) => {
        broadcast(CH.EVT_AGENT_SUMMARY, s);
      }),
    );
  }

  if (typeof bridge.onPendingSuggestionChange === 'function') {
    disposers.push(
      bridge.onPendingSuggestionChange((s: string | null) => {
        broadcast(CH.EVT_SUGGESTION, s);
      }),
    );
  }
}

function uninstallSubscribers(): void {
  for (const d of disposers) {
    try {
      d();
    } catch (err) { swallow(err); }
  }
  disposers.length = 0;
}

/**
 * Install the Electron bridge for a given ReplContext. Retorna uma
 * função de cleanup que desregistra o bridge + listeners + monkey-patches.
 */
export function installElectronBridge(ctx: ReplContext): () => void {
  installedCtx = ctx;
  const bridgeImpl = makeElectronBridge(ctx);
  installTuiBridge(bridgeImpl);
  installSubscribers();
  return () => {
    uninstallSubscribers();
    uninstallTuiBridge(bridgeImpl);
    if (installedCtx === ctx) installedCtx = null;
  };
}

/**
 * Live ReplContext after `installElectronBridge` runs. Used by the Electron
 * main handlers (Phase 11+) that need to mutate session-only fields like
 * `ctx.effort` so the change is visible to the very next chat turn — without
 * relying on disk persistence + REPL restart.
 */
let installedCtx: ReplContext | null = null;
export function getReplContext(): ReplContext | null {
  return installedCtx;
}
