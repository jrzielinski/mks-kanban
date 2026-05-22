import React from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Search,
  RefreshCw,
  Database,
  Plus,
  Trash2,
  Download,
  Upload,
  Sparkles,
  Wifi,
  WifiOff,
  Inbox,
  AlertTriangle,
  X,
  Save,
  Info,
  Lightbulb,
} from 'lucide-react';
import clsx from 'clsx';
import { memoryApi, type MemoryTopicFullDTO } from '../ipc/client';
import { Markdown } from '../components/chat/Markdown';
import type { MemoryTopicDTO, MemoryType } from '@shared/types';

type TypeFilter = 'all' | MemoryType;

const TYPE_LABEL: Record<MemoryType, string> = {
  user: 'USER',
  feedback: 'FB',
  project: 'PROJ',
  reference: 'REF',
};
const TYPE_COLOR: Record<MemoryType, string> = {
  user: 'bg-primary/15 text-primary',
  feedback: 'bg-warning/15 text-warning',
  project: 'bg-secondary/15 text-secondary',
  reference: 'bg-success/15 text-success',
};

/** Descrição curta de cada tipo, exibida no editor pro usuário entender. */
const TYPE_DESCRIPTION: Record<MemoryType, string> = {
  user:
    'Quem é o usuário — função, objetivos, conhecimento, preferências de trabalho.',
  feedback:
    'Correções e validações sobre como agir — coisas que o usuário pediu pra fazer ou parar de fazer.',
  project:
    'Contexto do trabalho atual — quem faz o quê, deadlines, decisões e motivações que não estão no código.',
  reference:
    'Onde achar coisas em sistemas externos — dashboards, projetos no Linear, canais do Slack, etc.',
};

/** Tooltips dos labels do formulário do editor. */
const FIELD_HELP: Record<string, string> = {
  name:
    'Identificador único da memória. Letras, números, _ ou - (até 80 chars). Não muda depois de criada.',
  type:
    'Categoria semântica da memória. Influencia quando o agente vai recuperar esse tópico em conversas futuras.',
  description:
    'Resumo de 1 linha. É o que o agente lê primeiro pra decidir se a memória é relevante — seja específico.',
  tags:
    'Palavras-chave pra busca e filtragem. Enter ou vírgula adiciona; Backspace remove o último.',
  body:
    'Conteúdo principal em markdown. Para feedback/project, comece com a regra/fato e inclua **Why:** e **How to apply:**.',
};

