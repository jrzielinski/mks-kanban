import React, { useEffect, useRef, useState } from 'react';
import { Terminal, X, Maximize2, Minimize2, RotateCw, SquareArrowOutUpRight } from 'lucide-react';
import { AgentTuiTerminal } from './AgentTuiTerminal';

const openInWindow = () => (window as any).kanbanDesktop?.agent?.openWindow?.();

/** Embedded footer panel hosting the real MakeStudio Code TUI (xterm + pty). */
export const AgentTerminal: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [heightPx, setHeightPx] = useState(260);
  const [maximized, setMaximized] = useState(false);
  const [sessionKey, setSessionKey] = useState(0); // bump to respawn the TUI
  const hostRef = useRef<HTMLDivElement>(null);

  // Toggle via backtick (`) — unless typing in a field
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 left-3 z-50 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-400 shadow-lg backdrop-blur hover:bg-zinc-800 hover:text-zinc-200 transition-all"
        title="Abrir MakeStudio Code ( ` )"
      >
        <Terminal size={14} />
        MakeStudio Code
      </button>
    );
  }

  const h = maximized ? '100vh' : Math.max(160, heightPx);

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 flex flex-col border-t border-zinc-700 bg-[#0d1117] shadow-2xl"
      style={{ height: h, minHeight: 160 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-emerald-400" />
          <span className="text-xs font-medium text-zinc-300">MakeStudio Code</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={openInWindow}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            title="Abrir em janela"
          >
            <SquareArrowOutUpRight size={13} />
          </button>
          <button
            onClick={() => setSessionKey((k) => k + 1)}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            title="Reiniciar sessão"
          >
            <RotateCw size={13} />
          </button>
          <button
            onClick={() => setMaximized((v) => !v)}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            title={maximized ? 'Restaurar' : 'Maximizar'}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            title="Fechar ( ` )"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div ref={hostRef} className="flex-1 overflow-hidden p-1">
        <AgentTuiTerminal key={sessionKey} className="h-full w-full" />
      </div>

      {/* Resize handle */}
      {!maximized && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = heightPx;
            const onMove = (ev: MouseEvent) => {
              setHeightPx(Math.max(160, startH + (startY - ev.clientY)));
            };
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          className="absolute top-0 left-0 right-0 h-1 cursor-ns-resize hover:bg-emerald-600/50 transition-colors"
        />
      )}
    </div>
  );
};
