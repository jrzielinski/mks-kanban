import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Webhook,
  Save,
  X,
  Play,
  Pencil,
  Info,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  AlertTriangle,
  Lightbulb,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { hooksApi } from '../ipc/client';
import type { HookDTO, HookEventDTO, HookTypeDTO, HookTestResultDTO } from '@shared/types';

const LIFECYCLE_EVENTS: HookEventDTO[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'Stop',
  'PermissionRequest',
  'Setup',
];

const LEGACY_EVENTS: HookEventDTO[] = [
  'pre-task', 'post-task',
  'pre-commit', 'post-commit',
  'pre-dum', 'post-dum',
];

/** Label amigável de cada evento — o que mostramos pro usuário em vez do nome técnico. */
const EVENT_LABELS: Record<HookEventDTO, string> = {
  PreToolUse: 'Antes de uma ação',
  PostToolUse: 'Depois de uma ação',
  UserPromptSubmit: 'Quando você envia mensagem',
  SessionStart: 'Ao abrir uma conversa',
  SessionEnd: 'Ao fechar uma conversa',
  PreCompact: 'Antes de resumir histórico',
  PostCompact: 'Depois de resumir histórico',
  Stop: 'Quando o agente termina de responder',
  PermissionRequest: 'Quando o agente pede permissão',
  Setup: 'Na primeira instalação',
  'pre-task': 'Antigo: antes de uma task',
  'post-task': 'Antigo: depois de uma task',
  'pre-commit': 'Antigo: antes de git commit',
  'post-commit': 'Antigo: depois de git commit',
  'pre-dum': 'Antigo: antes do DUM',
  'post-dum': 'Antigo: depois do DUM',
};

/** Descrição com exemplo concreto pra cada evento — pra usuário leigo entender quando usar. */
const EVENT_DESCRIPTIONS: Record<HookEventDTO, string> = {
  PreToolUse:
    'Roda antes do agente usar uma ferramenta (editar arquivo, rodar comando, ler código…). Útil pra bloquear ações perigosas ou registrar tudo o que ele tenta fazer.',
  PostToolUse:
    'Roda depois do agente terminar uma ferramenta. Útil pra rodar testes/lint/format automaticamente após ele editar arquivos.',
  UserPromptSubmit:
    'Roda quando você manda uma mensagem, antes do agente responder. Útil pra adicionar contexto extra ou bloquear certas perguntas.',
  SessionStart:
    'Roda quando você abre uma conversa nova. Útil pra carregar contexto inicial automaticamente.',
  SessionEnd:
    'Roda quando você fecha a conversa. Útil pra salvar logs, fazer backup, ou notificar.',
  PreCompact:
    'Quando a conversa fica longa, o agente resume o histórico antigo pra liberar memória. Esse hook roda antes — útil pra preservar info importante.',
  PostCompact:
    'Roda depois que o histórico é resumido — útil pra logar ou re-injetar contexto.',
  Stop:
    'Roda quando o agente termina de responder. Útil pra notificar via Slack/Telegram, tocar um som, ou rodar checagens finais.',
  PermissionRequest:
    'Roda quando o agente vai pedir permissão pra fazer algo (ex: rodar comando perigoso). Útil pra auto-aprovar/bloquear baseado em regras.',
  Setup:
    'Roda uma única vez quando você instala o sistema. Útil pra configurar dependências ou ambiente.',
  'pre-task':
    'Versão antiga: rodava antes de iniciar uma task. Prefira PreToolUse pra novos hooks.',
  'post-task':
    'Versão antiga: rodava após uma task concluir. Prefira PostToolUse pra novos hooks.',
  'pre-commit':
    'Versão antiga: rodava antes de git commit.',
  'post-commit':
    'Versão antiga: rodava depois de git commit.',
  'pre-dum':
    'Versão antiga: rodava antes do DUM iniciar.',
  'post-dum':
    'Versão antiga: rodava depois do DUM concluir.',
};

const PLACEHOLDERS = [
  { name: '{tool_name}', description: 'Nome do tool sendo chamado (Bash, Edit, …)' },
  { name: '{tool_input}', description: 'Input JSON completo passado ao tool' },
  { name: '{file_path}', description: 'Caminho do arquivo (Edit/Read/Write/...)' },
  { name: '{shell_command}', description: 'Comando bash (apenas em Bash hooks)' },
  { name: '{user_message}', description: 'Última mensagem do usuário (UserPromptSubmit)' },
  { name: '{cwd}', description: 'Diretório de trabalho atual' },
  { name: '{projectPath}', description: 'Caminho do projeto ativo' },
];

