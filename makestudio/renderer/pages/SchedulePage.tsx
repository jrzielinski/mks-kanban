import React from 'react';
import {
  useQuery,
  useQueryClient,
  useMutation,
} from '@tanstack/react-query';
import * as Switch from '@radix-ui/react-switch';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlarmClock,
  CheckCircle2,
  Circle,
  ChevronRight,
  ChevronDown,
  Inbox,
  Plus,
  Play,
  RefreshCw,
  MoreHorizontal,
  Trash2,
  Edit3,
  AlertTriangle,
  Server,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { scheduleApi, daemonApi, subscribe } from '../ipc/client';
import { ScheduleAddModal } from '../components/schedule/ScheduleAddModal';
import { humanCron } from '../utils/humanCron';
import * as CH from '@shared/channels';
import type {
  ScheduleDTO,
  ScheduleRunDTO,
  DaemonStatusDTO,
} from '@shared/types';

export function SchedulePage(): React.ReactElement {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ScheduleDTO | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<ScheduleDTO | null>(
    null,
  );

  const listQuery = useQuery<ScheduleDTO[]>({
    queryKey: ['schedule', 'list'],
    queryFn: () => scheduleApi.list(),
    staleTime: 5_000,
  });

  const daemonQuery = useQuery<DaemonStatusDTO>({
    queryKey: ['schedule', 'daemon'],
    queryFn: () => daemonApi.status(),
    refetchInterval: 30_000,
  });

  // Live update do daemon após install/uninstall — main faz broadcast.
  React.useEffect(() => {
    return subscribe<DaemonStatusDTO>(CH.EVT_DAEMON_STATUS, (status) => {
      qc.setQueryData(['schedule', 'daemon'], status);
    });
  }, [qc]);

  const installMut = useMutation({
    mutationFn: () => daemonApi.install(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule', 'daemon'] }),
  });
  const uninstallMut = useMutation({
    mutationFn: () => daemonApi.uninstall(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule', 'daemon'] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      scheduleApi.toggle(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule', 'list'] }),
  });
  const removeMut = useMutation({
    mutationFn: (id: string) => scheduleApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedule', 'list'] });
      setConfirmRemove(null);
    },
  });
  const runNowMut = useMutation({
    mutationFn: (id: string) => scheduleApi.runNow(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['schedule', 'list'] });
      qc.invalidateQueries({ queryKey: ['schedule', 'runs', id] });
    },
  });

  const schedules = listQuery.data ?? [];
  const daemon = daemonQuery.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">Agendamentos</h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            {schedules.length}{' '}
            {schedules.length === 1
              ? 'schedule cadastrado'
              : 'schedules cadastrados'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => qc.invalidateQueries({ queryKey: ['schedule'] })}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3"
          >
            <RefreshCw
              size={13}
              className={clsx(listQuery.isFetching && 'animate-spin')}
            />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setAddOpen(true);
            }}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12.5px] font-medium text-surface-0 transition-colors hover:bg-primary-soft"
          >
            <Plus size={13} />
            Novo schedule
          </button>
        </div>
      </header>

      {/* Daemon banner */}
      <DaemonBanner
        status={daemon}
        loading={daemonQuery.isLoading}
        installing={installMut.isPending}
        uninstalling={uninstallMut.isPending}
        onInstall={() => installMut.mutate()}
        onUninstall={() => uninstallMut.mutate()}
        installError={installMut.data?.ok === false ? installMut.data.message : null}
      />

      {/* Tabela */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {listQuery.isError && (
          <div className="rounded-md border border-danger/30 bg-danger/8 px-4 py-3 text-[13px] text-danger">
            Erro ao carregar schedules.
          </div>
        )}
        {!listQuery.isError &&
          schedules.length === 0 &&
          !listQuery.isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
              <Inbox size={28} strokeWidth={1.4} />
              <div className="text-[13px]">
                Nenhum schedule cadastrado. Click em{' '}
                <span className="text-text">Novo schedule</span> pra começar.
              </div>
            </div>
          )}
        {schedules.length > 0 && (
          <ScheduleTable
            schedules={schedules}
            onToggle={(s) => toggleMut.mutate({ id: s.id, enabled: !s.enabled })}
            onRemove={(s) => setConfirmRemove(s)}
            onEdit={(s) => {
              setEditing(s);
              setAddOpen(true);
            }}
            onRunNow={(s) => runNowMut.mutate(s.id)}
            runNowPendingFor={runNowMut.isPending ? runNowMut.variables : null}
          />
        )}
      </div>

      <ScheduleAddModal
        open={addOpen}
        onOpenChange={(v) => {
          setAddOpen(v);
          if (!v) setEditing(null);
        }}
        initial={editing}
      />

      {confirmRemove && (
        <ConfirmRemoveDialog
          schedule={confirmRemove}
          loading={removeMut.isPending}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => removeMut.mutate(confirmRemove.id)}
        />
      )}
    </div>
  );
}

