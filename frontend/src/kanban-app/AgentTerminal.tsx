import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal, X, Maximize2, Minimize2, RotateCw } from 'lucide-react';

type Entry = { type: 'input' | 'output' | 'error'; text: string };

const AGENT = () => (window as any).api?.agent;

export const AgentTerminal: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [heightPx, setHeightPx] = useState(200);
  const [maximized, setMaximized] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new entries
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [entries]);

  // Toggle via backtick (`)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Don't toggle if typing in an input
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Restore focus to input when panel opens
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Clean up agent listeners on unmount
  useEffect(() => {
    return () => {
      const agent = AGENT();
      agent?.onResponse?.(() => {});
      agent?.onError?.(() => {});
    };
  }, []);

  const runCommand = useCallback(async (cmd: string) => {
    const agent = AGENT();
    if (!agent?.send) {
      setEntries((prev) => [...prev, { type: 'error', text: 'Agent não disponível' }]);
      return;
    }
    setRunning(true);
    setEntries((prev) => [...prev, { type: 'input', text: `$ ${cmd}` }]);

    try {
      const response = await agent.send(cmd, 60_000);
      if (response?.trim()) {
        setEntries((prev) => [...prev, { type: 'output', text: response }]);
      }
    } catch (err: any) {
      setEntries((prev) => [
        ...prev,
        { type: 'error', text: err?.message ?? String(err) },
      ]);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || running) return;
    setInput('');
    runCommand(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Up-arrow recalls last input
    if (e.key === 'ArrowUp') {
      const lastInput = [...entries].reverse().find((e) => e.type === 'input');
      if (lastInput) setInput(lastInput.text.replace(/^\$ /, ''));
    }
  };

  const restartAgent = () => {
    AGENT()?.restart?.();
    setEntries((prev) => [...prev, { type: 'output', text: '⟳ Agent reiniciado' }]);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 left-3 z-50 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-400 shadow-lg backdrop-blur hover:bg-zinc-800 hover:text-zinc-200 transition-all"
        title="Abrir terminal ( ` )"
      >
        <Terminal size={14} />
        Terminal
      </button>
    );
  }

  const h = maximized ? '100vh' : Math.max(120, heightPx);

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 flex flex-col border-t border-zinc-700 bg-zinc-950 shadow-2xl"
      style={{ height: h, minHeight: 120 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-emerald-400" />
          <span className="text-xs font-medium text-zinc-300">Agent Terminal</span>
          {!AGENT()?.isRunning?.() && (
            <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-400">
              stopped
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={restartAgent}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            title="Reiniciar agent"
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

      {/* Output */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-2 font-mono text-xs leading-relaxed">
        {entries.length === 0 && (
          <div className="text-zinc-600 italic p-2">Digite um comando para começar.</div>
        )}
        {entries.map((e, i) => (
          <div
            key={i}
            className={
              e.type === 'input'
                ? 'text-emerald-400'
                : e.type === 'error'
                  ? 'text-red-400'
                  : 'text-zinc-300 whitespace-pre-wrap'
            }
          >
            {e.text}
          </div>
        ))}
        {running && (
          <span className="inline-block h-3 w-1.5 animate-pulse bg-emerald-400 ml-1" />
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex items-center gap-0 border-t border-zinc-800">
        <span className="pl-3 text-xs text-emerald-400 font-mono">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Comando para o agent…"
          disabled={running}
          className="flex-1 bg-transparent px-2 py-2 text-xs font-mono text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-50"
        />
      </form>

      {/* Resize handle */}
      {!maximized && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = heightPx;
            const onMove = (ev: MouseEvent) => {
              const delta = startY - ev.clientY;
              setHeightPx(Math.max(120, startH + delta));
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
