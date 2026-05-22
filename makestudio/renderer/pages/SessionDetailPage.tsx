import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  GitBranch,
  Download,
  Trash2,
  User,
  Sparkles,
  Plus,
  X,
  AlertTriangle,
  Loader,
} from 'lucide-react';
import clsx from 'clsx';
import { sessionsApi, type SessionMessage } from '../ipc/client';
import { Markdown } from '../components/chat/Markdown';
import type { SessionSummaryDTO } from '@shared/types';

export function SessionDetailPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const sessionQuery = useQuery({
    queryKey: ['sessions', 'open', id],
    queryFn: () => sessionsApi.open(id ?? ''),
    enabled: !!id,
    staleTime: 10_000,
  });

  const summary = sessionQuery.data?.summary;
  const messages = sessionQuery.data?.messages ?? [];
  const file = sessionQuery.data?.file;

  if (!id) {
    return (
      <div className="flex h-full items-center justify-center text-dim-soft">
        ID de sessão ausente.
      </div>
    );
  }

  if (sessionQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-dim-soft">
        <Loader size={14} className="animate-spin" />
        Carregando sessão…
      </div>
    );
  }

  if (sessionQuery.isError || sessionQuery.data?.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-dim-soft">
        <AlertTriangle size={28} className="text-danger" />
        <div className="text-[13px]">
          Sessão não encontrada ou erro ao carregar.
        </div>
        <button
          type="button"
          onClick={() => navigate('/sessions')}
          className="text-[12.5px] text-primary hover:underline"
        >
          ← voltar pra lista
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SessionHeader
        summary={summary}
        sessionId={id}
        file={file}
        onChange={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
        onAfterFork={(newId) => navigate(`/sessions/${newId}`)}
        onAfterDelete={() => navigate('/sessions')}
      />

      <SessionMeta
        summary={summary}
        file={file}
        onChange={() =>
          qc.invalidateQueries({ queryKey: ['sessions', 'open', id] })
        }
      />

      <div className="flex-1 overflow-auto">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-dim-soft">
            Sessão sem mensagens.
          </div>
        ) : (
          <Transcript messages={messages} />
        )}
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────

interface HeaderProps {
  summary: SessionSummaryDTO | undefined;
  sessionId: string;
  file: string | undefined;
  onChange: () => void;
  onAfterFork: (newId: string) => void;
  onAfterDelete: () => void;
}

function SessionHeader({
  summary,
  sessionId,
  file,
  onChange,
  onAfterFork,
  onAfterDelete,
}: HeaderProps): React.ReactElement {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const forkMut = useMutation({
    mutationFn: () => sessionsApi.fork(summary?.title),
    onSuccess: (res) => {
      onChange();
      if (res.ok && res.sessionId) onAfterFork(res.sessionId);
    },
  });

  const exportMut = useMutation({
    mutationFn: (format: 'md' | 'json') =>
      sessionsApi.export(file ?? '', format),
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

  const deleteMut = useMutation({
    mutationFn: () => sessionsApi.delete(file ?? ''),
    onSuccess: () => {
      setConfirmDelete(false);
      onChange();
      onAfterDelete();
    },
  });

  return (
    <header className="flex items-center gap-3 border-b border-border-subtle px-6 py-4">
      <button
        type="button"
        onClick={() => navigate('/sessions')}
        title="Voltar"
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border-subtle bg-surface-2 text-dim-soft hover:bg-surface-3 hover:text-text"
      >
        <ArrowLeft size={14} strokeWidth={2} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-semibold text-text">
          {summary?.title ?? (
            <span className="font-mono text-dim">{sessionId.slice(0, 8)}</span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[11.5px] text-dim/80">
          {file ?? sessionId}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => forkMut.mutate()}
          disabled={forkMut.isPending}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
        >
          <GitBranch size={13} />
          Fork
        </button>
        <ExportMenu
          onExport={(fmt) => exportMut.mutate(fmt)}
          loading={exportMut.isPending}
        />
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          title="Apagar sessão"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border-subtle bg-surface-2 text-dim hover:bg-danger/15 hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
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
                Apagar esta sessão?
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
              Removerá o JSONL permanentemente. Não dá pra desfazer.
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
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="rounded-md bg-danger px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-danger/90 disabled:opacity-60"
              >
                {deleteMut.isPending ? 'Apagando…' : 'Apagar'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}

interface ExportMenuProps {
  onExport: (format: 'md' | 'json') => void;
  loading: boolean;
}

function ExportMenu({
  onExport,
  loading,
}: ExportMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const handler = (): void => setOpen(false);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [open]);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        disabled={loading}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
      >
        <Download size={13} />
        Export
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-10 min-w-[160px] overflow-hidden rounded-md border border-border-subtle bg-surface-1 shadow-elev">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onExport('md');
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-text-soft hover:bg-surface-2"
          >
            <Download size={11} />
            Markdown (.md)
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onExport('json');
            }}
            className="flex w-full items-center gap-2 border-t border-border-subtle/60 px-3 py-2 text-left text-[12.5px] text-text-soft hover:bg-surface-2"
          >
            <Download size={11} />
            JSON (.json)
          </button>
        </div>
      )}
    </div>
  );
}