export function MemoryPage(): React.ReactElement {
  const qc = useQueryClient();
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all');
  const [editing, setEditing] = React.useState<{
    name?: string;
    isNew: boolean;
  } | null>(null);

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const listQuery = useQuery<MemoryTopicDTO[]>({
    queryKey: ['memory', 'list'],
    queryFn: () => memoryApi.list(),
    staleTime: 5_000,
  });

  const syncQuery = useQuery({
    queryKey: ['memory', 'sync'],
    queryFn: () => memoryApi.syncStatus(),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const rebuildMut = useMutation({
    mutationFn: () => memoryApi.rebuild(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  });

  const refresh = (): void => {
    qc.invalidateQueries({ queryKey: ['memory'] });
  };

  const topics = listQuery.data ?? [];

  const filtered = React.useMemo(() => {
    return topics.filter((t) => {
      if (typeFilter !== 'all' && (t.type ?? 'user') !== typeFilter) return false;
      if (!debouncedQuery) return true;
      const hay = (
        t.name +
        ' ' +
        (t.description ?? '') +
        ' ' +
        (t.preview ?? '') +
        ' ' +
        (t.tags ?? []).join(' ')
      ).toLowerCase();
      return hay.includes(debouncedQuery);
    });
  }, [topics, debouncedQuery, typeFilter]);

  // Export — download JSON
  const handleExport = async (): Promise<void> => {
    const list = listQuery.data ?? [];
    const fulls = await Promise.all(
      list.map((t) => memoryApi.get(t.name).then((r) => r.topic).catch(() => null)),
    );
    const payload = fulls.filter(Boolean);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Memória</h1>
            <p className="mt-0.5 text-[12.5px] text-dim-soft">
              {filtered.length}{' '}
              {filtered.length === 1 ? 'tópico' : 'tópicos'}
              {topics.length !== filtered.length && (
                <span> · {topics.length} totais</span>
              )}
            </p>
          </div>
          <SyncBadge data={syncQuery.data} />
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
            onClick={() => rebuildMut.mutate()}
            disabled={rebuildMut.isPending}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
            title="Regenera MEMORY.md (índice)"
          >
            <Sparkles size={13} />
            {rebuildMut.isPending ? 'Rebuilding…' : 'Rebuild'}
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3"
            title="Exportar tudo como JSON"
          >
            <Download size={13} />
            Export
          </button>
          <button
            type="button"
            onClick={() => setEditing({ isNew: true })}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft"
          >
            <Plus size={13} />
            Nova
          </button>
        </div>
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
            placeholder="Buscar por nome, descrição ou tag…"
            className="block w-full rounded-md border border-border-subtle bg-surface-2 py-2 pl-9 pr-3 text-[13px] text-text placeholder:text-dim/80 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <TypeFilterTabs value={typeFilter} onChange={setTypeFilter} />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {listQuery.isError && (
          <div className="rounded-md border border-danger/30 bg-danger/8 px-4 py-3 text-[13px] text-danger">
            Erro ao carregar memórias.
          </div>
        )}
        {!listQuery.isError &&
          filtered.length === 0 &&
          !listQuery.isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-subtle py-16 text-dim-soft">
              <Database size={28} strokeWidth={1.4} />
              <div className="text-center text-[13px]">
                {debouncedQuery || typeFilter !== 'all'
                  ? 'Nenhum tópico bate com o filtro.'
                  : 'Sem memórias ainda. Crie uma com + Nova.'}
              </div>
            </div>
          )}
        {filtered.length > 0 && (
          <MemoryList
            topics={filtered}
            onOpen={(name) => setEditing({ name, isNew: false })}
          />
        )}
      </div>

      {/* Edit modal */}
      {editing && (
        <EditMemoryModal
          name={editing.isNew ? null : (editing.name ?? null)}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['memory'] });
            setEditing(null);
          }}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ['memory'] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ── SyncBadge ────────────────────────────────────────────────────────────

interface SyncBadgeProps {
  data?: { peerId: string; peers: number; lastSync: string | null; conflicts: number };
}

function SyncBadge({ data }: SyncBadgeProps): React.ReactElement {
  if (!data) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-2 py-0.5 text-[10.5px] text-dim">
        <WifiOff size={10} /> sem dados
      </span>
    );
  }
  if (data.conflicts > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/8 px-2 py-0.5 text-[10.5px] font-medium text-warning">
        <AlertTriangle size={10} /> {data.conflicts} conflito
        {data.conflicts === 1 ? '' : 's'}
      </span>
    );
  }
  if (data.peers === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-2 py-0.5 text-[10.5px] text-dim"
        title={`peerId ${data.peerId}`}
      >
        <WifiOff size={10} /> Local
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/8 px-2 py-0.5 text-[10.5px] font-medium text-success"
      title={`peerId ${data.peerId}`}
    >
      <Wifi size={10} /> {data.peers} peer{data.peers === 1 ? '' : 's'}
    </span>
  );
}

// ── Type filter tabs ─────────────────────────────────────────────────────

