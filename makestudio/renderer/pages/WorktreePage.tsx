import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranch, RefreshCw, Plus, Merge, Trash2, Star } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { worktreeApi } from '../ipc/client';
import type { WorktreeListItemDTO } from '@shared/types';

function CreateWorktreeModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [dumNumber, setDumNumber] = React.useState('');

  const mut = useMutation({
    mutationFn: () => worktreeApi.create(dumNumber.trim()),
    onSuccess: (res) => {
      if (res.ok) { toast.success(`Worktree dum/${dumNumber} criado`); qc.invalidateQueries({ queryKey: ['worktrees'] }); onClose(); }
      else toast.error(res.error ?? 'Falha ao criar worktree');
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[400px] rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-primary" />
            <span className="text-[14px] font-semibold text-text">Criar worktree</span>
          </div>
          <button type="button" onClick={onClose} className="text-dim hover:text-text text-[18px] leading-none">×</button>
        </div>
        <div className="px-5 py-5">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">Número do DUM <span className="text-error">*</span></label>
            <input value={dumNumber} onChange={e => setDumNumber(e.target.value)} placeholder="001"
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
            <span className="text-[10px] text-dim">Branch criado: dum/{dumNumber || '001'}</span>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-soft hover:text-text">Cancelar</button>
          <button type="button" onClick={() => mut.mutate()} disabled={!dumNumber.trim() || mut.isPending}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
            {mut.isPending ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Criar
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorktreePage(): React.ReactElement {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<{ wt: WorktreeListItemDTO; action: 'merge' | 'cleanup' } | null>(null);

  const listQ = useQuery<WorktreeListItemDTO[]>({
    queryKey: ['worktrees'],
    queryFn: () => worktreeApi.list(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  React.useEffect(() => {
    const off = worktreeApi.onChanged(() => qc.invalidateQueries({ queryKey: ['worktrees'] }));
    return off;
  }, [qc]);

  const mergeMut = useMutation({
    mutationFn: (wt: WorktreeListItemDTO) => worktreeApi.merge({
      worktreePath: wt.path, branch: wt.branch, baseSha: wt.head,
      originalRepo: '', originalBranch: null,
    }),
    onSuccess: (res) => {
      if (res.ok) { toast.success('Merge concluído'); qc.invalidateQueries({ queryKey: ['worktrees'] }); }
      else toast.error(res.error ?? 'Falha no merge');
      setPendingAction(null);
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  const cleanupMut = useMutation({
    mutationFn: (wt: WorktreeListItemDTO) => worktreeApi.cleanup({
      worktreePath: wt.path, branch: wt.branch, baseSha: wt.head,
      originalRepo: '', originalBranch: null,
    }),
    onSuccess: (res) => {
      if (res.ok) { toast.success('Worktree removido'); qc.invalidateQueries({ queryKey: ['worktrees'] }); }
      else toast.error(res.error ?? 'Falha ao remover');
      setPendingAction(null);
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  const worktrees = listQ.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <GitBranch size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Worktrees</h1>
          {worktrees.length > 0 && <span className="text-[11px] text-dim">{worktrees.length}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ['worktrees'] })} className="rounded p-1.5 text-dim hover:text-text">
            <RefreshCw size={13} className={clsx(listQ.isFetching && 'animate-spin')} />
          </button>
          <button type="button" onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
            <Plus size={12} /> Criar worktree
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        {worktrees.length === 0 && !listQ.isFetching && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <GitBranch size={32} className="text-dim/40" />
            <p className="text-[13px] text-dim">Nenhum worktree ativo</p>
          </div>
        )}

        {worktrees.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border-subtle">
            <table className="w-full">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Branch</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Caminho</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">HEAD</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-dim">Ações</th>
                </tr>
              </thead>
              <tbody>
                {worktrees.map(wt => {
                  const isConfirming = pendingAction?.wt.path === wt.path;
                  const isWorking = mergeMut.isPending || cleanupMut.isPending;
                  return (
                    <tr key={wt.path} className="border-t border-border-subtle">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {wt.isMain && <Star size={10} className="text-warning" />}
                          <span className="font-mono text-[12px] text-text">{wt.branch}</span>
                          {wt.isDetached && <span className="rounded bg-warning/10 px-1 text-[9px] text-warning">detached</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[10px] text-dim truncate max-w-[300px] block">{wt.path}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[10px] text-dim">{wt.head.slice(0, 8)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {wt.isMain ? (
                          <span className="text-[10px] text-dim">principal</span>
                        ) : isConfirming ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-[11px] text-warning">Confirmar {pendingAction.action}?</span>
                            <button type="button" disabled={isWorking} onClick={() => {
                              if (pendingAction.action === 'merge') mergeMut.mutate(wt);
                              else cleanupMut.mutate(wt);
                            }} className="rounded bg-warning/10 px-2 py-0.5 text-[11px] text-warning hover:bg-warning/20 disabled:opacity-50">Sim</button>
                            <button type="button" onClick={() => setPendingAction(null)} className="text-[11px] text-dim hover:text-text">Cancelar</button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <button type="button" onClick={() => setPendingAction({ wt, action: 'merge' })}
                              className="flex items-center gap-1 text-[11px] text-text-soft hover:text-success">
                              <Merge size={11} /> Merge
                            </button>
                            <button type="button" onClick={() => setPendingAction({ wt, action: 'cleanup' })}
                              className="flex items-center gap-1 text-[11px] text-text-soft hover:text-error">
                              <Trash2 size={11} /> Descartar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && <CreateWorktreeModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}
