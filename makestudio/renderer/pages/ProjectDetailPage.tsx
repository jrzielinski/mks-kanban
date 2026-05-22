import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, RefreshCw, Play, List, Layers } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { tasksApi, dumsApi, projectsApi } from '../ipc/client';
import type { ProjectDTO, TaskDTO, DumDTO } from '@shared/types';

const STATUS_COLORS: Record<string, string> = {
  'pending': 'bg-surface-3 text-dim',
  'in-progress': 'bg-primary/10 text-primary',
  'verification': 'bg-warning/10 text-warning',
  'done': 'bg-success/10 text-success',
};

function TaskRow({ task }: { task: TaskDTO }) {
  const qc = useQueryClient();
  const [pending, setPending] = React.useState(false);

  const runMut = useMutation({
    mutationFn: () => tasksApi.run(task.id, task.projectId),
    onSuccess: (res) => {
      if (res.ok) { toast.success('Task iniciada'); qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }); }
      else toast.error(res.error ?? 'Falha');
      setPending(false);
    },
    onError: (e: any) => { toast.error(e?.message ?? String(e)); setPending(false); },
  });

  return (
    <tr className="border-t border-border-subtle hover:bg-surface-2/50">
      <td className="px-4 py-3">
        <span className="text-[12px] text-text">{task.title}</span>
        {task.description && <span className="block text-[10px] text-dim truncate max-w-[300px]">{task.description}</span>}
      </td>
      <td className="px-4 py-3">
        <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_COLORS[task.status] ?? STATUS_COLORS['pending'])}>
          {task.status}
        </span>
      </td>
      <td className="px-4 py-3 text-[11px] text-dim">{task.assignee ?? '—'}</td>
      <td className="px-4 py-3 text-right">
        {pending ? (
          <div className="flex items-center justify-end gap-2">
            <span className="text-[11px] text-warning">Iniciar?</span>
            <button type="button" onClick={() => runMut.mutate()}
              className="rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/20">Sim</button>
            <button type="button" onClick={() => setPending(false)} className="text-[11px] text-dim hover:text-text">Não</button>
          </div>
        ) : (
          <button type="button" onClick={() => setPending(true)} disabled={task.status === 'done' || runMut.isPending}
            className="flex items-center gap-1 text-[11px] text-text-soft hover:text-primary disabled:opacity-30">
            <Play size={10} /> Executar
          </button>
        )}
      </td>
    </tr>
  );
}

export function ProjectDetailPage(): React.ReactElement {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<'tasks' | 'dums'>('tasks');
  const getIdFromHash = () => {
    const hash = window.location.hash.replace('#', '');
    const match = hash.match(/\/projects\/([^/]+)/);
    return match ? match[1] : null;
  };

  const [projectId, setProjectId] = React.useState<string | null>(getIdFromHash);

  React.useEffect(() => {
    const off = projectsApi.onActiveChanged((p) => setProjectId(p.id));
    return off;
  }, []);

  const projectQ = useQuery<ProjectDTO[]>({
    queryKey: ['projects'],
    queryFn: () => projectsApi.list(),
    staleTime: 30_000,
  });

  const tasksQ = useQuery<TaskDTO[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => tasksApi.list(projectId ?? ''),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });

  const dumsQ = useQuery<DumDTO[]>({
    queryKey: ['dums', projectId],
    queryFn: () => dumsApi.list(projectId ?? ''),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  const project = projectQ.data?.find(p => p.id === projectId);
  const tasks = tasksQ.data ?? [];
  const dums = dumsQ.data ?? [];

  const tabs = [
    { id: 'tasks', label: 'Tasks', icon: <List size={11} />, count: tasks.length },
    { id: 'dums', label: 'DUMs', icon: <Layers size={11} />, count: dums.length },
  ] as const;

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-dim">
        Selecione um projeto na lista de Projetos
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <FolderOpen size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">{project?.name ?? projectId}</h1>
        </div>
        <button type="button" onClick={() => { qc.invalidateQueries({ queryKey: ['tasks', projectId] }); }}
          className="rounded p-1.5 text-dim hover:text-text">
          <RefreshCw size={13} className={clsx(tasksQ.isFetching && 'animate-spin')} />
        </button>
      </header>

      <div className="flex border-b border-border-subtle px-6">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setActiveTab(t.id as any)}
            className={clsx('flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[11px] transition-colors',
              activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-dim hover:text-text')}>
            {t.icon} {t.label}
            {t.count > 0 && <span className="rounded bg-surface-3 px-1 text-[9px] text-dim">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {activeTab === 'tasks' && (
          <>
            {tasks.length === 0 && !tasksQ.isFetching && (
              <div className="py-10 text-center text-[13px] text-dim">Nenhuma task encontrada</div>
            )}
            {tasks.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border-subtle">
                <table className="w-full">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Título</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Status</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Responsável</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-dim">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map(t => <TaskRow key={t.id} task={t} />)}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {activeTab === 'dums' && (
          <>
            {dums.length === 0 && !dumsQ.isFetching && (
              <div className="py-10 text-center text-[13px] text-dim">Nenhuma DUM encontrada</div>
            )}
            {dums.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border-subtle">
                <table className="w-full">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">DUM</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Título</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Status</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-dim">Artifacts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dums.map(d => (
                      <tr key={d.id} className="border-t border-border-subtle hover:bg-surface-2/50">
                        <td className="px-4 py-3 font-mono text-[11px] text-dim">{d.dumNumber}</td>
                        <td className="px-4 py-3 text-[12px] text-text">{d.title}</td>
                        <td className="px-4 py-3">
                          <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_COLORS[d.status] ?? STATUS_COLORS['pending'])}>
                            {d.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-[11px] text-dim">{d.artifactsCount}</td>
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
