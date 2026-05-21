import React, { useEffect, useRef, useState } from 'react';
import { Terminal, X, Maximize2, Minimize2, RotateCw, SquareArrowOutUpRight } from 'lucide-react';
import { AgentTuiTerminal } from './AgentTuiTerminal';
import { AgentLaunchPicker } from './AgentLaunchPicker';

const openMakeStudio = () => (window as any).kanbanDesktop?.agent?.openMakeStudio?.();

/** Embedded footer panel hosting the real MakeStudio Code TUI (xterm + pty). */
export const AgentTerminal: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  // Initial height fits the full MakeStudio Code TUI opening banner (ASCII
  // logo + model/path/user + tips + prompt + status line ≈ 15 rows) without
  // clipping. Was 260px, which cut off the top of the banner. User can still
  // resize (drag handle) or maximize.
  const [heightPx, setHeightPx] = useState(400);
  const [maximized, setMaximized] = useState(false);
  const [sessionKey, setSessionKey] = useState(0); // bump to respawn the TUI
  const hostRef = useRef<HTMLDivElement>(null);

  // Backtick (`) — se fechado, abre o picker; se aberto, fecha o painel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        if (open) {
          setOpen(false);
        } else {
          setShowPicker((v) => !v);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (!open) {
    return (
      <>
        <button
          onClick={() => setShowPicker(true)}
          className="fixed bottom-3 left-3 z-50 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-400 shadow-lg backdrop-blur hover:bg-zinc-800 hover:text-zinc-200 transition-all"
          title="Abrir MakeStudio Code ( ` )"
        >
          <Terminal size={14} />
          MakeStudio Code
        </button>

        {showPicker && (
          <AgentLaunchPicker
            onClose={() => setShowPicker(false)}
            onSelect={(mode) => {
              setShowPicker(false);
              if (mode === 'tui') {
                setOpen(true);
              } else {
                openMakeStudio();
              }
            }}
          />
        )}
      </>
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
