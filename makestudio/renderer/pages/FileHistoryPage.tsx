import React from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  FileClock,
  Search,
  RotateCcw,
  Trash2,
  RefreshCw,
  Inbox,
  AlertTriangle,
  X,
  FileText,
} from 'lucide-react';
import clsx from 'clsx';
import { fileHistoryApi, listProjectFiles } from '../ipc/client';
import type { FileHistoryEntryDTO } from '@shared/types';

export function FileHistoryPage(): React.ReactElement {
  const qc = useQueryClient();
  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = React.useState<{
    index: number;
    timestamp: string;
  } | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<string | null>(null);

  const snapshotsQuery = useQuery<FileHistoryEntryDTO[]>({
    queryKey: ['fileHistory', 'list', filePath],
    queryFn: () => fileHistoryApi.list(filePath ?? ''),
    enabled: !!filePath,
    staleTime: 3_000,
  });

  const restoreMut = useMutation({
    mutationFn: (index: number) =>
      fileHistoryApi.restore(filePath ?? '', index),
    onSuccess: (res) => {
      setConfirmRestore(null);
      qc.invalidateQueries({ queryKey: ['fileHistory'] });
      if (!res.restored) {
        setLastResult(`Erro: ${res.reason ?? 'restore falhou'}`);
      } else if (res.deleted) {
        setLastResult(`Arquivo removido (era criação).`);
      } else {
        setLastResult(`Restaurado de ${res.from ?? 'snapshot'}.`);
      }
      window.setTimeout(() => setLastResult(null), 5000);
    },
  });

  const clearMut = useMutation({
    mutationFn: () => fileHistoryApi.clear(),
    onSuccess: () => {
      setConfirmClear(false);
      qc.invalidateQueries({ queryKey: ['fileHistory'] });
      setLastResult('Histórico de todos os arquivos limpo.');
      window.setTimeout(() => setLastResult(null), 4000);
    },
  });

  const refresh = (): void => {
    qc.invalidateQueries({ queryKey: ['fileHistory'] });
  };

  const snapshots = snapshotsQuery.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">File history</h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            Ring buffer de até 20 snapshots por arquivo · CWD da sessão atual
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
              className={clsx(snapshotsQuery.isLoading && 'animate-spin')}
            />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={clearMut.isPending}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-danger/15 hover:text-danger disabled:opacity-60"
          >
            <Trash2 size={13} />
            Limpar tudo
          </button>
        </div>
      </header>

      <div className="border-b border-border-subtle bg-surface-1/50 px-6 py-3">
        <FilePicker value={filePath} onChange={setFilePath} />
      </div>

      {lastResult && (
        <div className="border-b border-success/30 bg-success/8 px-6 py-2 text-[12.5px] text-success">
          {lastResult}
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 py-4">
        {!filePath && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
            <FileClock size={28} strokeWidth={1.4} />
            <div className="text-center text-[13px]">
              Selecione um arquivo acima pra ver seus snapshots.
            </div>
          </div>
        )}
        {filePath && snapshotsQuery.isError && (
          <div className="rounded-md border border-danger/30 bg-danger/8 px-4 py-3 text-[13px] text-danger">
            Erro ao carregar histórico.
          </div>
        )}
        {filePath &&
          !snapshotsQuery.isLoading &&
          snapshots.length === 0 &&
          !snapshotsQuery.isError && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
              <Inbox size={28} strokeWidth={1.4} />
              <div className="text-center text-[13px]">
                Esse arquivo ainda não tem snapshots.
                <br />
                Snapshots são criados automaticamente antes de cada Edit/Write.
              </div>
            </div>
          )}
        {filePath && snapshots.length > 0 && (
          <SnapshotList
            snapshots={snapshots}
            onRestore={(index, timestamp) =>
              setConfirmRestore({ index, timestamp })
            }
          />
        )}
      </div>

      <ConfirmRestoreDialog
        info={confirmRestore}
        filePath={filePath ?? ''}
        open={confirmRestore !== null}
        onOpenChange={(v) => !v && setConfirmRestore(null)}
        loading={restoreMut.isPending}
        onConfirm={() =>
          confirmRestore !== null && restoreMut.mutate(confirmRestore.index)
        }
      />
      <ConfirmClearDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        loading={clearMut.isPending}
        onConfirm={() => clearMut.mutate()}
      />
    </div>
  );
}

