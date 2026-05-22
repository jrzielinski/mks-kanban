import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ChevronLeft, ChevronRight, ExternalLink, User } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { tasksApi } from '../ipc/client';
import type { TaskDTO, TaskStatus } from '@shared/types';

const COLUMNS: { status: TaskStatus; label: string; colorClass: string; dotClass: string }[] = [
  { status: 'pending',      label: 'Pendente',     colorClass: 'border-t-border-subtle', dotClass: 'bg-dim' },
  { status: 'in-progress',  label: 'Em andamento', colorClass: 'border-t-primary',       dotClass: 'bg-primary' },
  { status: 'verification', label: 'Verificação',  colorClass: 'border-t-warning',       dotClass: 'bg-warning' },
  { status: 'done',         label: 'Concluído',    colorClass: 'border-t-success',       dotClass: 'bg-success' },
];

const COL_ORDER = COLUMNS.map((c) => c.status);

function prevStatus(s: TaskStatus): TaskStatus | null {
  const i = COL_ORDER.indexOf(s);
  return i > 0 ? COL_ORDER[i - 1] : null;
}
function nextStatus(s: TaskStatus): TaskStatus | null {
  const i = COL_ORDER.indexOf(s);
  return i < COL_ORDER.length - 1 ? COL_ORDER[i + 1] : null;
}

function KanbanCard({ task, onMove }: { task: TaskDTO; onMove: (t: TaskDTO, s: TaskStatus) => void }) {
  const prev = prevStatus(task.status);
  const next = nextStatus(task.status);

  return (
    <div className="rounded-md border border-border-subtle bg-surface-1 p-3 shadow-sm">
      <p className="text-[12px] font-medium text-text leading-snug">{task.title}</p>
      {task.description && (
        <p className="mt-1 text-[10px] text-dim line-clamp-2">{task.description}</p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0">
          {task.assignee && (
            <>
              <User size={9} className="text-dim shrink-0" />
              <span className="text-[9px] text-dim truncate">{task.assignee}</span>
            </>
          )}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer"
              className="ml-1 text-[9px] text-primary hover:underline flex items-center gap-0.5">
              <ExternalLink size={9} /> PR
            </a>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {prev && (
            <button type="button" title={`Mover para ${prev}`}
              onClick={() => onMove(task, prev)}
              className="rounded p-0.5 text-dim hover:text-text hover:bg-surface-3">
              <ChevronLeft size={12} />
            </button>
          )}
          {next && (
            <button type="button" title={`Mover para ${next}`}
              onClick={() => onMove(task, next)}
              className="rounded p-0.5 text-dim hover:text-text hover:bg-surface-3">
              <ChevronRight size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function KanbanPage(): React.ReactElement {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const tasksQ = useQuery<TaskDTO[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => tasksApi.list(projectId ?? ''),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });

  const moveMut = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      tasksApi.move(taskId, status),
    onMutate: async ({ taskId, status }) => {
      await qc.cancelQueries({ queryKey: ['tasks', projectId] });
      const prev = qc.getQueryData<TaskDTO[]>(['tasks', projectId]);
      qc.setQueryData<TaskDTO[]>(['tasks', projectId], (old) =>
        (old ?? []).map((t) => (t.id === taskId ? { ...t, status } : t)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx: any) => {
      if (ctx?.prev) qc.setQueryData(['tasks', projectId], ctx.prev);
      toast.error('Falha ao mover task');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });

  const tasks = tasksQ.data ?? [];
  const byColumn = (status: TaskStatus) => tasks.filter((t) => t.status === status);

  function handleMove(task: TaskDTO, status: TaskStatus) {
    moveMut.mutate({ taskId: task.id, status });
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-dim">
        Selecione um projeto
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <h1 className="text-[18px] font-semibold text-text">Kanban</h1>
        <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ['tasks', projectId] })}
          className="rounded p-1.5 text-dim hover:text-text">
          <RefreshCw size={13} className={clsx(tasksQ.isFetching && 'animate-spin')} />
        </button>
      </header>

      <div className="flex flex-1 gap-4 overflow-hidden px-6 py-5">
        {COLUMNS.map((col) => {
          const cards = byColumn(col.status);
          return (
            <div key={col.status}
              className={clsx('flex w-[25%] flex-col rounded-md border-t-2 border border-border-subtle bg-surface-2/50 overflow-hidden', col.colorClass)}>
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle">
                <span className={clsx('h-2 w-2 rounded-full shrink-0', col.dotClass)} />
                <span className="text-[11px] font-medium text-text">{col.label}</span>
                <span className="ml-auto rounded bg-surface-3 px-1.5 text-[9px] text-dim">{cards.length}</span>
              </div>
              <div className="flex flex-col gap-2 overflow-auto p-2">
                {cards.length === 0 && !tasksQ.isFetching && (
                  <p className="py-4 text-center text-[10px] text-dim/60">Vazio</p>
                )}
                {cards.map((t) => (
                  <KanbanCard key={t.id} task={t} onMove={handleMove} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
