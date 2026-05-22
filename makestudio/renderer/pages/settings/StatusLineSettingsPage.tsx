import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, ChevronDown, X, Plus, RotateCcw, GripVertical } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../../lib/clientToast';
import { statuslineApi } from '../../ipc/client';
import { SettingsTabs } from '../../components/settings/SettingsTabs';
import type { StatuslineFieldDTO } from '@shared/types';

const DEFAULT_FIELDS = ['status', 'msgs', 'ctx', 'tokens', 'cache', 'rules', 'perms'];

// Sample values for the live preview — purely visual, doesn't reflect the
// current REPL state. The point is to show the user what the order LOOKS
// like in the actual statusbar.
const PREVIEW_SAMPLES: Record<string, string> = {
  status: '● running',
  msgs: '12 msgs',
  ctx: '34%',
  tokens: '8.4k',
  cache: '67%',
  rules: '5 rules',
  perms: 'default',
  cwd: '~/proj',
  git: 'main ✓',
  model: 'opus',
};

export function StatusLineSettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const query = useQuery<{ fields: string[]; available: StatuslineFieldDTO[] }>({
    queryKey: ['statusline'],
    queryFn: () => statuslineApi.get(),
    staleTime: 5_000,
  });

  const setMut = useMutation({
    mutationFn: (fields: string[]) => statuslineApi.set(fields),
    onSuccess: (next) => {
      qc.setQueryData(['statusline'], (prev: any) => ({
        fields: next.fields,
        available: prev?.available ?? [],
      }));
      toast.success('Status line atualizada');
    },
    onError: (err: any) => toast.error(`Falha: ${err?.message ?? err}`),
  });

  const data = query.data;
  const fields = data?.fields ?? [];
  const available = data?.available ?? [];

  const move = (idx: number, dir: -1 | 1): void => {
    const target = idx + dir;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[idx], next[target]] = [next[target], next[idx]];
    setMut.mutate(next);
  };
  const reorder = (from: number, to: number): void => {
    if (from === to || from < 0 || to < 0) return;
    const next = [...fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setMut.mutate(next);
  };
  const remove = (idx: number): void => {
    const next = fields.filter((_, i) => i !== idx);
    setMut.mutate(next);
  };
  const add = (name: string): void => {
    if (fields.includes(name)) return;
    setMut.mutate([...fields, name]);
  };
  const resetDefaults = (): void => setMut.mutate(DEFAULT_FIELDS);

  // Drag state — the row index that's currently being dragged. We don't
  // track the hover index because we rely on dragover handlers to compute
  // it from event.currentTarget so the visual indicator stays simple.
  const [dragSrc, setDragSrc] = React.useState<number | null>(null);
  const [dragHover, setDragHover] = React.useState<number | null>(null);

  const usedSet = new Set(fields);
  const unused = available.filter((a) => !usedSet.has(a.name));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">Status line</h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            Ordem dos campos da barra de status do REPL. Arraste o handle{' '}
            <GripVertical size={11} className="inline-block text-dim-soft" />{' '}
            pra reordenar (ou use as setas), e clique{' '}
            <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[10.5px] text-accent">
              +
            </code>{' '}
            pra adicionar campos.
          </p>
        </div>
        <button
          type="button"
          onClick={resetDefaults}
          disabled={setMut.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
          title="Voltar à ordem padrão"
        >
          <RotateCcw size={12} />
          Restaurar padrão
        </button>
      </header>
      <SettingsTabs />

      {/* ── Live preview ──────────────────────────────────────────────── */}
      <div className="border-b border-border-subtle bg-surface-1/60 px-6 py-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-dim/80">
          Preview
        </div>
        <div className="flex h-[28px] items-center gap-3 rounded border border-border-subtle bg-surface-2/80 px-3 font-mono text-[11.5px] text-text-soft">
          {fields.length === 0 ? (
            <span className="text-dim/70">— statusbar vazia —</span>
          ) : (
            fields.map((name, i) => (
              <React.Fragment key={name}>
                {i > 0 && <span className="text-border-soft">·</span>}
                <span>{PREVIEW_SAMPLES[name] ?? name}</span>
              </React.Fragment>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-6 overflow-auto px-6 py-5">
        {/* ── Active ─────────────────────────────────────────────────── */}
        <section className="min-w-0 flex-1">
          <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim/80">
            Campos ativos · {fields.length}
          </h2>
          <div className="overflow-hidden rounded-md border border-border-subtle">
            {fields.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-dim/70">
                Nenhum campo selecionado.
              </div>
            ) : (
              fields.map((name, idx) => {
                const meta = available.find((a) => a.name === name);
                const isDragging = dragSrc === idx;
                const isHover = dragHover === idx && dragSrc !== null && dragSrc !== idx;
                return (
                  <div
                    key={name}
                    draggable
                    onDragStart={(e) => {
                      setDragSrc(idx);
                      e.dataTransfer.effectAllowed = 'move';
                      // Required for Firefox to actually start the drag.
                      e.dataTransfer.setData('text/plain', String(idx));
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dragHover !== idx) setDragHover(idx);
                    }}
                    onDragLeave={() => {
                      if (dragHover === idx) setDragHover(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragSrc !== null && dragSrc !== idx) reorder(dragSrc, idx);
                      setDragSrc(null);
                      setDragHover(null);
                    }}
                    onDragEnd={() => {
                      setDragSrc(null);
                      setDragHover(null);
                    }}
                    className={clsx(
                      'flex items-center gap-3 border-b border-border-subtle bg-surface-2/40 px-3 py-2 last:border-b-0 transition-colors',
                      isDragging && 'opacity-40',
                      isHover && 'border-t-2 border-t-primary/70',
                    )}
                  >
                    <button
                      type="button"
                      title="Arrastar"
                      className="cursor-grab text-dim-soft hover:text-text active:cursor-grabbing"
                    >
                      <GripVertical size={13} />
                    </button>
                    <span className="w-6 shrink-0 text-center font-mono text-[11px] text-dim/70">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12.5px] text-text">{name}</div>
                      {meta?.description && (
                        <div className="text-[11px] text-dim-soft">
                          {meta.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <IconBtn
                        title="Mover pra cima"
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0 || setMut.isPending}
                      >
                        <ChevronUp size={12} />
                      </IconBtn>
                      <IconBtn
                        title="Mover pra baixo"
                        onClick={() => move(idx, 1)}
                        disabled={idx === fields.length - 1 || setMut.isPending}
                      >
                        <ChevronDown size={12} />
                      </IconBtn>
                      <IconBtn
                        title="Remover"
                        onClick={() => remove(idx)}
                        disabled={setMut.isPending}
                      >
                        <X size={12} />
                      </IconBtn>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ── Available ──────────────────────────────────────────────── */}
        <section className="w-[300px] shrink-0">
          <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim/80">
            Disponíveis
          </h2>
          <div className="flex flex-col gap-1">
            {unused.length === 0 ? (
              <div className="rounded-md border border-border-subtle bg-surface-2/30 px-3 py-3 text-[11.5px] text-dim/70">
                Todos os campos estão em uso.
              </div>
            ) : (
              unused.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => add(a.name)}
                  disabled={setMut.isPending}
                  className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-2/40 px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
                >
                  <Plus size={12} className="mt-0.5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12px] text-text">{a.name}</div>
                    {a.description && (
                      <div className="text-[10.5px] text-dim-soft">
                        {a.description}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'rounded p-1.5 text-dim-soft transition-colors hover:bg-surface-3 hover:text-text',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
