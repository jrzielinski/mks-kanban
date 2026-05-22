import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Plus, ChevronRight, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { projectsApi } from '../ipc/client';
import type { ProjectDTO } from '@shared/types';

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [localPath, setLocalPath] = React.useState('');

  const mut = useMutation({
    mutationFn: () => projectsApi.create({ name: name.trim(), localPath: localPath.trim() || undefined }),
    onSuccess: (res) => {
      if (res.ok) { toast.success(`Projeto "${name}" criado`); qc.invalidateQueries({ queryKey: ['projects'] }); onClose(); }
      else toast.error(res.error ?? 'Falha ao criar projeto');
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[460px] rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <FolderOpen size={14} className="text-primary" />
            <span className="text-[14px] font-semibold text-text">Novo projeto</span>
          </div>
          <button type="button" onClick={onClose} className="text-dim hover:text-text text-[18px] leading-none">×</button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">Nome <span className="text-error">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="meu-projeto"
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">Caminho local (opcional)</label>
            <input value={localPath} onChange={e => setLocalPath(e.target.value)} placeholder="/home/user/projetos/meu-projeto"
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-soft hover:text-text">Cancelar</button>
          <button type="button" onClick={() => mut.mutate()} disabled={!name.trim() || mut.isPending}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
            {mut.isPending ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Criar
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsPage(): React.ReactElement {
  const qc = useQueryClient();
  const [showNew, setShowNew] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const listQ = useQuery<ProjectDTO[]>({
    queryKey: ['projects'],
    queryFn: () => projectsApi.list(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const setActiveMut = useMutation({
    mutationFn: (p: ProjectDTO) => projectsApi.setActive({ id: p.id, name: p.name, localPath: p.localPath, tenantId: p.tenantId }),
    onSuccess: (_res, p) => toast.success(`Projeto "${p.name}" ativo`),
  });

  React.useEffect(() => {
    const off = projectsApi.onActiveChanged(() => qc.invalidateQueries({ queryKey: ['projects'] }));
    return off;
  }, [qc]);

  const projects = (listQ.data ?? []).filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <FolderOpen size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Projetos</h1>
          {listQ.data && <span className="text-[11px] text-dim">{listQ.data.length}</span>}
        </div>
        <div className="flex items-center gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar…"
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft outline-none focus:border-primary w-[200px]" />
          <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ['projects'] })} className="rounded p-1.5 text-dim hover:text-text">
            <RefreshCw size={13} className={clsx(listQ.isFetching && 'animate-spin')} />
          </button>
          <button type="button" onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
            <Plus size={12} /> Novo projeto
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        {projects.length === 0 && !listQ.isFetching && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <FolderOpen size={32} className="text-dim/40" />
            <p className="text-[13px] text-dim">{search ? 'Nenhum projeto encontrado' : 'Nenhum projeto cadastrado'}</p>
            {!search && (
              <button type="button" onClick={() => setShowNew(true)}
                className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
                <Plus size={12} /> Criar primeiro projeto
              </button>
            )}
          </div>
        )}

        {projects.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border-subtle">
            <table className="w-full">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Nome</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Caminho local</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Status</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-dim">Ações</th>
                </tr>
              </thead>
              <tbody>
                {projects.map(p => (
                  <tr key={p.id} className="border-t border-border-subtle hover:bg-surface-2/50">
                    <td className="px-4 py-3">
                      <span className="font-medium text-[13px] text-text">{p.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[10px] text-dim truncate max-w-[240px] block">{p.localPath ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      {p.status && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-text-soft">{p.status}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => setActiveMut.mutate(p)} disabled={setActiveMut.isPending}
                          className="rounded-md border border-border-subtle px-2.5 py-1 text-[11px] text-text-soft hover:text-text hover:border-primary/50 disabled:opacity-50">
                          Ativar
                        </button>
                        <ChevronRight size={13} className="text-dim" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