// ── Metadata block (title/tags inline-edit) ──────────────────────────────

interface MetaProps {
  summary: SessionSummaryDTO | undefined;
  file: string | undefined;
  onChange: () => void;
}

function SessionMeta({
  summary,
  file,
  onChange,
}: MetaProps): React.ReactElement | null {
  const [titleDraft, setTitleDraft] = React.useState(summary?.title ?? '');
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [tags, setTags] = React.useState<string[]>(summary?.tags ?? []);
  const [tagInput, setTagInput] = React.useState('');

  // Sincroniza estado com summary quando carrega
  React.useEffect(() => {
    setTitleDraft(summary?.title ?? '');
    setTags(summary?.tags ?? []);
  }, [summary?.title, summary?.tags]);

  const renameMut = useMutation({
    mutationFn: (title: string) => sessionsApi.rename(file ?? '', title),
    onSuccess: () => {
      setEditingTitle(false);
      onChange();
    },
  });

  const tagMut = useMutation({
    mutationFn: (newTags: string[]) => sessionsApi.tag(file ?? '', newTags),
    onSuccess: () => onChange(),
  });

  if (!file) return null;

  const addTag = (raw: string): void => {
    const t = raw.trim().replace(/^#/, '');
    if (!t || tags.includes(t)) return;
    const next = [...tags, t];
    setTags(next);
    tagMut.mutate(next);
    setTagInput('');
  };

  const removeTag = (t: string): void => {
    const next = tags.filter((x) => x !== t);
    setTags(next);
    tagMut.mutate(next);
  };

  return (
    <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 border-b border-border-subtle bg-surface-1/50 px-6 py-3 text-[12.5px]">
      <div className="text-[11px] uppercase tracking-[0.1em] text-dim/80">
        Título
      </div>
      <div>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              if (titleDraft !== (summary?.title ?? '')) {
                renameMut.mutate(titleDraft);
              } else {
                setEditingTitle(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setTitleDraft(summary?.title ?? '');
                setEditingTitle(false);
              }
            }}
            className="w-full rounded border border-primary/40 bg-surface-2 px-2 py-1 text-text focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            className="rounded px-2 py-1 text-left text-text hover:bg-surface-2"
          >
            {summary?.title || (
              <span className="italic text-dim">— sem título (clique pra editar)</span>
            )}
          </button>
        )}
      </div>

      <div className="text-[11px] uppercase tracking-[0.1em] text-dim/80">Tags</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-secondary/15 px-2 py-0.5 text-[10.5px] font-medium text-secondary"
          >
            #{t}
            <button
              type="button"
              onClick={() => removeTag(t)}
              className="rounded-full text-secondary/70 hover:text-secondary"
            >
              <X size={9} strokeWidth={2.4} />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addTag(tagInput);
            } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
              removeTag(tags[tags.length - 1]);
            }
          }}
          placeholder="+ tag"
          className="w-[100px] rounded bg-transparent px-1 text-[11.5px] text-text placeholder:text-dim/60 focus:outline-none"
        />
      </div>

      {summary?.summary && (
        <>
          <div className="text-[11px] uppercase tracking-[0.1em] text-dim/80">
            Summary
          </div>
          <div className="text-text-soft">{summary.summary}</div>
        </>
      )}

      <div className="text-[11px] uppercase tracking-[0.1em] text-dim/80">CWD</div>
      <div className="font-mono text-[11.5px] text-dim-soft">
        {summary?.cwd ?? '—'}
      </div>
    </div>
  );
}

// ── Transcript ───────────────────────────────────────────────────────────

interface TranscriptProps {
  messages: SessionMessage[];
}

function Transcript({ messages }: TranscriptProps): React.ReactElement {
  return (
    <div className="mx-auto max-w-4xl px-6 py-4">
      {messages.map((m, i) => (
        <SessionMessageItem key={i} message={m} />
      ))}
    </div>
  );
}

function SessionMessageItem({
  message,
}: {
  message: SessionMessage;
}): React.ReactElement {
  if (message.role === 'user') {
    return (
      <div className="flex gap-3 px-1 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface-2 text-dim">
          <User size={13} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5 whitespace-pre-wrap text-[14px] leading-relaxed text-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 px-1 py-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-blue text-text shadow-[0_0_20px_-6px_rgba(46,125,215,0.6)]">
        <Sparkles size={13} strokeWidth={2.5} />
      </div>
      <div className="min-w-0 flex-1">
        <Markdown text={message.content || ''} />
      </div>
    </div>
  );
}
