import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Puzzle, Plus, Trash2, Save, X, Loader2, AlertTriangle, Info, Lightbulb } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { pluginsApi } from '../ipc/client';
import type { PluginInfoDTO, PluginContributionDTO, PluginInstallProgressDTO } from '@shared/types';

/**
 * Locale-alvo da UI. PT-BR é o default do projeto. Quando houver settings
 * de idioma do usuário, plugar aqui.
 */
function uiLocale(): string {
  return 'pt-BR';
}

export function PluginsPage(): React.ReactElement {
  const qc = useQueryClient();
  const listQuery = useQuery<PluginInfoDTO[]>({
    queryKey: ['plugins'],
    queryFn: () => pluginsApi.list(),
    staleTime: 30_000,
  });

  // Tradução automática das descrições — chama o LLM em batch e cacheia em
  // ~/.makestudio/plugin-i18n.json. Plugins novos viram traduções
  // automaticamente na primeira vez que aparecem.
  const locale = uiLocale();
  const i18nQuery = useQuery<Record<string, string>>({
    queryKey: [
      'plugins',
      'i18n',
      locale,
      // Inclui um fingerprint da lista pra invalidar quando descrição mudar.
      (listQuery.data ?? [])
        .map((p) => `${p.name}::${p.description ?? ''}`)
        .join('|'),
    ],
    enabled: !!listQuery.data && listQuery.data.length > 0,
    queryFn: () =>
      pluginsApi.i18n(
        locale,
        (listQuery.data ?? [])
          .filter((p) => !!p.description)
          .map((p) => ({ name: p.name, description: p.description as string })),
      ),
    staleTime: 24 * 60 * 60 * 1000, // 24h — cache em disco já cuida do resto
    gcTime: 7 * 24 * 60 * 60 * 1000,
  });

  const pluginDescription = (p: PluginInfoDTO): string | undefined => {
    return i18nQuery.data?.[p.name] ?? p.description;
  };
  const [installOpen, setInstallOpen] = React.useState(false);
  const [detailName, setDetailName] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3_000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const removeMut = useMutation({
    mutationFn: (name: string) => pluginsApi.remove(name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['plugins'] }); toast.success('Plugin removido'); },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });
  const toggleMut = useMutation({
    mutationFn: (vars: { name: string; enabled: boolean }) => pluginsApi.toggle(vars.name, vars.enabled),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
      if (r.requiresRestart) toast.success('Plugin atualizado — reinicie o app pra aplicar');
    },
  });

  const plugins = listQuery.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Puzzle size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Plugins</h1>
        </div>
        <button type="button" onClick={() => setInstallOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
          <Plus size={12} /> Instalar
        </button>
      </header>

      {/* Banner explicativo — diz pra que serve cada coisa */}
      <div className="flex items-start gap-2 border-b border-border-subtle bg-primary/[0.04] px-6 py-2.5 text-[11.5px] leading-relaxed text-text-soft">
        <Lightbulb size={12} className="mt-0.5 shrink-0 text-primary" strokeWidth={2} />
        <p>
          <span className="font-medium text-text">Plugins</span> estendem o agente
          com hooks (rodam em eventos como pre/post-task), comandos slash, tools e
          estratégias de execução. Os <span className="font-mono text-dim-soft">builtin</span>{' '}
          vêm com o app; outros podem ser instalados de npm, git ou caminho local.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {plugins.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-subtle py-16 text-center text-[12.5px] text-dim/70">
            Nenhum plugin instalado.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {plugins.map((p) => (
              <li key={p.name}>
                <div className="group flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-1/40 px-4 py-3 transition-colors hover:border-border-soft hover:bg-surface-2/40">
                  {/* Identidade — nome + descrição + meta */}
                  <button
                    type="button"
                    onClick={() => setDetailName(p.name)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] font-medium text-text group-hover:text-primary">
                        {p.name}
                      </span>
                      <span
                        className={clsx(
                          'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]',
                          p.source === 'builtin' && 'bg-secondary/15 text-secondary',
                          p.source === 'npm' && 'bg-primary/15 text-primary',
                          p.source === 'git' && 'bg-warning/15 text-warning',
                          p.source === 'local' && 'bg-success/15 text-success',
                        )}
                      >
                        {p.source}
                      </span>
                      <span className="font-mono text-[10.5px] text-dim/70">
                        v{p.version ?? '—'}
                      </span>
                    </div>
                    {(() => {
                      const desc = pluginDescription(p);
                      return desc ? (
                        <p className="line-clamp-2 text-[12px] leading-relaxed text-text-soft">
                          {desc}
                        </p>
                      ) : (
                        <p className="text-[11.5px] italic text-dim/60">
                          Sem descrição. Clique pra ver o que esse plugin contribui.
                        </p>
                      );
                    })()}
                  </button>

                  {/* Toggle on/off */}
                  <label
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-2.5 py-1.5"
                    title={p.source === 'builtin' ? 'Builtins ficam sempre ativos' : 'Habilita ou desabilita esse plugin'}
                  >
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) =>
                        toggleMut.mutate({ name: p.name, enabled: e.target.checked })
                      }
                      disabled={toggleMut.isPending || p.source === 'builtin'}
                      className="h-3.5 w-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <span className="text-[10.5px] uppercase tracking-[0.05em] text-dim-soft">
                      {p.enabled ? 'on' : 'off'}
                    </span>
                  </label>

                  {/* Remoção (só pra não-builtin) */}
                  {p.source !== 'builtin' && (
                    <button
                      type="button"
                      onClick={() => {
                        if (pendingDelete === p.name) {
                          removeMut.mutate(p.name);
                          setPendingDelete(null);
                        } else setPendingDelete(p.name);
                      }}
                      disabled={removeMut.isPending}
                      title={pendingDelete === p.name ? 'Clique pra confirmar' : 'Remover plugin'}
                      className={clsx(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50',
                        pendingDelete === p.name
                          ? 'bg-danger/20 text-danger'
                          : 'text-dim-soft hover:bg-surface-3 hover:text-danger',
                      )}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {installOpen && <InstallModal onClose={() => setInstallOpen(false)} onDone={() => qc.invalidateQueries({ queryKey: ['plugins'] })} />}
        {detailName && <PluginDetail name={detailName} onClose={() => setDetailName(null)} />}
      </div>
    </div>
  );
}

function InstallModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.ReactElement {
  const [source, setSource] = React.useState('');
  const [progress, setProgress] = React.useState<PluginInstallProgressDTO[]>([]);
  const [running, setRunning] = React.useState(false);

  React.useEffect(() => {
    return pluginsApi.onProgress((ev) => setProgress((p) => [...p, ev]));
  }, []);

  const installMut = useMutation({
    mutationFn: () => pluginsApi.install(source.trim()),
    onMutate: () => { setProgress([]); setRunning(true); },
    onSettled: (r) => {
      setRunning(false);
      if (r?.ok) { toast.success(`Instalado: ${r.manifest?.name ?? source}`); onDone(); onClose(); }
      else if (r?.error) toast.error(r.error);
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[600px] max-w-[90vw] rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-text">Instalar plugin</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-dim hover:bg-surface-3 hover:text-text">
            <X size={14} />
          </button>
        </div>
        <p className="mb-3 text-[11.5px] text-dim-soft">
          Aceita: nome npm (<code>@scope/pkg</code>), URL git (<code>git+https://...</code>), ou path local.
        </p>
        <input value={source} onChange={(e) => setSource(e.target.value)} disabled={running}
          placeholder="@makestudio/plugin-slack ou ./local/plugin"
          className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60" />
        {progress.length > 0 && (
          <div className="mt-3 max-h-[240px] overflow-auto rounded border border-border-subtle bg-surface-3 p-2 font-mono text-[10.5px] text-dim-soft">
            {progress.map((p, i) => (
              <div key={i} className={p.phase === 'error' ? 'text-danger' : ''}>
                [{p.phase}] {p.line ?? p.error ?? ''}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={running}
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3">
            Cancelar
          </button>
          <button type="button" onClick={() => installMut.mutate()} disabled={running || !source.trim()}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60">
            {running ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {running ? 'Instalando…' : 'Instalar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PluginDetail({ name, onClose }: { name: string; onClose: () => void }): React.ReactElement {
  const query = useQuery<PluginContributionDTO | null>({
    queryKey: ['plugins', 'contributions', name],
    queryFn: () => pluginsApi.contributions(name),
    staleTime: 30_000,
  });
  const c = query.data;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[640px] max-w-[90vw] rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-text">Plugin: {name}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-dim hover:bg-surface-3 hover:text-text">
            <X size={14} />
          </button>
        </div>
        {query.isLoading && <Loader2 size={14} className="animate-spin text-dim-soft" />}
        {!c && !query.isLoading && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
            <AlertTriangle size={12} className="mr-1 inline" />
            Plugin não está carregado — disable/enable + restart pra ver contribuições.
          </div>
        )}
        {c && (
          <div className="space-y-3 text-[12px]">
            <ContribSection title="Skills" items={c.skills} />
            <ContribSection title="Tools" items={c.tools} />
            <ContribSection title="Slash commands" items={c.slashCommands.map((s) => `/${s}`)} />
            <ContribSection title="MCP servers" items={c.mcpServers} />
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">Hooks</div>
              {Object.keys(c.hooks).length === 0 ? (
                <div className="text-[11px] text-dim/70">Nenhum</div>
              ) : (
                <ul className="space-y-0.5">
                  {Object.entries(c.hooks).map(([event, count]) => (
                    <li key={event} className="font-mono text-[11px] text-text-soft">{event}: <span className="text-warning">{count}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ContribSection({ title, items }: { title: string; items: string[] }): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">{title}</div>
      {items.length === 0 ? (
        <div className="text-[11px] text-dim/70">Nenhum</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <code key={item} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-text-soft">{item}</code>
          ))}
        </div>
      )}
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }): React.ReactElement {
  return <th className={clsx('px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80', className)}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return <td className={clsx('px-3 py-2 align-middle', className)}>{children}</td>;
}
