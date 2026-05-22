import { useEffect } from 'react';
import { subscribe, invoke } from '../ipc/client';
import { useChatStore } from '../store';
import * as CH from '@shared/channels';
import type {
  TuiMessageDTO,
  AgentState,
  CurrentToolDTO,
} from '@shared/types';

/**
 * Subscreve aos eventos do agente e hidrata o Zustand store.
 * Deve ser montado UMA VEZ na raiz (App.tsx).
 */
export function useAgentStream(): void {
  useEffect(() => {
    const chat = useChatStore.getState();

    // ── hydration inicial ─────────────────────────────────────────
    (async () => {
      try {
        const [state, messages] = await Promise.all([
          invoke<void, AgentState>(CH.AGENT_STATE),
          invoke<void, TuiMessageDTO[]>(CH.AGENT_MESSAGES),
        ]);
        useChatStore.setState({
          messages,
          msgsCount: state.messagesCount,
          busy: state.busy,
          busyLabel: state.busyLabel,
          contextPct: state.contextPct,
          currentTool: state.currentTool,
          lastTool: state.lastTool,
          agentSummary: state.agentSummary,
          streamTokens: state.streamTokens,
          model: state.model,
          totalTokens: state.totalTokens,
        });
      } catch {
        /* main pode não ter respondido ainda — eventos seguintes preenchem */
      }

      // VS Code embed: pull the CURRENT active file on mount. The
      // IDE_ACTIVE_FILE broadcast is fire-and-forget — the host computes
      // the pin ~800ms after activate(), usually BEFORE this webview has
      // mounted and registered its subscribe(). Without this pull the
      // chip only ever appears after the user switches editor tabs.
      // No-ops on Electron/CLI (handler simply isn't registered there).
      try {
        const active = await invoke<
          void,
          { path: string; fileName: string; languageId?: string } | null
        >(CH.IDE_ACTIVE_FILE_GET);
        if (active) useChatStore.getState().setActiveFile(active);
      } catch {
        /* not running inside the VS Code host — fine */
      }
    })();

    // ctx.providerInfo lands async after `/repl-chat/info`. When the user
    // sits at the welcome screen without sending anything, no EVT_BUSY ever
    // toggles to `false`, so the model badge stays as `—`. Poll the state
    // every 1.5s for the first ~10s to pick up the model name as soon as
    // providerInfo is populated.
    let polls = 0;
    const modelPoll = window.setInterval(() => {
      polls += 1;
      const current = useChatStore.getState().model;
      if (current || polls > 6) {
        window.clearInterval(modelPoll);
        return;
      }
      invoke<void, AgentState>(CH.AGENT_STATE)
        .then((s) => {
          if (s.model) {
            useChatStore.setState({ model: s.model });
            window.clearInterval(modelPoll);
          }
        })
        .catch(() => { /* */ });
    }, 1_500);

    // ── subscribes ────────────────────────────────────────────────
    const offs: Array<() => void> = [];

    offs.push(
      subscribe<TuiMessageDTO>(CH.EVT_MESSAGE_ADD, (m) => {
        // eslint-disable-next-line no-console
        console.log('[stream] EVT_MESSAGE_ADD', m.role, m.id, (m.text ?? '').slice(0, 40));
        chat.addMessage(m);
      }),
    );
    offs.push(
      subscribe<{ id: string; patch: Partial<TuiMessageDTO> }>(
        CH.EVT_MESSAGE_UPDATE,
        ({ id, patch }) => {
          // eslint-disable-next-line no-console
          console.log('[stream] EVT_MESSAGE_UPDATE', id, Object.keys(patch));
          chat.updateMessage(id, patch);
        },
      ),
    );
    offs.push(subscribe(CH.EVT_MESSAGE_CLEAR, () => chat.clearMessages()));
    offs.push(
      subscribe<{ busy: boolean; label: string }>(CH.EVT_BUSY, ({ busy, label }) => {
        chat.setBusy(busy, label);
        // ctx.providerInfo is populated async during boot — the initial
        // AGENT_STATE invoke (above) often fires BEFORE /repl-chat/info
        // returns, so state.model comes back null and the badge shows '—'
        // forever. Re-fetch state on every busy→false (turn end / boot
        // settle) so the model name appears as soon as it's available.
        if (!busy) {
          invoke<void, AgentState>(CH.AGENT_STATE)
            .then((s) => {
              if (s.model) useChatStore.setState({ model: s.model });
            })
            .catch(() => { /* */ });
        }
      }),
    );
    offs.push(
      subscribe<number>(CH.EVT_STREAM_TOKENS, (n) => chat.setStreamTokens(n)),
    );
    offs.push(
      subscribe<CurrentToolDTO>(CH.EVT_CURRENT_TOOL, (info) =>
        chat.setCurrentTool(info),
      ),
    );
    offs.push(
      subscribe<string | null>(CH.EVT_AGENT_SUMMARY, (s) =>
        chat.setAgentSummary(s),
      ),
    );
    offs.push(
      subscribe<number>(CH.EVT_CONTEXT_PCT, (n) => chat.setContextPct(n)),
    );

    // After the user switches the active api-config (ModelConfigPicker),
    // main re-runs fetchProviderInfo() and broadcasts EVT_PROVIDERS_CHANGED.
    // Without this listener the chat-store's `model` field stayed pinned
    // to whatever it was at boot (or last busy=false), so the badge in the
    // status bar / input bar kept showing the OLD model even though the
    // next turn would actually use the NEW one — making it look like the
    // switch didn't take effect.
    offs.push(
      subscribe(CH.EVT_PROVIDERS_CHANGED, () => {
        invoke<void, AgentState>(CH.AGENT_STATE)
          .then((s) => {
            if (s.model) useChatStore.setState({ model: s.model });
          })
          .catch(() => { /* */ });
      }),
    );

    // VS Code embed only — IDE pushes the current active editor file so
    // we can pin a context chip above the input. `payload` is `null` when
    // the user closed the last editor.
    offs.push(
      subscribe<
        { path: string; fileName: string; languageId?: string } | null
      >(CH.IDE_ACTIVE_FILE, (payload) => {
        chat.setActiveFile(payload);
      }),
    );

    return () => {
      offs.forEach((off) => off());
      window.clearInterval(modelPoll);
    };
  }, []);
}