// ─── Daemon banner ──────────────────────────────────────────────────────

interface DaemonBannerProps {
  status: DaemonStatusDTO | undefined;
  loading: boolean;
  installing: boolean;
  uninstalling: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  installError: string | null;
}

function DaemonBanner({
  status,
  loading,
  installing,
  uninstalling,
  onInstall,
  onUninstall,
  installError,
}: DaemonBannerProps): React.ReactElement {
  if (loading || !status) {
    return (
      <div className="border-b border-border-subtle px-6 py-3 text-[12.5px] text-dim-soft">
        Verificando daemon…
      </div>
    );
  }
  if (status.platform === 'other') {
    return (
      <div className="border-b border-border-subtle px-6 py-3 text-[12.5px] text-dim-soft">
        <AlertTriangle size={12} className="mr-1.5 inline text-warning" />
        Daemon não suportado nesta plataforma. Schedules ainda rodam enquanto
        o app estiver aberto.
      </div>
    );
  }
  const badge = status.running
    ? { color: 'text-success', label: 'ativo', icon: CheckCircle2 }
    : status.installed
      ? { color: 'text-warning', label: 'instalado mas parado', icon: AlertTriangle }
      : { color: 'text-dim', label: 'não instalado', icon: XCircle };
  const Icon = badge.icon;

  return (
    <div className="border-b border-border-subtle bg-surface-1/40 px-6 py-3">
      <div className="flex items-center gap-4">
        <Server size={16} strokeWidth={1.8} className="shrink-0 text-secondary" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-text">
              Daemon ({status.platform === 'darwin' ? 'launchd' : 'systemd'})
            </span>
            <span className={clsx('inline-flex items-center gap-1 text-[12px]', badge.color)}>
              <Icon size={12} />
              {badge.label}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-dim-soft">
            {status.cliBinary
              ? `CLI: ${status.cliBinary}`
              : 'CLI makestudio não encontrada no PATH'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!status.cliAvailable && (
            <span className="text-[11.5px] text-warning">
              instale com{' '}
              <code className="rounded bg-surface-3 px-1 py-0.5 font-mono">
                npm i -g makestudio
              </code>
            </span>
          )}
          {status.installed ? (
            <button
              type="button"
              onClick={onUninstall}
              disabled={uninstalling}
              className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
            >
              {uninstalling ? 'Removendo…' : 'Desinstalar'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onInstall}
              disabled={installing || !status.cliAvailable}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12.5px] font-medium text-surface-0 transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing ? 'Instalando…' : 'Instalar daemon'}
            </button>
          )}
        </div>
      </div>
      {installError && (
        <div className="mt-2 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-[12px] text-danger">
          {installError}
        </div>
      )}
    </div>
  );
}

// ─── Tabela ─────────────────────────────────────────────────────────────

interface TableProps {
  schedules: ScheduleDTO[];
  onToggle: (s: ScheduleDTO) => void;
  onRemove: (s: ScheduleDTO) => void;
  onEdit: (s: ScheduleDTO) => void;
  onRunNow: (s: ScheduleDTO) => void;
  runNowPendingFor: string | null;
}

