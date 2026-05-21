import React, { useEffect, useState } from 'react';

export type AgentLaunchMode = 'tui' | 'window';

interface Props {
  onSelect: (mode: AgentLaunchMode) => void;
  onClose: () => void;
}

const OPTIONS: { mode: AgentLaunchMode; label: string; description: string; preview: React.ReactNode }[] = [
  {
    mode: 'tui',
    label: 'Terminal embutido',
    description: 'Abre o MakeStudio Code como painel no rodapé do kanban.',
    preview: (
      <div className="flex h-full flex-col rounded bg-[#0d1117] p-2 font-mono text-[10px]">
        <div className="mb-1 flex items-center gap-1 text-emerald-400">
          <span>▶</span>
          <span className="text-zinc-400">MakeStudio Code</span>
        </div>
        <div className="space-y-0.5 text-zinc-500">
          <div><span className="text-emerald-400">$</span> <span className="text-zinc-300">mks run</span></div>
          <div className="text-zinc-600">  ┌ Planejando…</div>
          <div className="text-zinc-600">  │ • Criando arquivo</div>
          <div className="text-zinc-600">  │ • Testando</div>
          <div className="text-zinc-500">  └ ✔ Concluído</div>
          <div className="mt-1"><span className="text-emerald-400">❯</span> <span className="animate-pulse text-zinc-400">█</span></div>
        </div>
      </div>
    ),
  },
  {
    mode: 'window',
    label: 'Janela separada',
    description: 'Abre o MakeStudio Code como uma janela Electron independente.',
    preview: (
      <div className="flex h-full flex-col overflow-hidden rounded border border-zinc-700 bg-[#0d1117]">
        {/* Window chrome */}
        <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-2 py-1.5">
          <span className="h-2 w-2 rounded-full bg-red-500/70" />
          <span className="h-2 w-2 rounded-full bg-yellow-500/70" />
          <span className="h-2 w-2 rounded-full bg-green-500/70" />
          <span className="ml-1 text-[9px] text-zinc-500">MakeStudio Code</span>
        </div>
        <div className="flex flex-1 flex-col p-2 font-mono text-[10px]">
          <div className="text-zinc-500">
            <div><span className="text-emerald-400">$</span> <span className="text-zinc-300">mks run</span></div>
            <div className="text-zinc-600">  ✔ Pronto</div>
            <div className="mt-1"><span className="text-emerald-400">❯</span> <span className="animate-pulse text-zinc-400">█</span></div>
          </div>
        </div>
      </div>
    ),
  },
];

/**
 * VS Code–style picker for choosing how to open MakeStudio Code.
 * Supports ← → arrow navigation and Enter / Esc keyboard shortcuts.
 */
export const AgentLaunchPicker: React.FC<Props> = ({ onSelect, onClose }) => {
  const [selected, setSelected] = useState<AgentLaunchMode>('tui');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft')  { setSelected('tui');    return; }
      if (e.key === 'ArrowRight') { setSelected('window'); return; }
      if (e.key === 'Enter') { onSelect(selected); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, onSelect, onClose]);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[640px] rounded-xl border border-zinc-700 bg-zinc-900 p-8 shadow-2xl">
        {/* Title */}
        <h2 className="mb-1 text-center text-lg font-semibold text-zinc-100">
          Abrir MakeStudio Code
        </h2>
        <p className="mb-6 text-center text-xs text-zinc-500">
          Clique ou use ← → para selecionar, Enter para confirmar
        </p>

        {/* Cards */}
        <div className="flex gap-4">
          {OPTIONS.map(({ mode, label, description, preview }) => {
            const active = selected === mode;
            return (
              <button
                key={mode}
                onClick={() => setSelected(mode)}
                onDoubleClick={() => onSelect(mode)}
                className={[
                  'flex flex-1 flex-col overflow-hidden rounded-lg border-2 text-left transition-all',
                  active
                    ? 'border-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]'
                    : 'border-zinc-700 hover:border-zinc-500',
                ].join(' ')}
              >
                {/* Preview area */}
                <div className="h-36 w-full bg-zinc-950 p-3">
                  {preview}
                </div>

                {/* Label area */}
                <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {active && (
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    )}
                    <span className={`text-sm font-medium ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>
                      {label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{description}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Pagination dots (cosmetic, like VS Code) */}
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancelar
          </button>
          <div className="flex gap-1.5">
            {OPTIONS.map(({ mode }) => (
              <span
                key={mode}
                className={`h-1.5 rounded-full transition-all ${
                  selected === mode ? 'w-4 bg-emerald-500' : 'w-1.5 bg-zinc-600'
                }`}
              />
            ))}
          </div>
          <button
            onClick={() => onSelect(selected)}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 transition-colors"
          >
            Abrir
          </button>
        </div>
      </div>
    </div>
  );
};
