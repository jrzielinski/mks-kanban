import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, RefreshCw, Play, RotateCcw, File } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { dumsApi, tasksApi } from '../ipc/client';
import type { DumDetailDTO } from '@shared/types';

const STATUS_COLORS: Record<string, string> = {
  pending:      'bg-surface-3 text-dim',
  'in-progress': 'bg-primary/10 text-primary',
  verification: 'bg-warning/10 text-warning',
  done:         'bg-success/10 text-success',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

export function DumDetailPage(): React.ReactElement {
  const { id: projectId, dumId } = useParams<{ id: string; dumId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<'spec' | 'artifacts' | 'tasks'>('spec');
  const [pendingRun, setPendingRun] = React.useState(false);
  const [pendingRevert, setPendingRevert] = React.useState(false);

  const dumQ = useQuery<DumDetailDTO | null>({
    queryKey: ['dum-detail', dumId],
    queryFn: () => dumsApi.detail(dumId!),
    enabled: Boolean(dumId),
    staleTime: 30_000,
  });

  const runMut = useMutation({
    mutationFn: (taskId: string) => tasksApi.run(taskId, projectId ?? ''),
    onSuccess: (res) => {
      if (res.ok) { toast.success('DUM iniciada'); qc.invalidateQueries({ queryKey: ['dum-detail', dumId] }); }
      else toast.error(res.error ?? 'Falha ao iniciar');
      setPendingRun(false);
    },
    onError: (e: any) => { toast.error(e?.message ?? String(e)); setPendingRun(false); },
  });

  const dum = dumQ.data;

  const tabs = [
    { id: 'spec',      label: 'Spec' },
    { id: 'artifacts', label: `Artifacts${dum ? ` (${dum.artifactsCount})` : ''}` },
    { id: 'tasks',     label: `Tasks${dum ? ` (${dum.tasks.length})` : ''}` },
  ] as const;

  if (!dumId || !projectId) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-dim">
        DUM não encontrada
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(`/projects/${projectId}`)}
            className="rounded p-1 text-dim hover:text-text">
            <ArrowLeft size={14} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-dim">DUM {dum?.dumNumber ?? '…'}</span>
              {dum?.status && (
                <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium',
                  STATUS_COLORS[dum.status] ?? STATUS_COLORS['pending'])}>
                  {dum.status}
                </span>
              )}
            </div>
            <h1 className="text-[16px] font-semibold text-text leading-tight">
              {dumQ.isLoading ? 'Carregando…' : (dum?.title ?? 'DUM não encontrada')}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ['dum-detail', dumId] })}
            className="rounded p-1.5 text-dim hover:text-text">
            <RefreshCw size={13} className={clsx(dumQ.isFetching && 'animate-spin')} />
          </button>

          {pendingRevert ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-error">Reverter DUM?</span>
              <button type="button" onClick={() => { toast.info('Revert não implementado no backend'); setPendingRevert(false); }}
                className="rounded bg-error/10 px-2 py-1 text-[11px] text-error hover:bg-error/20">Sim</button>
              <button type="button" onClick={() => setPendingRevert(false)} className="text-[11px] text-dim hover:text-text">Não</button>
            </div>
          ) : (
            <button type="button" onClick={() => setPendingRevert(true)}
              className="flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-soft hover:text-error hover:border-error/50">
              <RotateCcw size={12} /> Reverter
            </button>
          )}

          {pendingRun ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-warning">Executar DUM?</span>
              <button type="button"
                disabled={runMut.isPending}
                onClick={() => {
                  const firstTask = dum?.tasks[0];
                  if (firstTask) runMut.mutate(firstTask.id);
                  else { toast.error('Nenhuma task associada'); setPendingRun(false); }
                }}
                className="rounded bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
                {runMut.isPending ? <RefreshCw size={10} className="animate-spin" /> : 'Sim'}
              </button>
              <button type="button" onClick={() => setPendingRun(false)} className="text-[11px] text-dim hover:text-text">Não</button>
            </div>
          ) : (
            <button type="button" onClick={() => setPendingRun(true)}
              disabled={dum?.status === 'done' || (dum !== undefined && dum?.tasks.length === 0)}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
              <Play size={12} /> Executar
            </button>
          )}
        </div>
      </header>

      <div className="flex border-b border-border-subtle px-6">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setActiveTab(t.id)}
            className={clsx('border-b-2 px-3 py-2.5 text-[11px] transition-colors',
              activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-dim hover:text-text')}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {activeTab === 'spec' && (
          <div className="prose prose-invert prose-sm max-w-none text-text">
            {dumQ.isLoading ? (
              <p className="text-dim text-[13px]">Carregando spec…</p>
            ) : dum?.specFull ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {dum.specFull}
              </ReactMarkdown>
            ) : (
              <p className="text-dim text-[13px]">Sem spec disponível</p>
            )}
          </div>
        )}

        {activeTab === 'artifacts' && (
          <>
            {(!dum || dum.artifacts.length === 0) && (
              <div className="py-10 text-center text-[13px] text-dim">Nenhum artifact gerado</div>
            )}
            {dum && dum.artifacts.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border-subtle">
                <table className="w-full">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Arquivo</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-dim">Tamanho</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dum.artifacts.map((a) => (
                      <tr key={a.path} className="border-t border-border-subtle hover:bg-surface-2/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <File size={12} className="text-dim shrink-0" />
                            <span className="font-mono text-[11px] text-text">{a.path}</span>
                          </div>
                          {a.contentPreview && (
                            <pre className="mt-1 text-[9px] text-dim truncate max-w-[600px]">{a.contentPreview}</pre>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-[11px] text-dim">{formatBytes(a.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {activeTab === 'tasks' && (
          <>
            {(!dum || dum.tasks.length === 0) && (
              <div className="py-10 text-center text-[13px] text-dim">Nenhuma task associada</div>
            )}
            {dum && dum.tasks.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border-subtle">
                <table className="w-full">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Título</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Status</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Responsável</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dum.tasks.map((t) => (
                      <tr key={t.id} className="border-t border-border-subtle hover:bg-surface-2/50">
                        <td className="px-4 py-3">
                          <span className="text-[12px] text-text">{t.title}</span>
                          {t.description && (
                            <span className="block text-[10px] text-dim truncate max-w-[400px]">{t.description}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium',
                            STATUS_COLORS[t.status] ?? STATUS_COLORS['pending'])}>
                            {t.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[11px] text-dim">{t.assignee ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
