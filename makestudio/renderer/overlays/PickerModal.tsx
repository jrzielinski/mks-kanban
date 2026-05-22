import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { subscribe, resolveRpc } from '../ipc/client';
import * as CH from '@shared/channels';
import type { PickerRequest, PickerItemDTO } from '@shared/types';

const MAX_VISIBLE = 12;

export function PickerModal(): React.ReactElement | null {
  const [request, setRequest] = React.useState<PickerRequest | null>(null);

  React.useEffect(() => {
    const offOpen = subscribe<PickerRequest>(CH.EVT_PICKER_OPEN, (req) => {
      setRequest(req);
    });
    const offClose = subscribe<void>(CH.EVT_PICKER_CLOSE, () => {
      setRequest(null);
    });
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  if (!request) return null;

  return (
    <PickerView
      request={request}
      onResolve={(value) => {
        // null = cancelar; main consome via ipcMain.on(AGENT_PICKER_RESOLVE).
        resolveRpc(CH.AGENT_PICKER_RESOLVE, value);
        setRequest(null);
      }}
    />
  );
}

interface ViewProps {
  request: PickerRequest;
  onResolve: (value: unknown) => void;
}

function PickerView({ request, onResolve }: ViewProps): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  // Re-filtra + reseta cursor quando query muda.
  const filtered = React.useMemo(() => {
    return scoreItems(request.items, query);
  }, [request.items, query]);

  React.useEffect(() => {
    if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, idx]);

  React.useEffect(() => {
    setIdx(0);
  }, [query]);

  // Auto-scroll do item selecionado.
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${idx}"]`,
    );
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const accept = React.useCallback(() => {
    const chosen = filtered[idx]?.item;
    onResolve(chosen ? chosen.value : null);
  }, [filtered, idx, onResolve]);

  const cancel = React.useCallback(() => onResolve(null), [onResolve]);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-[18vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border-subtle bg-surface-1 shadow-elev"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => (filtered.length === 0 ? 0 : Math.min(filtered.length - 1, i + 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              accept();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        >
          <Dialog.Title className="sr-only">{request.title}</Dialog.Title>

          {/* Header: título + counter */}
          <div className="flex items-center justify-between border-b border-border-subtle/60 bg-surface-2/40 px-4 py-2.5">
            <span className="text-[13px] font-semibold tracking-tight text-text">
              {request.title}
            </span>
            <span className="font-mono text-[11px] text-dim">
              {filtered.length}/{request.items.length}
            </span>
          </div>

          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-border-subtle/60 bg-surface-1 px-4 py-2.5">
            <Search size={14} className="shrink-0 text-dim" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={request.placeholder || 'filtrar…'}
              className="flex-1 bg-transparent text-[14px] text-text placeholder:text-dim/80 focus:outline-none"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {/* Result list */}
          <div
            ref={listRef}
            className="max-h-[min(420px,55vh)] overflow-y-auto"
            style={{ scrollPaddingBlock: 8 }}
          >
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12.5px] text-dim">
                nenhum match para “{query}”
              </div>
            ) : (
              filtered.slice(0, MAX_VISIBLE * 4).map((entry, i) => {
                const isSel = i === idx;
                return (
                  <button
                    key={i}
                    data-idx={i}
                    type="button"
                    onClick={() => onResolve(entry.item.value)}
                    onMouseMove={() => setIdx(i)}
                    className={
                      'flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors ' +
                      (isSel
                        ? 'bg-primary/15 text-text'
                        : 'text-text-soft hover:bg-surface-2/60')
                    }
                  >
                    <span className="truncate text-[13px] font-medium">
                      {entry.item.label}
                    </span>
                    {entry.item.detail && (
                      <span className="truncate font-mono text-[11.5px] text-dim">
                        {entry.item.detail}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Footer hints */}
          <div className="flex items-center justify-between border-t border-border-subtle/60 bg-surface-2/40 px-4 py-1.5 font-mono text-[10.5px] text-dim/70">
            <span>↑↓ navega · Enter aceita</span>
            <span>Esc cancela</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Scoring ────────────────────────────────────────────────────────────

interface Scored {
  item: PickerItemDTO;
  score: number;
}

function scoreItems(items: PickerItemDTO[], query: string): Scored[] {
  const q = query.trim();
  if (!q) return items.map((it, i) => ({ item: it, score: i }));
  const out: Scored[] = [];
  for (const it of items) {
    const sLabel = fuzzyScore(q, it.label);
    if (sLabel !== null) {
      out.push({ item: it, score: sLabel });
      continue;
    }
    if (it.detail) {
      const sDetail = fuzzyScore(q, it.detail);
      // detail matches ranqueiam abaixo dos label matches
      if (sDetail !== null) out.push({ item: it, score: sDetail + 50 });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  for (const qc of q) {
    const found = t.indexOf(qc, ti);
    if (found === -1) return null;
    score += found - ti;
    ti = found + 1;
  }
  if (t.startsWith(q)) score -= 100;
  if (t.includes(q)) score -= 20;
  score += t.length * 0.05;
  return score;
}