// ── File picker (com fuzzy completion) ───────────────────────────────────

interface PickerProps {
  value: string | null;
  onChange: (path: string | null) => void;
}

function FilePicker({ value, onChange }: PickerProps): React.ReactElement {
  const [query, setQuery] = React.useState(value ?? '');
  const [results, setResults] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(0);

  React.useEffect(() => {
    setQuery(value ?? '');
  }, [value]);

  const fetchResults = React.useCallback(async (q: string) => {
    if (!q || q.length < 1) {
      setResults([]);
      return;
    }
    try {
      const list = await listProjectFiles(q, 20);
      setResults(list);
      setActiveIdx(0);
    } catch {
      setResults([]);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => fetchResults(query), 150);
    return () => window.clearTimeout(t);
  }, [query, open, fetchResults]);

  const accept = (path: string): void => {
    onChange(path);
    setQuery(path);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Search
        size={13}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim"
      />
      <input
        type="text"
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (!e.target.value) onChange(null);
        }}
        onKeyDown={(e) => {
          if (!open || results.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => (i + 1) % results.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => (i - 1 + results.length) % results.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            accept(results[activeIdx] ?? results[0]);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
          }
        }}
        placeholder="Buscar arquivo do projeto…"
        className="block w-full rounded-md border border-border-subtle bg-surface-2 py-2 pl-9 pr-3 font-mono text-[12.5px] text-text placeholder:text-dim/80 focus:border-primary/50 focus:outline-none"
      />
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-11 z-10 max-h-72 overflow-y-auto rounded-md border border-border-subtle bg-surface-1/95 shadow-elev backdrop-blur">
          {results.map((p, i) => (
            <button
              key={p}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                accept(p);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12.5px]',
                i === activeIdx
                  ? 'bg-surface-3 text-text'
                  : 'text-text-soft hover:bg-surface-2',
              )}
            >
              <FileText size={11} strokeWidth={1.8} className="shrink-0 text-dim" />
              <span className="truncate">{p}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Snapshot list ────────────────────────────────────────────────────────

interface SnapshotListProps {
  snapshots: FileHistoryEntryDTO[];
  onRestore: (index: number, timestamp: string) => void;
}

function SnapshotList({
  snapshots,
  onRestore,
}: SnapshotListProps): React.ReactElement {
  return (
    <ol className="space-y-2">
      {snapshots.map((s, i) => (
        <li
          key={`${s.path}-${s.timestamp}-${i}`}
          className="flex items-center gap-3 rounded-md border border-border-subtle bg-surface-1/60 px-4 py-3"
        >
          <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">
            #{i}
            {i === 0 && <span className="ml-1 text-[9px] uppercase">+ atual</span>}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-text-soft">
              {formatTimestamp(s.timestamp)}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-dim">
              {formatBytes(s.sizeBytes)}
              {s.preview && (
                <span className="ml-2 italic">{truncate(s.preview, 80)}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRestore(i, s.timestamp)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-warning/15 hover:text-warning"
          >
            <RotateCcw size={11} />
            Restaurar
          </button>
        </li>
      ))}
    </ol>
  );
}

// ── Confirmation dialogs ─────────────────────────────────────────────────

interface ConfirmRestoreProps {
  info: { index: number; timestamp: string } | null;
  filePath: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loading: boolean;
  onConfirm: () => void;
}

function ConfirmRestoreDialog({
  info,
  filePath,
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
              Restaurar snapshot #{info?.index ?? ''}?
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
            O arquivo{' '}
            <span className="font-mono text-text">{filePath}</span> será
            sobrescrito com o conteúdo do snapshot capturado em{' '}
            {info && formatTimestamp(info.timestamp)}.
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
              {loading ? 'Restaurando…' : 'Restaurar'}
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
  loading: boolean;
  onConfirm: () => void;
}

function ConfirmClearDialog({
  open,
  onOpenChange,
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
              Limpar todo o histórico de arquivos?
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
            Todos os snapshots de todos os arquivos do CWD atual serão
            removidos. Não dá pra desfazer.
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
              {loading ? 'Limpando…' : 'Limpar tudo'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Utils ────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const d = new Date(t);
  if (diff < 60_000) return 'agora há pouco';
  if (diff < 3_600_000) return `há ${Math.round(diff / 60_000)}min`;
  if (diff < 86_400_000) return `há ${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) {
    return `há ${Math.round(diff / 86_400_000)}d · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
