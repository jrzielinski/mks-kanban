import React from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  CassetteTape,
  Play,
  Square,
  RefreshCw,
  Inbox,
  Circle,
  Plus,
  X,
  AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { cassettesApi } from '../ipc/client';
import type { CassetteDTO } from '@shared/types';

export function CassettesPage(): React.ReactElement {
  const qc = useQueryClient();
  const [recording, setRecording] = React.useState<{
    name: string;
    startedAt: number;
  } | null>(null);
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [recordName, setRecordName] = React.useState('');
  const [elapsed, setElapsed] = React.useState(0);

  const listQuery = useQuery<CassetteDTO[]>({
    queryKey: ['cassettes', 'list'],
    queryFn: () => cassettesApi.list(),
    staleTime: 3_000,
  });

  // Atualiza elapsed timer enquanto gravando
  React.useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => {
      setElapsed(Date.now() - recording.startedAt);
    }, 500);
    return () => window.clearInterval(t);
  }, [recording]);

  const startMut = useMutation({
    mutationFn: (name: string) => cassettesApi.recordStart(name),
    onSuccess: (res, name) => {
      if (res.ok) {
        setRecording({ name, startedAt: Date.now() });
        setRecordOpen(false);
        setRecordName('');
      }
    },
  });

  const stopMut = useMutation({
    mutationFn: () => cassettesApi.recordStop(),
    onSuccess: () => {
      setRecording(null);
      setElapsed(0);
      qc.invalidateQueries({ queryKey: ['cassettes'] });
    },
  });

  const replayMut = useMutation({
    mutationFn: (name: string) => cassettesApi.replay(name),
  });

  const refresh = (): void => {
    qc.invalidateQueries({ queryKey: ['cassettes'] });
  };

  const cassettes = listQuery.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">
            Cassettes — gravação e replay
          </h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            {cassettes.length}{' '}
            {cassettes.length === 1 ? 'cassette salvo' : 'cassettes salvos'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3"
          >
            <RefreshCw
              size={13}
              className={clsx(listQuery.isLoading && 'animate-spin')}
            />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => setRecordOpen(true)}
            disabled={!!recording}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12.5px] font-medium text-surface-0 transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={13} />
            Gravar
          </button>
        </div>
      </header>

      {/* Status banner — só quando gravando */}
      {recording && (
        <div className="border-b border-danger/30 bg-danger/8 px-6 py-3">
          <div className="flex items-center gap-3">
            <Circle
              size={10}
              fill="currentColor"
              className="animate-pulse text-danger"
            />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-danger">
                Gravando: <span className="font-mono">{recording.name}</span>
              </div>
              <div className="mt-0.5 font-mono text-[11.5px] text-dim-soft">
                {formatElapsed(elapsed)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => stopMut.mutate()}
              disabled={stopMut.isPending}
              className="flex h-8 items-center gap-1.5 rounded-md border border-danger/40 bg-surface-2 px-3 text-[12.5px] font-medium text-danger hover:bg-danger/15 disabled:opacity-60"
            >
              <Square size={11} fill="currentColor" />
              {stopMut.isPending ? 'Parando…' : 'Parar gravação'}
            </button>
          </div>
        </div>
      )}

      {/* Lista */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {listQuery.isError && (
          <div className="rounded-md border border-danger/30 bg-danger/8 px-4 py-3 text-[13px] text-danger">
            Erro ao carregar cassettes.
          </div>
        )}
        {!listQuery.isError &&
          cassettes.length === 0 &&
          !listQuery.isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
              <Inbox size={28} strokeWidth={1.4} />
              <div className="text-[13px]">
                Nenhum cassette gravado. Click em{' '}
                <span className="text-text">Gravar</span> pra começar.
              </div>
            </div>
          )}
        {cassettes.length > 0 && (
          <CassettesTable
            cassettes={cassettes}
            onReplay={(name) => replayMut.mutate(name)}
            replayPending={replayMut.isPending}
          />
        )}
      </div>

      <RecordDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        name={recordName}
        onNameChange={setRecordName}
        loading={startMut.isPending}
        onConfirm={() => startMut.mutate(recordName.trim())}
      />
    </div>
  );
}

// ── Tabela ───────────────────────────────────────────────────────────────

interface TableProps {
  cassettes: CassetteDTO[];
  onReplay: (name: string) => void;
  replayPending: boolean;
}

function CassettesTable({
  cassettes,
  onReplay,
  replayPending,
}: TableProps): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-1/40">
      <table className="w-full text-left text-[12.5px]">
        <thead className="border-b border-border-subtle bg-surface-2/60 text-[10.5px] uppercase tracking-[0.1em] text-dim/80">
          <tr>
            <th className="px-4 py-2 font-medium">Nome</th>
            <th className="px-4 py-2 text-right font-medium">Turns</th>
            <th className="px-4 py-2 text-right font-medium">Tamanho</th>
            <th className="px-4 py-2 font-medium">Gravado</th>
            <th className="w-[1%] px-4 py-2 font-medium">Ações</th>
          </tr>
        </thead>
        <tbody>
          {cassettes.map((c) => (
            <tr
              key={c.name}
              className="border-b border-border-subtle/60 transition-colors last:border-0 hover:bg-surface-2/40"
            >
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <CassetteTape
                    size={13}
                    strokeWidth={1.8}
                    className="shrink-0 text-secondary"
                  />
                  <span className="font-mono font-medium text-text">
                    {c.name}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-dim/70">
                  {c.path}
                </div>
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-dim-soft">
                {c.turns}
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-dim-soft">
                {formatBytes(c.sizeBytes)}
              </td>
              <td className="px-4 py-2.5 text-dim-soft">
                {relativeTime(c.recordedAt)}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    title="Replay"
                    onClick={() => onReplay(c.name)}
                    disabled={replayPending}
                    className="flex h-7 w-7 items-center justify-center rounded text-dim transition-colors hover:bg-success/15 hover:text-success disabled:opacity-50"
                  >
                    <Play size={12} strokeWidth={2} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Dialog de gravação ───────────────────────────────────────────────────

interface RecordDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  name: string;
  onNameChange: (v: string) => void;
  loading: boolean;
  onConfirm: () => void;
}

function RecordDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  loading,
  onConfirm,
}: RecordDialogProps): React.ReactElement {
  const valid = /^[a-z0-9][a-z0-9-_]{0,39}$/i.test(name);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
          <div className="mb-3 flex items-center gap-2">
            <Circle
              size={10}
              fill="currentColor"
              className="text-danger"
            />
            <Dialog.Title className="text-[14px] font-semibold text-text">
              Iniciar nova gravação
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="ml-auto flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-surface-3 hover:text-text"
              >
                <X size={12} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-3 text-[12.5px] text-text-soft">
            Cada turn da sessão atual será capturado em{' '}
            <span className="font-mono text-dim">
              ~/.makestudio/cassettes/&lt;nome&gt;.json
            </span>
            .
          </Dialog.Description>
          <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-dim/80">
            Nome do cassette
          </label>
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="meu-test-bridge"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) onConfirm();
            }}
            className="block w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-[13px] text-text placeholder:text-dim/70 focus:border-primary/50 focus:outline-none"
          />
          {!valid && name.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-warning">
              <AlertTriangle size={11} />
              Use letras, números, traço ou underscore (até 40 chars).
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12.5px] text-text-soft hover:bg-surface-3"
              >
                Cancelar
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!valid || loading}
              className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Iniciando…' : 'Iniciar gravação'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Utils ───────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  return `${m}:${String(rs).padStart(2, '0')} elapsed`;
}

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