function ScheduleTable({
  schedules,
  onToggle,
  onRemove,
  onEdit,
  onRunNow,
  runNowPendingFor,
}: TableProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-1/40">
      <table className="w-full text-left text-[12.5px]">
        <thead className="border-b border-border-subtle bg-surface-2/60 text-[10.5px] uppercase tracking-[0.1em] text-dim/80">
          <tr>
            <th className="w-[1%] px-4 py-2"></th>
            <th className="px-4 py-2 font-medium">Nome</th>
            <th className="px-4 py-2 font-medium">Cron</th>
            <th className="px-4 py-2 font-medium">Próximo</th>
            <th className="px-4 py-2 font-medium">Último</th>
            <th className="w-[1%] px-4 py-2 text-center font-medium">Ativo</th>
            <th className="w-[1%] px-4 py-2 font-medium">Ações</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              expanded={expanded.has(s.id)}
              onExpand={() => toggle(s.id)}
              onToggle={() => onToggle(s)}
              onEdit={() => onEdit(s)}
              onRemove={() => onRemove(s)}
              onRunNow={() => onRunNow(s)}
              runNowPending={runNowPendingFor === s.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  schedule: ScheduleDTO;
  expanded: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRunNow: () => void;
  runNowPending: boolean;
}

function ScheduleRow({
  schedule,
  expanded,
  onExpand,
  onToggle,
  onEdit,
  onRemove,
  onRunNow,
  runNowPending,
}: RowProps): React.ReactElement {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border-subtle/60 transition-colors hover:bg-surface-2/40"
        onClick={onExpand}
      >
        <td className="px-2 py-2.5">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center text-dim hover:text-text"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <AlarmClock
              size={13}
              strokeWidth={1.8}
              className="shrink-0 text-secondary"
            />
            <span className="font-medium text-text">{schedule.name}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-dim/70">
            {schedule.command}
          </div>
        </td>
        <td className="px-4 py-2.5">
          <div className="font-mono text-[11.5px] text-text-soft">
            {schedule.cron}
          </div>
          <div className="mt-0.5 text-[11px] text-dim/70">
            {humanCron(schedule.cron)}
          </div>
        </td>
        <td className="px-4 py-2.5 text-dim-soft">
          {schedule.nextRunAt ? relativeFuture(schedule.nextRunAt) : '—'}
        </td>
        <td className="px-4 py-2.5 text-dim-soft">
          {schedule.lastRunAt ? relativeTime(schedule.lastRunAt) : '—'}
        </td>
        <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
          <Switch.Root
            checked={schedule.enabled}
            onCheckedChange={onToggle}
            className={clsx(
              'relative h-4 w-7 rounded-full transition-colors',
              schedule.enabled ? 'bg-success' : 'bg-surface-3',
            )}
          >
            <Switch.Thumb
              className={clsx(
                'block h-3 w-3 rounded-full bg-white shadow transition-transform',
                'translate-x-0.5',
                'data-[state=checked]:translate-x-3.5',
              )}
            />
          </Switch.Root>
        </td>
        <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
          <RowMenu
            onEdit={onEdit}
            onRunNow={onRunNow}
            onRemove={onRemove}
            runNowPending={runNowPending}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border-subtle/60 bg-surface-1/20">
          <td colSpan={7} className="px-12 py-3">
            <ExpandedRunHistory scheduleId={schedule.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function RowMenu({
  onEdit,
  onRunNow,
  onRemove,
  runNowPending,
}: {
  onEdit: () => void;
  onRunNow: () => void;
  onRemove: () => void;
  runNowPending: boolean;
}): React.ReactElement {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded text-dim hover:bg-surface-3 hover:text-text"
          title="Mais ações"
        >
          <MoreHorizontal size={13} strokeWidth={2} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[160px] rounded-md border border-border-subtle bg-surface-1 p-1 shadow-elev"
        >
          <DropdownMenu.Item
            onSelect={onRunNow}
            disabled={runNowPending}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] text-text-soft outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-3 data-[highlighted]:text-text"
          >
            <Play size={12} strokeWidth={2} />
            {runNowPending ? 'Executando…' : 'Rodar agora'}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onEdit}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] text-text-soft outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text"
          >
            <Edit3 size={12} strokeWidth={2} />
            Editar
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border-subtle/60" />
          <DropdownMenu.Item
            onSelect={onRemove}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] text-danger outline-none data-[highlighted]:bg-danger/15"
          >
            <Trash2 size={12} strokeWidth={2} />
            Remover
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ─── Run history (expanded row) ─────────────────────────────────────────

