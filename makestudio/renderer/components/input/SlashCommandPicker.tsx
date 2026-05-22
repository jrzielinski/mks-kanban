import React from 'react';
import clsx from 'clsx';
import { filterSlashCommands, type SlashCommand } from '../../data/slashCommands';

/**
 * Picker de slash-commands — aparece compacto sobre a InputBox quando o
 * usuário digita uma query começando com "/" e ainda não tem espaço.
 *
 * Estilo IntelliSense/VSCode: pequeno popover (240px max), 5-6 itens
 * visíveis com scroll interno, sem dominar a tela.
 *
 * Navegação por teclado:
 *  - ↑ / ↓: muda seleção
 *  - Enter / Tab: insere comando selecionado
 *  - Esc: fecha (callback `onClose`)
 */
interface Props {
  query: string;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

export interface SlashPickerHandle {
  /** Move seleção. Retorna true se o picker consumiu a tecla. */
  handleKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean;
}

export const SlashCommandPicker = React.forwardRef<SlashPickerHandle, Props>(
  function SlashCommandPicker({ query, onSelect, onClose }, ref) {
    const matches = React.useMemo(() => filterSlashCommands(query, 30), [query]);
    const [selected, setSelected] = React.useState(0);
    const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

    // Reset índice quando a query muda (resultado pode encolher).
    React.useEffect(() => {
      setSelected(0);
    }, [query]);

    // Auto-scroll: mantém o item selecionado visível dentro do popover.
    React.useEffect(() => {
      const el = itemRefs.current[selected];
      el?.scrollIntoView({ block: 'nearest' });
    }, [selected]);

    React.useImperativeHandle(
      ref,
      () => ({
        handleKeyDown: (e) => {
          if (matches.length === 0) return false;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected((i) => (i + 1) % matches.length);
            return true;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((i) => (i - 1 + matches.length) % matches.length);
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            onSelect(matches[selected]);
            return true;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return true;
          }
          return false;
        },
      }),
      [matches, selected, onSelect, onClose],
    );

    if (matches.length === 0) return null;

    const totalCount = matches.length;

    return (
      <div
        // Compacto: 240px de altura máxima, anchor acima do input.
        // Scroll interno — sem categorias agrupadas, lista flat.
        className="absolute bottom-full left-2 right-2 z-30 mb-1 overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-elev"
        role="listbox"
      >
        <div className="flex items-center justify-between border-b border-border-subtle/60 px-2.5 py-1 text-[10px] text-dim/70">
          <span className="uppercase tracking-[0.1em]">
            Comandos · {totalCount}
          </span>
          <span className="font-mono text-dim/60">↑↓ Enter Esc</span>
        </div>
        <div className="max-h-[220px] overflow-auto py-0.5">
          {matches.map((cmd, idx) => {
            const isSel = idx === selected;
            return (
              <button
                key={cmd.name}
                ref={(el) => { itemRefs.current[idx] = el; }}
                type="button"
                onMouseEnter={() => setSelected(idx)}
                onClick={() => onSelect(cmd)}
                role="option"
                aria-selected={isSel}
                className={clsx(
                  'flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors',
                  isSel
                    ? 'bg-primary/12 text-text'
                    : 'text-text-soft hover:bg-surface-2',
                )}
              >
                <span className="font-mono text-[12px] font-medium">
                  {cmd.name}
                </span>
                {cmd.args && (
                  <span className="font-mono text-[10px] text-dim/70">
                    {cmd.args}
                  </span>
                )}
                <span className="ml-auto truncate text-[11px] text-dim-soft">
                  {cmd.description}
                </span>
                <span className="shrink-0 rounded bg-surface-3/60 px-1 py-px font-mono text-[9px] uppercase tracking-[0.05em] text-dim/70">
                  {cmd.category}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);