function TypeFilterTabs({
  value,
  onChange,
}: {
  value: TypeFilter;
  onChange: (v: TypeFilter) => void;
}): React.ReactElement {
  const items: { key: TypeFilter; label: string }[] = [
    { key: 'all', label: 'Todos' },
    { key: 'user', label: 'User' },
    { key: 'feedback', label: 'Feedback' },
    { key: 'project', label: 'Project' },
    { key: 'reference', label: 'Reference' },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border-subtle bg-surface-2 text-[12px]">
      {items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={clsx(
            'px-3 py-2 transition-colors',
            i > 0 && 'border-l border-border-subtle',
            value === it.key
              ? 'bg-surface-3 text-text'
              : 'text-text-soft hover:bg-surface-3/60',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ── Lista ────────────────────────────────────────────────────────────────

interface ListProps {
  topics: MemoryTopicDTO[];
  onOpen: (name: string) => void;
}

/**
 * Limpa ruído do preview: remove o bloco YAML frontmatter (--- ... ---) e
 * linhas pseudo-yaml soltas (name:, description:, type:, autoExtracted:)
 * que vazam quando o body começa com frontmatter inline. Devolve a primeira
 * frase real do conteúdo.
 */
function sanitizePreview(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  // Frontmatter fenced YAML no início.
  out = out.replace(/^---[\s\S]*?---\s*/m, '');
  // Linhas chave-valor de yaml inline residuais (até 5 primeiras linhas).
  out = out
    .split('\n')
    .map((line, i) =>
      i < 5 && /^(name|description|type|autoExtracted|tags):\s/i.test(line.trim())
        ? ''
        : line,
    )
    .join('\n');
  return out.trim();
}

function MemoryList({ topics, onOpen }: ListProps): React.ReactElement {
  return (
    <ul className="flex flex-col gap-2">
      {topics.map((t) => {
        const previewText = t.description || sanitizePreview(t.preview);
        const tags = t.tags ?? [];
        return (
          <li key={t.name}>
            <button
              type="button"
              onClick={() => onOpen(t.name)}
              className="group flex w-full flex-col gap-2 rounded-lg border border-border-subtle bg-surface-1/40 px-4 py-3.5 text-left transition-colors hover:border-border-soft hover:bg-surface-2/40"
            >
              {/* Linha 1: tipo + nome + meta à direita */}
              <div className="flex items-center gap-2.5">
                <TypeBadge type={t.type ?? 'user'} />
                <span className="font-mono text-[13px] font-medium text-text">
                  {t.name}
                </span>
                <div className="ml-auto flex items-center gap-3 text-[11px] text-dim-soft">
                  <span
                    className="font-mono"
                    title={`${t.accessCount} ${t.accessCount === 1 ? 'acesso' : 'acessos'}`}
                  >
                    {t.accessCount}×
                  </span>
                  <span aria-hidden="true" className="text-dim/40">·</span>
                  <span>
                    {t.lastAccessedAt ? relativeTime(t.lastAccessedAt) : '—'}
                  </span>
                </div>
              </div>

              {/* Linha 2: descrição/preview limpo */}
              {previewText && (
                <p className="line-clamp-2 pl-[3px] text-[12.5px] leading-relaxed text-text-soft">
                  {previewText}
                </p>
              )}

              {/* Linha 3: tags (só se houver) */}
              {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 pl-[3px]">
                  {tags.slice(0, 6).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center rounded-full bg-secondary/12 px-2 py-0.5 text-[10.5px] font-medium text-secondary/90"
                    >
                      #{tag}
                    </span>
                  ))}
                  {tags.length > 6 && (
                    <span className="text-[10.5px] text-dim">
                      +{tags.length - 6}
                    </span>
                  )}
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Label de campo do editor com ícone de help — tooltip nativo (`title=`)
 * mostra a explicação em hover. Mantido leve pra não quebrar o grid compacto.
 */
function FieldLabel({
  label,
  help,
}: {
  label: string;
  help: string;
}): React.ReactElement {
  return (
    <label
      className="flex cursor-help items-center gap-1 self-center text-[11px] uppercase tracking-[0.1em] text-dim/80"
      title={help}
    >
      {label}
      <Info size={10} className="text-dim/50" strokeWidth={2} />
    </label>
  );
}

function TypeBadge({ type }: { type: MemoryType }): React.ReactElement {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold',
        TYPE_COLOR[type],
      )}
    >
      {TYPE_LABEL[type]}
    </span>
  );
}

// ── Edit modal ───────────────────────────────────────────────────────────

interface EditModalProps {
  name: string | null;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

function EditMemoryModal({
  name,
  isNew,
  onClose,
  onSaved,
  onDeleted,
}: EditModalProps): React.ReactElement {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [loaded, setLoaded] = React.useState<MemoryTopicFullDTO | null>(null);

  // form state
  const [formName, setFormName] = React.useState('');
  const [formType, setFormType] = React.useState<MemoryType>('user');
  const [formDescription, setFormDescription] = React.useState('');
  const [formTags, setFormTags] = React.useState<string[]>([]);
  const [formBody, setFormBody] = React.useState('');
  const [tagInput, setTagInput] = React.useState('');

  // load existing topic
  React.useEffect(() => {
    if (isNew || !name) {
      setLoaded(null);
      setFormName('');
      setFormType('user');
      setFormDescription('');
      setFormTags([]);
      setFormBody('');
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await memoryApi.get(name);
        if (!alive || !res.topic) return;
        setLoaded(res.topic);
        setFormName(res.topic.name);
        setFormType(res.topic.type ?? 'user');
        setFormDescription(res.topic.description ?? '');
        setFormTags(res.topic.tags ?? []);
        setFormBody(res.topic.body);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [name, isNew]);

  const saveMut = useMutation({
    mutationFn: () =>
      memoryApi.save({
        name: formName.trim(),
        body: formBody,
        tags: formTags,
        type: formType,
        description: formDescription.trim() || undefined,
      }),
    onSuccess: (res) => {
      if (res.ok) onSaved();
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => memoryApi.delete(formName),
    onSuccess: () => {
      setConfirmDelete(false);
      onDeleted();
    },
  });

  const validName = /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(formName);
  const canSave = validName && formBody.trim().length > 0 && !saveMut.isPending;

  const addTag = (raw: string): void => {
    const t = raw.trim().replace(/^#/, '');
    if (!t || formTags.includes(t)) return;
    setFormTags([...formTags, t]);
    setTagInput('');
  };

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[80vw] max-w-[1100px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border-subtle bg-surface-1 shadow-elev focus:outline-none">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
            <Database size={14} className="text-primary" />
            <Dialog.Title className="text-[14px] font-semibold text-text">
              {isNew ? 'Nova memória' : `Editar — ${formName || name}`}
            </Dialog.Title>
            {loaded && (
              <span className="text-[11.5px] text-dim">
                · acessada {loaded.accessCount}× · atualizada{' '}
                {relativeTime(loaded.lastAccessedAt)}
              </span>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded text-dim hover:bg-surface-3 hover:text-text"
              >
                <X size={13} />
              </button>
            </Dialog.Close>
          </div>

          {/* Help banner — explica o que é/pra que serve a memória */}
          <div className="flex items-start gap-2 border-b border-border-subtle bg-primary/[0.04] px-5 py-2.5 text-[11.5px] leading-relaxed text-text-soft">
            <Lightbulb
              size={12}
              className="mt-0.5 shrink-0 text-primary"
              strokeWidth={2}
            />
            <p>
              <span className="font-medium text-text">Memórias</span> são fatos
              persistentes que o agente recupera em conversas futuras. Use pra
              registrar quem você é, preferências de trabalho, contexto de
              projetos e onde encontrar recursos externos. Cada memória vira um
              arquivo markdown indexado em <span className="font-mono text-dim-soft">MEMORY.md</span>.
            </p>
          </div>

          {/* Form metadata */}
          <div className="grid grid-cols-[140px_1fr_140px_1fr] gap-x-3 gap-y-2 border-b border-border-subtle bg-surface-1/50 px-5 py-3 text-[12.5px]">
            <FieldLabel label="Nome" help={FIELD_HELP.name} />
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={!isNew}
              className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-text disabled:opacity-60 focus:border-primary/50 focus:outline-none"
            />
            <FieldLabel label="Tipo" help={FIELD_HELP.type} />
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value as MemoryType)}
              className="rounded border border-border-subtle bg-surface-2 px-2 py-1 text-text focus:border-primary/50 focus:outline-none"
            >
              <option value="user">user</option>
              <option value="feedback">feedback</option>
              <option value="project">project</option>
              <option value="reference">reference</option>
            </select>

            {/* Descritor dinâmico do tipo escolhido — ocupa as 4 colunas */}
            <div className="col-span-4 -mt-1 flex items-start gap-1.5 rounded border border-border-subtle/40 bg-surface-2/40 px-2.5 py-1.5 text-[11px] leading-snug text-dim-soft">
              <Info size={11} className="mt-0.5 shrink-0 text-dim" />
              <span>
                <span className="font-mono font-medium text-text-soft">
                  {formType}
                </span>{' '}
                — {TYPE_DESCRIPTION[formType]}
              </span>
            </div>

            <FieldLabel label="Descrição" help={FIELD_HELP.description} />
            <input
              type="text"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="(opcional, 1 linha)"
              className="col-span-3 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-text placeholder:text-dim focus:border-primary/50 focus:outline-none"
            />

            <FieldLabel label="Tags" help={FIELD_HELP.tags} />
            <div className="col-span-3 flex flex-wrap items-center gap-1.5 rounded border border-border-subtle bg-surface-2 px-2 py-1">
              {formTags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary/15 px-2 py-0.5 text-[10.5px] font-medium text-secondary"
                >
                  #{t}
                  <button
                    type="button"
                    onClick={() =>
                      setFormTags(formTags.filter((x) => x !== t))
                    }
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
                  } else if (
                    e.key === 'Backspace' &&
                    !tagInput &&
                    formTags.length > 0
                  ) {
                    setFormTags(formTags.slice(0, -1));
                  }
                }}
                placeholder="+ tag"
                className="flex-1 min-w-[100px] bg-transparent text-[11.5px] text-text placeholder:text-dim/60 focus:outline-none"
              />
            </div>
          </div>

          {/* Body editor + preview side-by-side */}
          <div className="grid flex-1 grid-cols-2 overflow-hidden">
            <div className="flex flex-col border-r border-border-subtle">
              <div
                className="flex items-center gap-1 border-b border-border-subtle bg-surface-2/60 px-3 py-1.5 text-[10.5px] uppercase tracking-[0.1em] text-dim/80"
                title={FIELD_HELP.body}
              >
                Body (markdown)
                <Info size={11} className="text-dim/60" strokeWidth={2} />
              </div>
              <textarea
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                placeholder="# Tópico&#10;&#10;Conteúdo da memória em markdown…"
                className="flex-1 resize-none bg-transparent p-4 font-mono text-[12.5px] leading-relaxed text-text placeholder:text-dim focus:outline-none"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col">
              <div className="border-b border-border-subtle bg-surface-2/60 px-3 py-1.5 text-[10.5px] uppercase tracking-[0.1em] text-dim/80">
                Preview
              </div>
              <div className="flex-1 overflow-auto p-4">
                {formBody.trim() ? (
                  <Markdown text={formBody} />
                ) : (
                  <span className="italic text-dim">
                    Preview aparece quando há conteúdo.
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
            {!isNew && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-dim hover:bg-danger/15 hover:text-danger"
              >
                <Trash2 size={12} />
                Apagar
              </button>
            )}
            {!validName && formName.length > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-warning">
                <AlertTriangle size={11} />
                Use letras, números, _ ou - (até 80 chars).
              </span>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                className="ml-auto rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12.5px] text-text-soft hover:bg-surface-3"
              >
                Cancelar
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => saveMut.mutate()}
              disabled={!canSave}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save size={12} />
              {saveMut.isPending ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {/* Confirm delete sub-dialog */}
      <Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle
                size={16}
                strokeWidth={2}
                className="shrink-0 text-danger"
              />
              <Dialog.Title className="text-[14px] font-semibold text-text">
                Apagar memória?
              </Dialog.Title>
            </div>
            <Dialog.Description className="text-[13px] text-text-soft">
              <span className="font-mono text-text">{formName}</span> será
              marcada como tombstone. A deleção propaga pra peers do cluster
              (se houver) na próxima sincronização.
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
    </Dialog.Root>
  );
}

// ── Utils ────────────────────────────────────────────────────────────────

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
