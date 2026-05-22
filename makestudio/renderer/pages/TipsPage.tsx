import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lightbulb, RefreshCw, EyeOff, Eye, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { tipsApi, settingsApi } from '../ipc/client';
import type { TipDTO, SettingsDTO } from '@shared/types';

export function TipsPage(): React.ReactElement {
  const qc = useQueryClient();
  const [index, setIndex] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [hiddenIds, setHiddenIds] = React.useState<Set<string>>(new Set());

  const listQ = useQuery<TipDTO[]>({
    queryKey: ['tips', 'list'],
    queryFn: () => tipsApi.list(),
    staleTime: Infinity,
  });

  const settingsQ = useQuery<SettingsDTO>({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get(),
    staleTime: 30_000,
  });

  const tipsDisabled = settingsQ.data?.tipsDisabled ?? false;

  const tips = listQ.data ?? [];
  const filtered = search.trim()
    ? tips.filter((t) => t.text.toLowerCase().includes(search.toLowerCase()))
    : tips;
  const visible = filtered.filter((t) => !hiddenIds.has(t.id));

  React.useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  const current = visible[index] ?? null;

  const pickNextMut = useMutation({
    mutationFn: () => tipsApi.pickNext(),
    onSuccess: (res) => {
      if (res.tip) {
        toast.success(`Dica do dia: ${res.tip.text.slice(0, 60)}…`);
        qc.invalidateQueries({ queryKey: ['tips'] });
      } else {
        toast.info('Nenhuma dica nova para exibir agora.');
      }
    },
    onError: (e: any) => toast.error(e?.message ?? 'Erro ao buscar dica'),
  });

  const toggleMut = useMutation({
    mutationFn: (disable: boolean) => tipsApi.setDisabled(disable),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success(res.tipsDisabled ? 'Dicas desativadas' : 'Dicas ativadas');
    },
    onError: (e: any) => toast.error(e?.message ?? 'Erro'),
  });

  function toggleHide(id: string): void {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <Lightbulb size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Dicas</h1>
          <span className="text-[12px] text-dim">{tips.length} dicas</span>
          {tipsDisabled && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-warning/10 text-warning">
              desativadas
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => pickNextMut.mutate()}
            disabled={pickNextMut.isPending || tipsDisabled}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-soft hover:text-text disabled:opacity-50"
          >
            {pickNextMut.isPending
              ? <RefreshCw size={11} className="animate-spin" />
              : <Lightbulb size={11} />}
            Dica do dia
          </button>
          <button
            type="button"
            onClick={() => toggleMut.mutate(!tipsDisabled)}
            disabled={toggleMut.isPending || settingsQ.isLoading}
            aria-pressed={tipsDisabled}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-soft hover:text-text disabled:opacity-50"
          >
            {tipsDisabled ? <Eye size={11} /> : <EyeOff size={11} />}
            {tipsDisabled ? 'Ativar dicas' : 'Desativar dicas'}
          </button>
        </div>
      </header>

      {/* Carousel */}
      {current && (
        <div className="border-b border-border-subtle bg-surface-2/30 px-6 py-5">
          <div className="flex items-center gap-4">
            <button
              type="button"
              aria-label="Dica anterior"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="rounded-md p-1.5 text-dim-soft hover:text-text disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="flex-1 rounded-lg border border-primary/20 bg-primary/5 px-5 py-4">
              <div className="flex items-start gap-3">
                <Lightbulb size={14} className="mt-0.5 shrink-0 text-primary" />
                <p className="text-[13px] leading-relaxed text-text">{current.text}</p>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-[10px] text-dim">{current.id}</span>
                <span className="text-[10px] text-dim">
                  {index + 1} / {visible.length}
                </span>
              </div>
            </div>
            <button
              type="button"
              aria-label="Próxima dica"
              onClick={() => setIndex((i) => Math.min(visible.length - 1, i + 1))}
              disabled={index >= visible.length - 1}
              className="rounded-md p-1.5 text-dim-soft hover:text-text disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="border-b border-border-subtle px-6 py-3">
        <input
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setIndex(0); }}
          placeholder="Buscar dicas…"
          aria-label="Buscar dicas"
          className="w-full max-w-sm rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text outline-none placeholder:text-dim focus:border-primary"
        />
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto px-6 py-5">
        {listQ.isLoading && (
          <div className="flex items-center justify-center py-16">
            <RefreshCw size={20} className="animate-spin text-dim" />
          </div>
        )}
        {!listQ.isLoading && filtered.length === 0 && (
          <p className="py-12 text-center text-[13px] text-dim">
            {search ? 'Nenhuma dica encontrada.' : 'Sem dicas disponíveis.'}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((tip) => {
            const hidden = hiddenIds.has(tip.id);
            const isCurrent = current?.id === tip.id;
            return (
              <div
                key={tip.id}
                className={clsx(
                  'group relative rounded-lg border p-4 transition-colors',
                  isCurrent
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border-subtle bg-surface-2/30 hover:border-border-soft',
                  hidden && 'opacity-50',
                )}
              >
                <div className="flex items-start gap-2.5">
                  <Lightbulb
                    size={13}
                    className={clsx('mt-0.5 shrink-0', isCurrent ? 'text-primary' : 'text-dim-soft')}
                    aria-hidden="true"
                  />
                  <p className="flex-1 text-[12px] leading-relaxed text-text">{tip.text}</p>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-mono text-[10px] text-dim">{tip.id}</span>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      aria-label={hidden ? 'Mostrar dica' : 'Ocultar dica'}
                      onClick={() => toggleHide(tip.id)}
                      className="rounded p-1 text-dim-soft hover:text-text"
                    >
                      {hidden ? <Eye size={11} /> : <EyeOff size={11} />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
