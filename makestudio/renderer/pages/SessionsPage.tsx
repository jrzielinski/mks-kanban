import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Search,
  RefreshCw,
  Trash2,
  GitBranch,
  Pencil,
  Download,
  Inbox,
  AlertTriangle,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { sessionsApi } from '../ipc/client';
import type { SessionSummaryDTO } from '@shared/types';

type SearchMode = 'literal' | 'semantic';

export function SessionsPage(): React.ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [mode, setMode] = React.useState<SearchMode>('literal');
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);

  // debounce do query (300ms)
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const listQuery = useQuery<SessionSummaryDTO[]>({
    queryKey: ['sessions', 'list'],
    queryFn: () => sessionsApi.list(),
    staleTime: 5_000,
  });

  const searchQuery = useQuery<SessionSummaryDTO[]>({
    queryKey: ['sessions', 'search', debouncedQuery, mode],
    queryFn: () => sessionsApi.search(debouncedQuery, mode),
    enabled: debouncedQuery.length > 0,
    staleTime: 5_000,
  });

  const sessions = debouncedQuery
    ? (searchQuery.data ?? [])
    : (listQuery.data ?? []);

  // tags disponíveis (extraídas das sessions)
  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of listQuery.data ?? []) {
      for (const t of s.tags ?? []) set.add(t);
    }
    return Array.from(set).sort();
  }, [listQuery.data]);

  const filtered = React.useMemo(() => {
    if (!tagFilter) return sessions;
    return sessions.filter((s) => (s.tags ?? []).includes(tagFilter));
  }, [sessions, tagFilter]);

  const isLoading = debouncedQuery ? searchQuery.isLoading : listQuery.isLoading;
  const isError = debouncedQuery ? searchQuery.isError : listQuery.isError;

  const refresh = (): void => {
    qc.invalidateQueries({ queryKey: ['sessions'] });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">Sessões</h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            {filtered.length} {filtered.length === 1 ? 'sessão' : 'sessões'}
            {tagFilter && (
              <span className="ml-2">
                · filtro <span className="text-primary">#{tagFilter}</span>
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft transition-colors hover:bg-surface-3"
        >
          <RefreshCw size={13} className={clsx(isLoading && 'animate-spin')} />
          Atualizar
        </button>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-1/50 px-6 py-3">
        <div className="relative flex-1 min-w-[280px]">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por título, summary ou tag…"
            className="block w-full rounded-md border border-border-subtle bg-surface-2 py-2 pl-9 pr-3 text-[13px] text-text placeholder:text-dim/80 focus:border-primary/50 focus:outline-none"
          />
        </div>

        <div className="inline-flex overflow-hidden rounded-md border border-border-subtle bg-surface-2 text-[12px]">
          <button
            type="button"
            onClick={() => setMode('literal')}
            className={clsx(
              'px-3 py-2 transition-colors',
              mode === 'literal'
                ? 'bg-surface-3 text-text'
                : 'text-text-soft hover:bg-surface-3/60',
            )}
          >
            Literal
          </button>
          <button
            type="button"
            onClick={() => setMode('semantic')}
            className={clsx(
              'border-l border-border-subtle px-3 py-2 transition-colors',
              mode === 'semantic'
                ? 'bg-surface-3 text-text'
                : 'text-text-soft hover:bg-surface-3/60',
            )}
          >
            Semântica
          </button>
        </div>

        {allTags.length > 0 && (
          <select
            value={tagFilter ?? ''}
            onChange={(e) => setTagFilter(e.target.value || null)}
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-[12.5px] text-text-soft focus:border-primary/50 focus:outline-none"
          >
            <option value="">Todas as tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {isError && (
          <div className="rounded-md border border-danger/30 bg-danger/8 px-4 py-3 text-[13px] text-danger">
            Erro ao carregar sessões. Verifique se o agent está rodando.
          </div>
        )}
        {!isError && filtered.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
            <Inbox size={28} strokeWidth={1.4} />
            <div className="text-[13px]">
              {debouncedQuery
                ? `Nenhum match para "${debouncedQuery}".`
                : 'Nenhuma sessão ainda. Comece um chat na home.'}
            </div>
          </div>
        )}
        {filtered.length > 0 && (
          <SessionsTable
            sessions={filtered}
            onOpen={(s) => navigate(`/sessions/${s.sessionId}`)}
            onChange={refresh}
          />
        )}
      </div>
    </div>
  );
}

// ── Tabela ───────────────────────────────────────────────────────────────

interface TableProps {
  sessions: SessionSummaryDTO[];
  onOpen: (s: SessionSummaryDTO) => void;
  onChange: () => void;
}

function SessionsTable({
  sessions,
  onOpen,
  onChange,
}: TableProps): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-1/40">
      <table className="w-full text-left text-[12.5px]">
        <thead className="border-b border-border-subtle bg-surface-2/60 text-[10.5px] uppercase tracking-[0.1em] text-dim/80">
          <tr>
            <th className="px-4 py-2 font-medium">Título</th>
            <th className="px-4 py-2 font-medium">CWD</th>
            <th className="px-4 py-2 font-medium">Tags</th>
            <th className="px-4 py-2 text-right font-medium">Msgs</th>
            <th className="px-4 py-2 font-medium">Atualização</th>
            <th className="w-[1%] px-4 py-2 font-medium">Ações</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              onOpen={onOpen}
              onChange={onChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  session: SessionSummaryDTO;
  onOpen: (s: SessionSummaryDTO) => void;
  onChange: () => void;
}

function SessionRow({
  session,
  onOpen,
  onChange,
}: RowProps): React.ReactElement {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(session.title ?? '');

  const renameMut = useMutation({
    mutationFn: (title: string) => sessionsApi.rename(session.file, title),
    onSuccess: () => {
      setRenaming(false);
      onChange();
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => sessionsApi.delete(session.file),
    onSuccess: () => {
      setConfirmDelete(false);
      onChange();
    },
  });

  const exportMut = useMutation({
    mutationFn: (format: 'md' | 'json') =>
      sessionsApi.export(session.file, format),
    onSuccess: (data) => {
      if (!data.content) return;
      const blob = new Blob([data.content], {
        type: data.filename.endsWith('.json')
          ? 'application/json'
          : 'text/markdown',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });

  const forkMut = useMutation({
    mutationFn: () => sessionsApi.fork(),
    onSuccess: () => onChange(),
  });

  const handleRowClick = (e: React.MouseEvent): void => {
    if (renaming) return;
    if (
      (e.target as HTMLElement).closest(
        'button, input, select, a, [data-stop]',
      )
    )
      return;
    onOpen(session);
  };

  const updatedRel = relativeTime(session.lastUpdatedAt);
  const cwdShort = shortenCwd(session.cwd);

  return (
    <tr
      onClick={handleRowClick}
      className="cursor-pointer border-b border-border-subtle/60 transition-colors last:border-0 hover:bg-surface-2/40"
    >
      <td className="px-4 py-2.5">
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => {
              if (renameValue !== (session.title ?? '')) {
                renameMut.mutate(renameValue);
              } else {
                setRenaming(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setRenameValue(session.title ?? '');
                setRenaming(false);
              }
            }}
            className="w-full rounded border border-primary/40 bg-surface-2 px-2 py-1 text-[12.5px] text-text focus:outline-none"
            data-stop
          />
        ) : (
          <div className="font-medium text-text">
            {session.title ?? (
              <span className="font-mono text-dim">
                {session.sessionId.slice(0, 8)}
              </span>
            )}
          </div>
        )}
        {session.summary && (
          <div className="mt-0.5 line-clamp-1 text-[11.5px] text-dim-soft">
            {session.summary}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5">
        <span className="font-mono text-[11.5px] text-dim-soft">{cwdShort}</span>
      </td>
      <td className="px-4 py-2.5">
        {session.tags && session.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {session.tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded-full bg-secondary/15 px-2 py-0.5 text-[10.5px] font-medium text-secondary"
              >
                #{t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-dim/60">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-dim-soft">
        {session.messageCount}
      </td>
      <td className="px-4 py-2.5 text-dim-soft">{updatedRel}</td>
      <td className="px-4 py-2.5" data-stop>
        <div className="flex items-center justify-end gap-0.5">
          <RowAction
            icon={Pencil}
            label="Renomear"
            onClick={() => {
              setRenameValue(session.title ?? '');
              setRenaming(true);
            }}
          />
          <RowAction
            icon={GitBranch}
            label="Fork"
            disabled={forkMut.isPending}
            onClick={() => forkMut.mutate()}
          />
          <RowAction
            icon={Download}
            label="Exportar markdown"
            onClick={() => exportMut.mutate('md')}
            disabled={exportMut.isPending}
          />
          <RowAction
            icon={Trash2}
            label="Apagar"
            tone="danger"
            onClick={() => setConfirmDelete(true)}
          />
        </div>
        <ConfirmDeleteDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={session.title ?? session.sessionId}
          loading={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate()}
        />
      </td>
    </tr>
  );
}

// ── Helpers visuais ──────────────────────────────────────────────────────

interface RowActionProps {
  icon: React.ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

function RowAction({
  icon: Icon,
  label,
  onClick,
  tone = 'default',
  disabled,
}: RowActionProps): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex h-7 w-7 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'danger'
          ? 'text-dim hover:bg-danger/15 hover:text-danger'
          : 'text-dim hover:bg-surface-3 hover:text-text',
      )}
    >
      <Icon size={13} strokeWidth={1.8} />
    </button>
  );
}

interface ConfirmProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  loading: boolean;
  onConfirm: () => void;
}

function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  loading,
  onConfirm,
}: ConfirmProps): React.ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle
              size={16}
              strokeWidth={2}
              className="shrink-0 text-danger"
            />
            <Dialog.Title className="text-[14px] font-semibold text-text">
              Apagar sessão?
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
            Esta ação remove permanentemente o arquivo da sessão{' '}
            <span className="font-mono text-text">"{title}"</span> de
            <span className="font-mono text-dim"> ~/.makestudio/sessions/</span>
            . Não dá pra desfazer.
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
              {loading ? 'Apagando…' : 'Apagar'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Utils ───────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `há ${Math.round(diff / 60_000)}min`;
  if (diff < 86_400_000) return `há ${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `há ${Math.round(diff / 86_400_000)}d`;
  if (diff < 30 * 86_400_000)
    return `há ${Math.round(diff / (7 * 86_400_000))}sem`;
  return new Date(t).toLocaleDateString('pt-BR');
}

function shortenCwd(cwd: string): string {
  if (!cwd) return '—';
  const home =
    typeof process !== 'undefined' && process.env?.HOME ? process.env.HOME : '';
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  if (cwd.length > 36) return '…' + cwd.slice(-33);
  return cwd;
}
