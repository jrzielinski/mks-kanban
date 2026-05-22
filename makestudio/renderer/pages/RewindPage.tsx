import React from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Clock,
  RotateCcw,
  Trash2,
  RefreshCw,
  Inbox,
  AlertTriangle,
  X,
  FileText,
} from 'lucide-react';
import clsx from 'clsx';
import { rewindApi } from '../ipc/client';
import type { RewindCheckpointDTO } from '@shared/types';

export function RewindPage(): React.ReactElement {
  const qc = useQueryClient();
  const [confirmRestore, setConfirmRestore] = React.useState<number | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<string | null>(null);

  const listQuery = useQuery<RewindCheckpointDTO[]>({
    queryKey: ['rewind', 'list'],
    queryFn: () => rewindApi.list(),
    staleTime: 3_000,
  });

  const restoreMut = useMutation({
    mutationFn: (turn: number) => rewindApi.restore(turn),
    onSuccess: (res) => {
      setConfirmRestore(null);
      qc.invalidateQueries({ queryKey: ['rewind'] });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      if (res.error) {
        setLastResult(`Erro: ${res.error}`);
      } else {
        setLastResult(
          `${res.filesRestored ?? 0} arquivos restaurados, ` +
            `${res.filesDeleted ?? 0} apagados, ` +
            `${res.messagesDropped ?? 0} mensagens descartadas.`,
        );
      }
      window.setTimeout(() => setLastResult(null), 6000);
    },
  });

  const clearMut = useMutation({
    mutationFn: () => rewindApi.clear(),
    onSuccess: (res) => {
      setConfirmClear(false);
      qc.invalidateQueries({ queryKey: ['rewind'] });
      setLastResult(`${res.removed} checkpoint(s) removido(s).`);
      window.setTimeout(() => setLastResult(null), 4000);
    },
  });

  const refresh = (): void => {
    qc.invalidateQueries({ queryKey: ['rewind'] });
  };

  const checkpoints = (listQuery.data ?? [])
    .slice()
    .sort((a, b) => b.turn - a.turn);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">
            Rewind — turn checkpoints
          </h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            {checkpoints.length}{' '}
            {checkpoints.length === 1 ? 'turn salvo' : 'turns salvos'} na sessão
            atual
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
            onClick={() => setConfirmClear(true)}
            disabled={checkpoints.length === 0 || clearMut.isPending}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-danger/15 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} />
            Limpar todos
          </button>
        </div>
      </header>

      {lastResult && (
        <div className="border-b border-success/30 bg-success/8 px-6 py-2 text-[12.5px] text-success">
          {lastResult}
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 py-4">
        {listQuery.isError && (
          <div className="rounded-md border border-danger/30 bg-danger/8 px-4 py-3 text-[13px] text-danger">
            Erro ao carregar checkpoints. O agent precisa estar rodando.
          </div>
        )}
        {!listQuery.isError &&
          checkpoints.length === 0 &&
          !listQuery.isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
              <Inbox size={28} strokeWidth={1.4} />
              <div className="text-center text-[13px]">
                Sem checkpoints ainda.
                <br />
                Cada turn da sessão atual cria um checkpoint automaticamente.
              </div>
            </div>
          )}
        {checkpoints.length > 0 && (
          <Timeline
            checkpoints={checkpoints}
            onRestore={(turn) => setConfirmRestore(turn)}
          />
        )}
      </div>

      <ConfirmRestoreDialog
        turn={confirmRestore}
        open={confirmRestore !== null}
        onOpenChange={(v) => !v && setConfirmRestore(null)}
        loading={restoreMut.isPending}
        onConfirm={() =>
          confirmRestore !== null && restoreMut.mutate(confirmRestore)
        }
      />
      <ConfirmClearDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        count={checkpoints.length}
        loading={clearMut.isPending}
        onConfirm={() => clearMut.mutate()}
      />
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────

interface TimelineProps {
  checkpoints: RewindCheckpointDTO[];
  onRestore: (turn: number) => void;
}

function Timeline({
  checkpoints,
  onRestore,
}: TimelineProps): React.ReactElement {
  return (
    <ol className="relative space-y-3 border-l-2 border-border-subtle pl-6">
      {checkpoints.map((c) => (
        <CheckpointCard key={c.turn} checkpoint={c} onRestore={onRestore} />
      ))}
    </ol>
  );
}

function CheckpointCard({
  checkpoint,
  onRestore,
}: {
  checkpoint: RewindCheckpointDTO;
  onRestore: (turn: number) => void;
}): React.ReactElement {
  const userMsg = (checkpoint.userMessage ?? '').trim();
  const truncated =
    userMsg.length > 200 ? userMsg.slice(0, 197) + '…' : userMsg;
  return (
    <li className="relative">
      <div className="absolute -left-[34px] top-3 flex h-5 w-5 items-center justify-center rounded-full border border-border-subtle bg-surface-1">
        <Clock size={11} strokeWidth={2} className="text-primary" />
      </div>
      <div className="rounded-md border border-border-subtle bg-surface-1/60 p-4">
        <div className="flex items-center gap-3">
          <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">
            turn {checkpoint.turn}
          </span>
          <span className="text-[11.5px] text-dim-soft">
            {formatTimestamp(checkpoint.startedAt)}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-dim-soft">
            <FileText size={11} />
            {checkpoint.fileCount}{' '}
            {checkpoint.fileCount === 1 ? 'arquivo' : 'arquivos'}
          </span>
        </div>
        {truncated && (
          <div className="mt-2 whitespace-pre-wrap text-[12.5px] text-text-soft">
            {truncated}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => onRestore(checkpoint.turn)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft transition-colors hover:bg-warning/15 hover:text-warning"
          >
            <RotateCcw size={12} />
            Restaurar turn {checkpoint.turn}
          </button>
        </div>
      </div>
    </li>
  );
}

// ── Confirmation dialogs ─────────────────────────────────────────────────

interface ConfirmRestoreProps {
  turn: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loading: boolean;
  onConfirm: () => void;
}

function ConfirmRestoreDialog({
  turn,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: ConfirmRestoreProps): React.ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle
              size={16}
              strokeWidth={2}
              className="shrink-0 text-warning"
            />
            <Dialog.Title className="text-[14px] font-semibold text-text">
              Restaurar turn {turn ?? ''}?
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
          <Dialog.Description className="text-[13px] text-text-soft">
            Os arquivos modificados a partir deste turn serão restaurados ao
            estado anterior, e as mensagens posteriores descartadas. A operação
            é destrutiva — apenas o estado atual da sessão é afetado.
          </Dialog.Description>
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
              disabled={loading}
              className="rounded-md bg-warning px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-warning/90 disabled:opacity-60"
            >
              {loading ? 'Restaurando…' : `Restaurar turn ${turn ?? ''}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmClearProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  count: number;
  loading: boolean;
  onConfirm: () => void;
}

function ConfirmClearDialog({
  open,
  onOpenChange,
  count,
  loading,
  onConfirm,
}: ConfirmClearProps): React.ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle
              size={16}
              strokeWidth={2}
              className="shrink-0 text-danger"
            />
            <Dialog.Title className="text-[14px] font-semibold text-text">
              Limpar todos os checkpoints?
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
          <Dialog.Description className="text-[13px] text-text-soft">
            Os {count} checkpoints serão removidos permanentemente. Após isso,
            o rewind dos turns existentes não estará mais disponível.
          </Dialog.Description>
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
              disabled={loading}
              className="rounded-md bg-danger px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-danger/90 disabled:opacity-60"
            >
              {loading ? 'Limpando…' : 'Limpar todos'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return d.toLocaleString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}
