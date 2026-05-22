import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useChatStore } from '../../store';
import { ModelConfigPicker } from '../common/ModelConfigPicker';

/**
 * StatusBar minimalista, estilo macOS: discreta, monoespaçada nos meta,
 * mostra atividade só quando relevante.
 */
export function StatusBar(): React.ReactElement | null {
  const busy = useChatStore((s) => s.busy);
  const busyLabel = useChatStore((s) => s.busyLabel);
  const busyStartedAt = useChatStore((s) => s.busyStartedAt);
  const streamTokens = useChatStore((s) => s.streamTokens);
  const contextPct = useChatStore((s) => s.contextPct);
  const model = useChatStore((s) => s.model);
  const currentTool = useChatStore((s) => s.currentTool);
  const agentSummary = useChatStore((s) => s.agentSummary);
  const hasMessages = useChatStore((s) => s.messages.length > 0);

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy || !busyStartedAt) {
      setElapsed(0);
      return;
    }
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - busyStartedAt) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [busy, busyStartedAt]);

  if (!hasMessages && !busy) return null;

  const activity = currentTool || agentSummary || busyLabel || '';
  const ctxColor =
    contextPct > 80 ? 'bg-danger' : contextPct > 50 ? 'bg-warning' : 'bg-primary/70';
  const ctxText =
    contextPct > 80 ? 'text-danger' : contextPct > 50 ? 'text-warning' : 'text-dim';

  return (
    <div className="flex h-7 shrink-0 items-center justify-between px-4 text-[11px] text-dim">
      <div className="flex min-w-0 items-center gap-2">
        {busy && (
          <>
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-pulse-fade rounded-full bg-primary/60 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span className="truncate text-text-soft">{activity || 'trabalhando…'}</span>
            {elapsed > 0 && (
              <span className="font-mono text-dim-soft">{formatElapsed(elapsed)}</span>
            )}
            {streamTokens > 0 && (
              <span className="font-mono text-dim-soft">
                · {streamTokens.toLocaleString('en-US')} tok
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {contextPct > 0 && (
          <div className="flex items-center gap-1.5">
            <span className={clsx('font-mono', ctxText)}>
              {contextPct.toFixed(0)}%
            </span>
            <div className="h-1 w-12 overflow-hidden rounded-full bg-surface-3">
              <div
                className={clsx('h-full transition-all duration-300', ctxColor)}
                style={{ width: `${Math.min(100, contextPct)}%` }}
              />
            </div>
          </div>
        )}
        <ModelConfigPicker currentModel={model} />
      </div>
    </div>
  );
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}