function newHookDraft(event: HookEventDTO): HookDTO {
  return {
    id: `new-${Date.now()}`,
    event,
    type: 'command',
    command: '',
    if: '',
    timeout: 60,
  };
}

export function HooksPage(): React.ReactElement {
  const qc = useQueryClient();
  const hooksQuery = useQuery<HookDTO[]>({
    queryKey: ['hooks'],
    queryFn: () => hooksApi.list(),
    staleTime: 5_000,
  });

  const saveMut = useMutation({
    mutationFn: (next: HookDTO[]) => hooksApi.save(next, 'user'),
    onSuccess: (next) => {
      qc.setQueryData(['hooks'], next);
      toast.success('Hooks salvos');
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const [activeEvent, setActiveEvent] = React.useState<HookEventDTO>('PreToolUse');
  const [showLegacy, setShowLegacy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<HookDTO | null>(null);

  const hooks = hooksQuery.data ?? [];
  const eventHooks = hooks.filter((h) => h.event === activeEvent);
  const counts = React.useMemo(() => {
    const out: Partial<Record<HookEventDTO, number>> = {};
    for (const h of hooks) out[h.event] = (out[h.event] || 0) + 1;
    return out;
  }, [hooks]);

  const startNew = (): void => {
    const d = newHookDraft(activeEvent);
    setDraft(d);
    setEditingId(d.id);
  };
  const startEdit = (h: HookDTO): void => {
    setDraft({ ...h });
    setEditingId(h.id);
  };
  const cancelEdit = (): void => {
    setDraft(null);
    setEditingId(null);
  };
  const saveEdit = (): void => {
    if (!draft) return;
    if (!validateHook(draft)) {
      toast.error('Preencha os campos obrigatórios do tipo selecionado');
      return;
    }
    const isNew = !hooks.some((h) => h.id === draft.id);
    const next = isNew
      ? [...hooks, draft]
      : hooks.map((h) => (h.id === draft.id ? draft : h));
    saveMut.mutate(next);
    cancelEdit();
  };
  const removeHook = (id: string): void => {
    const next = hooks.filter((h) => h.id !== id);
    saveMut.mutate(next);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Webhook size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Ações automáticas (Hooks)</h1>
        </div>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Configure ações que rodam automaticamente em momentos específicos da
          conversa com o agente.
        </p>
      </header>

      {/* Banner explicativo — diz o que isso é e dá exemplos */}
      <div className="flex items-start gap-2 border-b border-border-subtle bg-primary/[0.04] px-6 py-3 text-[12px] leading-relaxed text-text-soft">
        <Lightbulb size={13} className="mt-0.5 shrink-0 text-primary" strokeWidth={2} />
        <div>
          <p>
            <span className="font-medium text-text">O que é:</span> hooks são
            "gatilhos" — quando algo acontece (você manda mensagem, o agente
            edita um arquivo, ele termina de responder…), seu comando roda
            automaticamente.
          </p>
          <p className="mt-1.5 text-dim">
            <span className="font-medium text-text-soft">Exemplos:</span> rodar
            testes toda vez que ele editar código, mandar uma notificação no
            Slack quando ele terminar uma tarefa, bloquear ações em arquivos
            sensíveis, fazer backup antes de cada modificação.
          </p>
          <p className="mt-1.5 text-dim/80">
            Escolha um <span className="text-text-soft">momento</span> nas abas
            abaixo, depois clique em <span className="text-text-soft">+ Adicionar hook</span>.
          </p>
        </div>
      </div>

      {/* Event tabs */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-border-subtle bg-surface-1/40 px-6 py-2">
        {LIFECYCLE_EVENTS.map((ev) => (
          <EventTab
            key={ev}
            event={ev}
            count={counts[ev] ?? 0}
            active={activeEvent === ev}
            onClick={() => setActiveEvent(ev)}
          />
        ))}
        <button
          type="button"
          onClick={() => setShowLegacy((s) => !s)}
          className="ml-2 rounded-md px-2 py-1 text-[10.5px] uppercase tracking-[0.08em] text-dim-soft hover:bg-surface-2 hover:text-text"
        >
          {showLegacy ? '− legacy' : '+ legacy'}
        </button>
      </nav>
      {showLegacy && (
        <nav className="flex flex-wrap items-center gap-1 border-b border-border-subtle bg-surface-1/20 px-6 py-1.5">
          {LEGACY_EVENTS.map((ev) => (
            <EventTab
              key={ev}
              event={ev}
              count={counts[ev] ?? 0}
              active={activeEvent === ev}
              onClick={() => setActiveEvent(ev)}
            />
          ))}
        </nav>
      )}

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-text">
                {EVENT_LABELS[activeEvent]}
              </h2>
              <span
                className="font-mono text-[10.5px] text-dim/70"
                title="Nome técnico do evento — usado em hooks.json e na documentação"
              >
                {activeEvent}
              </span>
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10.5px] text-primary">
                {eventHooks.length} hook{eventHooks.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mt-1 max-w-[640px] text-[12px] leading-relaxed text-text-soft">
              {EVENT_DESCRIPTIONS[activeEvent]}
            </p>
          </div>
          <button
            type="button"
            onClick={startNew}
            disabled={editingId !== null}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={12} />
            Adicionar hook
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {eventHooks.length === 0 && editingId === null && (
            <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12.5px] text-dim/70">
              Nenhum hook neste evento.
            </div>
          )}
          {eventHooks.map((h) =>
            editingId === h.id && draft ? (
              <HookEditor
                key={h.id}
                draft={draft}
                onChange={setDraft}
                onSave={saveEdit}
                onCancel={cancelEdit}
                saving={saveMut.isPending}
              />
            ) : (
              <HookCard
                key={h.id}
                hook={h}
                onEdit={() => startEdit(h)}
                onRemove={() => removeHook(h.id)}
                disabled={editingId !== null || saveMut.isPending}
              />
            ),
          )}
          {/* New hook editor (when adding from scratch) */}
          {editingId !== null &&
            draft &&
            !eventHooks.some((h) => h.id === editingId) && (
              <HookEditor
                draft={draft}
                onChange={setDraft}
                onSave={saveEdit}
                onCancel={cancelEdit}
                saving={saveMut.isPending}
              />
            )}
        </div>

        <PlaceholdersCheatsheet />
      </div>
    </div>
  );
}

function validateHook(h: HookDTO): boolean {
  if (h.type === 'command') return Boolean(h.command?.trim());
  if (h.type === 'http') return Boolean(h.url?.trim());
  if (h.type === 'prompt') return Boolean(h.prompt?.trim());
  if (h.type === 'agent') return Boolean(h.subagent_type?.trim() && h.task?.trim());
  return false;
}

// ─── Event tab ─────────────────────────────────────────────────────────

function EventTab({
  event,
  count,
  active,
  onClick,
}: {
  event: HookEventDTO;
  count: number;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      // Tooltip mostra o nome técnico (PreToolUse, etc.) pra quem precisa
      // referenciar na documentação ou no JSON. UI mostra a label amigável.
      title={`${event} — ${EVENT_DESCRIPTIONS[event]}`}
      className={clsx(
        'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-text-soft hover:bg-surface-2 hover:text-text',
      )}
    >
      {EVENT_LABELS[event]}
      {count > 0 && (
        <span
          className={clsx(
            'rounded px-1 text-[9.5px]',
            active ? 'bg-primary/30' : 'bg-surface-3 text-dim-soft',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Hook card (read-only summary) ─────────────────────────────────────

function HookCard({
  hook,
  onEdit,
  onRemove,
  disabled,
}: {
  hook: HookDTO;
  onEdit: () => void;
  onRemove: () => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/40 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <TypeBadge type={hook.type} />
            {hook.if && (
              <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-accent">
                if: {hook.if}
              </code>
            )}
            {hook.async && (
              <span className="rounded bg-secondary/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] text-secondary">
                async
              </span>
            )}
            {hook.timeout && (
              <span className="flex items-center gap-1 text-[10.5px] text-dim/80">
                <Clock size={10} />
                {hook.timeout}s
              </span>
            )}
          </div>
          <HookSummary hook={hook} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            disabled={disabled}
            title="Editar"
            className="rounded p-1.5 text-dim-soft hover:bg-surface-3 hover:text-text disabled:opacity-50"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            title="Remover"
            className="rounded p-1.5 text-dim-soft hover:bg-surface-3 hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function HookSummary({ hook }: { hook: HookDTO }): React.ReactElement {
  if (hook.type === 'command') {
    return (
      <code className="block whitespace-pre-wrap break-all font-mono text-[11.5px] text-text">
        {hook.command || '(comando vazio)'}
      </code>
    );
  }
  if (hook.type === 'http') {
    return (
      <code className="block font-mono text-[11.5px] text-text">
        {hook.method ?? 'POST'} {hook.url || '(URL vazia)'}
      </code>
    );
  }
  if (hook.type === 'prompt') {
    return (
      <div className="font-mono text-[11.5px] text-text">
        <span className="mr-2 rounded bg-surface-3 px-1 py-0.5 text-[10px] text-dim-soft">
          {hook.model ?? 'fast'}
        </span>
        <span className="line-clamp-2">{hook.prompt || '(prompt vazio)'}</span>
      </div>
    );
  }
  return (
    <div className="font-mono text-[11.5px] text-text">
      <span className="mr-2 rounded bg-surface-3 px-1 py-0.5 text-[10px] text-dim-soft">
        {hook.subagent_type || '?'}
      </span>
      <span className="line-clamp-2">{hook.task || '(task vazia)'}</span>
    </div>
  );
}

function TypeBadge({ type }: { type: HookTypeDTO }): React.ReactElement {
  const colors: Record<HookTypeDTO, string> = {
    command: 'bg-success/15 text-success',
    http: 'bg-secondary/15 text-secondary',
    prompt: 'bg-primary/15 text-primary',
    agent: 'bg-warning/15 text-warning',
  };
  return (
    <span className={clsx('rounded px-1.5 py-0.5 font-mono text-[10.5px] uppercase', colors[type])}>
      {type}
    </span>
  );
}

// ─── Hook editor (full form) ───────────────────────────────────────────

function HookEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  draft: HookDTO;
  onChange: (next: HookDTO) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-md border-2 border-primary/40 bg-surface-2/40 p-4">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Type" className="min-w-[160px]">
          <select
            value={draft.type}
            onChange={(e) => onChange({ ...draft, type: e.target.value as HookTypeDTO })}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          >
            <option value="command">command</option>
            <option value="http">http</option>
            <option value="prompt">prompt</option>
            <option value="agent">agent</option>
          </select>
        </Field>
        <Field label="if (filter)" className="flex-1 min-w-[200px]">
          <input
            value={draft.if ?? ''}
            onChange={(e) => onChange({ ...draft, if: e.target.value })}
            placeholder='Bash(git *)  ·  Edit(*.ts)  ·  *'
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
        <Field label="Timeout (s)" className="w-[100px]">
          <input
            type="number"
            min={1}
            value={draft.timeout ?? 60}
            onChange={(e) => onChange({ ...draft, timeout: parseInt(e.target.value, 10) || 60 })}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
        <label className="flex items-center gap-2 pb-1.5 text-[12px] text-text-soft">
          <input
            type="checkbox"
            checked={Boolean(draft.async)}
            onChange={(e) => onChange({ ...draft, async: e.target.checked })}
            className="h-3.5 w-3.5 cursor-pointer accent-primary"
          />
          async (fire-and-forget)
        </label>
      </div>

      {/* Type-specific fields */}
      {draft.type === 'command' && (
        <Field label="Comando shell" className="w-full">
          <textarea
            value={draft.command ?? ''}
            onChange={(e) => onChange({ ...draft, command: e.target.value })}
            rows={3}
            placeholder="echo {tool_name} on {file_path} >> /tmp/hooks.log"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
      )}
      {draft.type === 'http' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[120px_1fr]">
            <Field label="Method">
              <select
                value={draft.method ?? 'POST'}
                onChange={(e) => onChange({ ...draft, method: e.target.value as 'POST' | 'PUT' | 'PATCH' })}
                className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
              >
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
              </select>
            </Field>
            <Field label="URL">
              <input
                value={draft.url ?? ''}
                onChange={(e) => onChange({ ...draft, url: e.target.value })}
                placeholder="https://hook.example.com/audit"
                className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
              />
            </Field>
          </div>
          <HeadersEditor
            headers={draft.headers}
            onChange={(headers) => onChange({ ...draft, headers })}
          />
        </div>
      )}
      {draft.type === 'prompt' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[120px_1fr]">
            <Field label="Model">
              <select
                value={draft.model ?? 'fast'}
                onChange={(e) => onChange({ ...draft, model: e.target.value as 'fast' | 'primary' })}
                className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
              >
                <option value="fast">fast</option>
                <option value="primary">primary</option>
              </select>
            </Field>
            <Field label="Veto if contains">
              <input
                value={draft.vetoIfContains ?? ''}
                onChange={(e) => onChange({ ...draft, vetoIfContains: e.target.value })}
                placeholder="block"
                className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
              />
            </Field>
          </div>
          <Field label="Prompt">
            <textarea
              value={draft.prompt ?? ''}
              onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
              rows={4}
              placeholder='Audite a tool {tool_name} sobre {file_path}. Responda "block" se houver risco.'
              className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
            />
          </Field>
        </div>
      )}
      {draft.type === 'agent' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr]">
            <Field label="Subagent type">
              <input
                value={draft.subagent_type ?? ''}
                onChange={(e) => onChange({ ...draft, subagent_type: e.target.value })}
                placeholder="code-reviewer"
                className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
              />
            </Field>
            <Field label="Veto if contains">
              <input
                value={draft.vetoIfContains ?? ''}
                onChange={(e) => onChange({ ...draft, vetoIfContains: e.target.value })}
                placeholder="block"
                className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
              />
            </Field>
          </div>
          <Field label="Task prompt">
            <textarea
              value={draft.task ?? ''}
              onChange={(e) => onChange({ ...draft, task: e.target.value })}
              rows={4}
              placeholder="Analise o impacto de {tool_name} em {file_path}…"
              className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
            />
          </Field>
        </div>
      )}

      <TestRunner draft={draft} />

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3"
        >
          <X size={12} />
          Cancelar
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
        >
          <Save size={12} />
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}

// ─── Headers editor (http hook) ────────────────────────────────────────

function HeadersEditor({
  headers,
  onChange,
}: {
  headers?: Record<string, string>;
  onChange: (next: Record<string, string> | undefined) => void;
}): React.ReactElement {
  // Local row buffer keeps focus stable while the user types — committing to
  // the parent on every keystroke would re-render and steal focus from the
  // input on key/value rename.
  const initial = React.useMemo(
    () => Object.entries(headers ?? {}).map(([k, v]) => ({ k, v })),
    [headers],
  );
  const [rows, setRows] = React.useState<Array<{ k: string; v: string }>>(initial);

  React.useEffect(() => {
    setRows(Object.entries(headers ?? {}).map(([k, v]) => ({ k, v })));
  }, [headers]);

  const commit = (next: Array<{ k: string; v: string }>): void => {
    setRows(next);
    const obj: Record<string, string> = {};
    for (const r of next) {
      const key = r.k.trim();
      if (!key) continue;
      obj[key] = r.v;
    }
    onChange(Object.keys(obj).length > 0 ? obj : undefined);
  };

  return (
    <div className="rounded-md border border-border-subtle bg-surface-1/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
          Headers (opcional)
        </span>
        <button
          type="button"
          onClick={() => commit([...rows, { k: '', v: '' }])}
          className="flex items-center gap-1 rounded border border-border-subtle bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-soft hover:bg-surface-3"
        >
          <Plus size={10} />
          Adicionar
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-dim/70">
          Sem headers extras. Content-Type: application/json é setado automaticamente.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
              <input
                value={row.k}
                onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
                placeholder="Authorization"
                className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
              />
              <input
                value={row.v}
                onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
                placeholder="Bearer xxx"
                className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => commit(rows.filter((_, j) => j !== i))}
                className="rounded p-1 text-dim-soft hover:bg-surface-3 hover:text-danger"
                title="Remover"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Test runner ────────────────────────────────────────────────────────

function TestRunner({ draft }: { draft: HookDTO }): React.ReactElement {
  const [mockTool, setMockTool] = React.useState('Bash');
  const [mockInput, setMockInput] = React.useState('{"command":"git status"}');
  const [result, setResult] = React.useState<HookTestResultDTO | null>(null);

  const testMut = useMutation({
    mutationFn: (vars: { runHttp: boolean }) => {
      let parsed: any = {};
      try { parsed = JSON.parse(mockInput); } catch { /* */ }
      return hooksApi.test(draft, mockTool, parsed, { runHttp: vars.runHttp });
    },
    onSuccess: (r) => setResult(r),
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const isHttp = draft.type === 'http';

  return (
    <div className="mt-4 rounded-md border border-border-subtle bg-surface-1/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-dim/80">
        <Play size={11} />
        Test-run (mock context)
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[140px_1fr]">
        <Field label="Mock tool">
          <input
            value={mockTool}
            onChange={(e) => setMockTool(e.target.value)}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
          />
        </Field>
        <Field label="Mock tool_input (JSON)">
          <input
            value={mockInput}
            onChange={(e) => setMockInput(e.target.value)}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
          />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => testMut.mutate({ runHttp: false })}
          disabled={testMut.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1 text-[11.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
        >
          {testMut.isPending ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Play size={11} fill="currentColor" />
          )}
          Testar agora
        </button>
        {isHttp && (
          <button
            type="button"
            onClick={() => testMut.mutate({ runHttp: true })}
            disabled={testMut.isPending}
            className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-1 text-[11.5px] text-warning hover:bg-warning/15 disabled:opacity-60"
            title="Dispara o webhook de verdade — use só se o endpoint suportar."
          >
            <AlertTriangle size={11} />
            Executar HTTP de verdade
          </button>
        )}
      </div>

      {result && (
        <div className="mt-3 rounded border border-border-subtle bg-surface-2 p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px]">
            <ResultBadge result={result} />
            <span className="text-dim-soft">·</span>
            <span className="font-mono text-dim-soft">{result.durationMs}ms</span>
            {result.exitCode !== undefined && (
              <>
                <span className="text-dim-soft">·</span>
                <span className="font-mono text-dim-soft">exit {result.exitCode}</span>
              </>
            )}
          </div>
          {result.note && (
            <div className="mb-2 whitespace-pre-wrap rounded border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-dim-soft">
              {result.note}
            </div>
          )}
          {result.veto && (
            <div className="mb-2 flex items-start gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11.5px] text-danger">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>VETO: {result.veto}</span>
            </div>
          )}
          {result.error && (
            <pre className="mb-2 whitespace-pre-wrap rounded bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-danger">
              {result.error}
            </pre>
          )}
          {result.stdout && (
            <details className="mb-1">
              <summary className="cursor-pointer font-mono text-[10.5px] uppercase tracking-[0.08em] text-dim-soft">
                stdout · {result.stdout.length} bytes
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text">
                {result.stdout}
              </pre>
            </details>
          )}
          {result.stderr && (
            <details>
              <summary className="cursor-pointer font-mono text-[10.5px] uppercase tracking-[0.08em] text-dim-soft">
                stderr · {result.stderr.length} bytes
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-warning">
                {result.stderr}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ResultBadge({ result }: { result: HookTestResultDTO }): React.ReactElement {
  if (result.skipped) {
    return (
      <span className="flex items-center gap-1 text-dim-soft">
        <Info size={12} />
        SKIPPED
      </span>
    );
  }
  if (result.veto) {
    return (
      <span className="flex items-center gap-1 text-danger">
        <XCircle size={12} />
        VETO
      </span>
    );
  }
  if (result.error) {
    return (
      <span className="flex items-center gap-1 text-danger">
        <XCircle size={12} />
        ERRO
      </span>
    );
  }
  if (result.ok) {
    return (
      <span className="flex items-center gap-1 text-success">
        <CheckCircle2 size={12} />
        OK
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-warning">
      <AlertTriangle size={12} />
      WARN
    </span>
  );
}

// ─── Cheatsheet ─────────────────────────────────────────────────────────

function PlaceholdersCheatsheet(): React.ReactElement {
  return (
    <details className="mt-6 rounded-md border border-border-subtle bg-surface-2/30">
      <summary className="cursor-pointer px-4 py-2.5 text-[12px] font-medium text-text-soft hover:bg-surface-2">
        <span className="flex items-center gap-2">
          <Info size={12} />
          Placeholders disponíveis
        </span>
      </summary>
      <div className="border-t border-border-subtle px-4 py-3">
        <table className="w-full">
          <tbody>
            {PLACEHOLDERS.map((p) => (
              <tr key={p.name} className="border-b border-border-subtle last:border-b-0">
                <td className="py-1 pr-4">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-accent">
                    {p.name}
                  </code>
                </td>
                <td className="py-1 text-[11.5px] text-text-soft">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-[11px] text-dim/70">
          Todos os valores são shell-escapados antes da interpolação em command hooks
          (proteção contra injection).
        </div>
      </div>
    </details>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className={clsx('flex flex-col gap-1', className)}>
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
        {label}
      </span>
      {children}
    </label>
  );
}
