import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Flag, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../../lib/clientToast';
import { flagsApi } from '../../ipc/client';
import { SettingsTabs } from '../../components/settings/SettingsTabs';
import type { FlagDTO } from '@shared/types';

export function FlagsSettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const flagsQuery = useQuery<FlagDTO[]>({
    queryKey: ['flags'],
    queryFn: () => flagsApi.get(),
    staleTime: 5_000,
  });

  const setMut = useMutation({
    mutationFn: (args: { name: string; value: boolean }) =>
      flagsApi.set(args.name, args.value),
    onSuccess: (next) => {
      qc.setQueryData(['flags'], next);
      toast.success('Flag atualizada');
    },
    onError: (err: any) => toast.error(`Falha: ${err?.message ?? err}`),
  });

  const flags = flagsQuery.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Flag size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Feature flags</h1>
        </div>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Toggles de runtime persistidos em{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent">
            ~/.makestudio/flags.json
          </code>
          . Mudança não exige restart — o agent re-lê a cada chamada.
        </p>
      </header>
      <SettingsTabs />

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="mb-3 flex items-start gap-2 rounded-md border border-secondary/40 bg-secondary/10 px-3 py-2 text-[12px] text-secondary">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div>
            <strong>Reservas de feature flags.</strong> Estas chaves persistem em
            flags.json e ficam disponíveis para qualquer call site que use
            {' '}
            <code className="font-mono text-[11px]">isFlagEnabled(name)</code>.
            Hoje o agent core ainda não consome nenhuma delas — ligar/desligar
            não afeta runtime imediatamente; quando uma feature passar a checar
            a flag, o toggle aqui passa a ter efeito.
          </div>
        </div>
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div>
            Flags experimentais. Quando ativas, podem degradar performance ou
            mudar comportamento — mantenha os defaults se não souber o impacto.
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-border-subtle">
          {flags.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-dim/70">
              Carregando…
            </div>
          ) : (
            flags.map((f) => {
              const isCustom = f.value !== f.default;
              return (
                <label
                  key={f.name}
                  className={clsx(
                    'flex cursor-pointer items-start justify-between gap-4 border-b border-border-subtle bg-surface-2/40 px-4 py-3 last:border-b-0 transition-colors hover:bg-surface-2',
                    setMut.isPending && 'opacity-60',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] text-text">
                        {f.name}
                      </span>
                      {isCustom && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.05em] text-accent">
                          custom
                        </span>
                      )}
                    </div>
                    {f.description && (
                      <div className="mt-0.5 text-[11.5px] text-dim-soft">
                        {f.description}
                      </div>
                    )}
                    <div className="mt-1 text-[10.5px] text-dim/70">
                      Default: {f.default ? 'on' : 'off'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={f.value}
                    disabled={setMut.isPending}
                    onChange={(e) =>
                      setMut.mutate({ name: f.name, value: e.target.checked })
                    }
                    className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                  />
                </label>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