function ExpandedRunHistory({
  scheduleId,
}: {
  scheduleId: string;
}): React.ReactElement {
  const runsQuery = useQuery<ScheduleRunDTO[]>({
    queryKey: ['schedule', 'runs', scheduleId],
    queryFn: () => scheduleApi.runs(scheduleId, 10),
    staleTime: 5_000,
  });

  if (runsQuery.isLoading) {
    return <div className="text-[11.5px] text-dim-soft">Carregando histórico…</div>;
  }
  const runs = runsQuery.data ?? [];
  if (runs.length === 0) {
    return (
      <div className="text-[11.5px] text-dim/70">
        Nenhuma execução registrada ainda.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-dim/70">
        Últimas {runs.length} execuções
      </div>
      {runs.map((r) => (
        <RunHistoryRow key={r.runId} run={r} />
      ))}
    </div>
  );
}

function RunHistoryRow({ run }: { run: ScheduleRunDTO }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const ok = run.exitCode === 0;
  const Icon = ok ? CheckCircle2 : XCircle;
  const color = ok ? 'text-success' : 'text-danger';
  const hasOutput = run.outputTail.trim().length > 0 || run.error;
  return (
    <div className="rounded border border-border-subtle/40 bg-surface-2/40">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((v) => !v)}
        className={clsx(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px]',
          hasOutput && 'cursor-pointer hover:bg-surface-3/40',
        )}
      >
        <Icon size={11} strokeWidth={2} className={clsx('shrink-0', color)} />
        <span className="font-mono text-text-soft">
          {relativeTime(run.ranAt)}
        </span>
        <span className="text-dim">·</span>
        <span className="font-mono text-dim-soft">
          {formatDuration(run.durationMs)}
        </span>
        <span className="text-dim">·</span>
        <span className="text-dim-soft">{triggerLabel(run.trigger)}</span>
        {!ok && (
          <span className="ml-2 truncate font-mono text-[11px] text-danger">
            {run.error ?? `exit ${run.exitCode}`}
          </span>
        )}
        {hasOutput && (
          <span className="ml-auto text-[10px] text-dim/70">
            {expanded ? 'recolher' : 'ver output'}
          </span>
        )}
      </button>
      {expanded && hasOutput && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border-subtle/40 bg-surface-1/60 px-3 py-2 font-mono text-[11px] text-text-soft">
          {run.error ? run.error + '\n' : ''}
          {run.outputTail}
        </pre>
      )}
    </div>
  );
}

// ─── Confirm remove ─────────────────────────────────────────────────────

function ConfirmRemoveDialog({
  schedule,
  loading,
  onCancel,
  onConfirm,
}: {
  schedule: ScheduleDTO;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[420px] rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev">
        <div className="mb-2 flex items-center gap-2">
          <Trash2 size={14} className="text-danger" />
          <h2 className="text-[14px] font-semibold text-text">
            Remover schedule
          </h2>
        </div>
        <p className="text-[12.5px] text-text-soft">
          Tem certeza que quer remover{' '}
          <span className="font-mono text-text">{schedule.name}</span>? Essa ação
          não pode ser desfeita.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12.5px] text-text-soft hover:bg-surface-3"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-md bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-danger/90 disabled:opacity-60"
          >
            {loading ? 'Removendo…' : 'Remover'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Utils inline ───────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `há ${Math.round(diff / 60_000)}min`;
  if (diff < 86_400_000) return `há ${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `há ${Math.round(diff / 86_400_000)}d`;
  return new Date(t).toLocaleDateString('pt-BR');
}

function relativeFuture(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = t - Date.now();
  if (diff <= 0) return 'pendente';
  if (diff < 60_000) return 'em <1min';
  if (diff < 3_600_000) return `em ${Math.round(diff / 60_000)}min`;
  if (diff < 86_400_000) return `em ${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `em ${Math.round(diff / 86_400_000)}d`;
  return new Date(t).toLocaleDateString('pt-BR');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function triggerLabel(t: ScheduleRunDTO['trigger']): string {
  if (t === 'manual') return 'manual';
  if (t === 'daemon') return 'daemon';
  return 'poller';
}
