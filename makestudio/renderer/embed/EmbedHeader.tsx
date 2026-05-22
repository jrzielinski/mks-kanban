import React from 'react';
import { Plus, History, Check, SquarePlus } from 'lucide-react';
import { invoke } from '../ipc/client';
import { useChatStore } from '../store';
import * as CH from '@shared/channels';
import type { SessionSummaryDTO } from '@shared/types';

/**
 * Compact header for the VSCode embed: "+ Nova sessão" on the left, title of
 * the current session in the middle, recent sessions popover on the right.
 *
 * Two distinct "new" actions:
 *   - "+ Nova"  → new session IN THIS tab (SESSIONS_FORK + AGENT_CLEAR)
 *   - new-tab   → opens a brand-new editor tab (IDE_NEW_TAB), Claude-Code
 *                 style. No-ops outside the VS Code host.
 *
 * Channels:
 *   - SESSIONS_FORK   → fork current and start fresh
 *   - SESSIONS_LIST   → load recents on popover open
 *   - SESSIONS_RESUME → switch ctx to chosen session
 *   - AGENT_CLEAR     → wipe in-memory messages after fork/resume
 *   - IDE_NEW_TAB     → open a new chat tab in the editor area
 */
export function EmbedHeader(): React.ReactElement {
  const [sessions, setSessions] = React.useState<SessionSummaryDTO[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  const messages = useChatStore((s) => s.messages);
  // The active session id is published in AgentState.activeSessionId — pulled
  // into the store by useAgentStream. Fall back to '' so comparisons work.
  const activeId = useChatStore((s: any) => s.activeSessionId) as string | undefined;

  // Derive a friendly title for the current session: first user message
  // (truncated) or "Sem título" when empty.
  const currentTitle = React.useMemo(() => {
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return 'Sem título';
    const t = (typeof firstUser.text === 'string' ? firstUser.text : '').trim();
    if (!t) return 'Sem título';
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }, [messages]);

  // Load list when the popover opens (cheap — refetches each time so the user
  // sees the most recent state).
  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<unknown, SessionSummaryDTO[]>(CH.SESSIONS_LIST, { limit: 30 })
      .then((list) => setSessions(Array.isArray(list) ? list : []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [open]);

  // Click outside closes the popover.
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const newSession = async (): Promise<void> => {
    try {
      await invoke(CH.SESSIONS_FORK, {});
      await invoke(CH.AGENT_CLEAR);
    } catch {
      /* ignore — UI já vai refrescar via events */
    }
  };

  const newTab = async (): Promise<void> => {
    try {
      await invoke(CH.IDE_NEW_TAB);
    } catch {
      /* not running inside the VS Code host — no-op */
    }
  };

  const resumeSession = async (sid: string): Promise<void> => {
    setOpen(false);
    try {
      await invoke(CH.SESSIONS_RESUME, { sessionId: sid });
    } catch {
      /* */
    }
  };

  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-1 px-2 text-[12px]">
      <button
        type="button"
        onClick={newSession}
        title="Nova sessão nesta aba"
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Plus size={13} strokeWidth={2.2} />
        <span>Nova</span>
      </button>

      <button
        type="button"
        onClick={newTab}
        title="Abrir em nova aba"
        className="inline-flex items-center rounded px-1.5 py-1 text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
      >
        <SquarePlus size={14} strokeWidth={2} />
      </button>

      <div className="mx-1 h-4 w-px bg-border-subtle" />

      <div className="min-w-0 flex-1 truncate text-text-soft" title={currentTitle}>
        {currentTitle}
      </div>

      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Sessões recentes"
          className={
            'inline-flex items-center gap-1 rounded px-2 py-1 transition-colors ' +
            (open
              ? 'bg-surface-2 text-text'
              : 'text-text-soft hover:bg-surface-2 hover:text-text')
          }
        >
          <History size={13} strokeWidth={2.2} />
          <span>Recentes</span>
        </button>

        {open && (
          <div className="absolute right-0 top-full z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-border-subtle bg-surface-1 shadow-elev">
            {loading ? (
              <div className="px-3 py-2 text-[11.5px] text-dim-soft">carregando…</div>
            ) : sessions.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-dim-soft">
                nenhuma sessão registrada
              </div>
            ) : (
              <ul>
                {sessions.map((s) => (
                  <SessionItem
                    key={s.sessionId}
                    session={s}
                    active={activeId === s.sessionId}
                    onClick={() => resumeSession(s.sessionId)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function SessionItem({
  session,
  active,
  onClick,
}: {
  session: SessionSummaryDTO;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  const label =
    session.title?.trim() ||
    session.firstUserMessage?.trim().slice(0, 60) ||
    'Sem título';
  const subtitle = formatRelativeTime(session.lastUpdatedAt);

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={
          'flex w-full items-start gap-2 px-3 py-2 text-left text-[12px] transition-colors ' +
          (active ? 'bg-primary/10 text-text' : 'text-text-soft hover:bg-surface-2 hover:text-text')
        }
      >
        <span className="mt-0.5 w-3 shrink-0">
          {active ? <Check size={12} className="text-primary" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <div className="truncate font-medium">{label}</div>
          <div className="truncate text-[10.5px] text-dim-soft">
            {subtitle}
            {session.messageCount ? ` · ${session.messageCount} msgs` : ''}
          </div>
        </span>
      </button>
    </li>
  );
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'agora';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min atrás`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h atrás`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d atrás`;
  const month = Math.floor(day / 30);
  return `${month}mês atrás`;
}
