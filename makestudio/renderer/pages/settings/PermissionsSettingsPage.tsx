import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  AlertTriangle,
  Lock,
  Save,
  X,
  Play,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Pencil,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../../lib/clientToast';
import { permissionsApi } from '../../ipc/client';
import { SettingsTabs } from '../../components/settings/SettingsTabs';
import type {
  PermissionPolicyDTO,
  PermissionRuleDTO,
  ShadowWarningDTO,
  TrustedFolderDTO,
  PermissionTestResultDTO,
} from '@shared/types';

type PermissionAction = PermissionRuleDTO['action'];
type PermissionMode = PermissionPolicyDTO['mode'];

type ConditionKind = 'cwd' | 'branch' | 'hour' | 'weekday';

interface ConditionDraft {
  kind: ConditionKind;
  value: string;
  negate: boolean;
}

const CONDITION_KINDS: Array<{ value: ConditionKind; label: string; placeholder: string }> = [
  { value: 'cwd', label: 'cwd', placeholder: '/Users/foo/projeto/src' },
  { value: 'branch', label: 'branch', placeholder: 'main · feature/* · staging,prod' },
  { value: 'hour', label: 'hour', placeholder: '9 · 9-17' },
  { value: 'weekday', label: 'weekday', placeholder: 'mon-fri · sat,sun' },
];

/** Wire format ⇄ structured. Mirrors permissions.ts parseCondition + ruleDTOToCore. */
function parseConditions(s: string | undefined): ConditionDraft[] {
  if (!s || !s.trim()) return [];
  const out: ConditionDraft[] = [];
  for (const raw of s.split('&&').map((p) => p.trim()).filter(Boolean)) {
    let str = raw;
    let negate = false;
    if (str.startsWith('!')) { negate = true; str = str.slice(1).trim(); }
    const m = str.match(/^(cwd|branch|hour|weekday)\((.*)\)$/);
    if (!m) continue;
    out.push({ kind: m[1] as ConditionKind, value: m[2].trim(), negate });
  }
  return out;
}

function stringifyConditions(rows: ConditionDraft[]): string | undefined {
  const parts = rows
    .filter((r) => r.value.trim())
    .map((r) => `${r.negate ? '!' : ''}${r.kind}(${r.value.trim()})`);
  return parts.length > 0 ? parts.join(' && ') : undefined;
}

const MODES: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: 'default', label: 'Default', description: 'Regras decidem; unmatched → policy default.' },
  { value: 'plan', label: 'Plan', description: 'Edits bloqueados; só leitura/análise.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Edits liberados; Bash continua perguntando.' },
  { value: 'bypassPermissions', label: 'Bypass', description: 'Allow tudo, exceto deny rules explícitas.' },
  { value: 'dontAsk', label: "Don't ask", description: 'Ask vira allow; deny continua negando.' },
];

const ACTION_COLORS: Record<PermissionAction, string> = {
  allow: 'text-success border-success/40 bg-success/10',
  ask: 'text-warning border-warning/40 bg-warning/10',
  deny: 'text-danger border-danger/40 bg-danger/10',
};

const TOOL_PRESETS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebFetch', 'NotebookEdit', 'memory_save', 'shell_run', '*',
];

export function PermissionsSettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const policyQuery = useQuery<PermissionPolicyDTO>({
    queryKey: ['permissions', 'policy'],
    queryFn: () => permissionsApi.get(),
    staleTime: 5_000,
  });
  const shadowQuery = useQuery<ShadowWarningDTO[]>({
    queryKey: ['permissions', 'shadow'],
    queryFn: () => permissionsApi.shadow(),
    staleTime: 5_000,
  });
  const trustQuery = useQuery<TrustedFolderDTO[]>({
    queryKey: ['permissions', 'trust'],
    queryFn: () => permissionsApi.trustList(),
    staleTime: 10_000,
  });

  const saveMut = useMutation({
    mutationFn: (next: PermissionPolicyDTO) => permissionsApi.save(next, 'user'),
    onSuccess: (next) => {
      qc.setQueryData(['permissions', 'policy'], next);
      qc.invalidateQueries({ queryKey: ['permissions', 'shadow'] });
      toast.success('Política atualizada');
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const setModeMut = useMutation({
    mutationFn: (mode: PermissionMode) => permissionsApi.setMode(mode),
    onSuccess: (next) => {
      qc.setQueryData(['permissions', 'policy'], next);
      toast.success('Mode atualizado');
    },
  });

  const trustAddMut = useMutation({
    mutationFn: (path: string) => permissionsApi.trustAdd(path),
    onSuccess: (res) => {
      if (!res.ok) toast.error(res.message || 'Não adicionou');
      else toast.success('Folder confiado');
      qc.invalidateQueries({ queryKey: ['permissions', 'trust'] });
    },
  });
  const trustRemoveMut = useMutation({
    mutationFn: (path: string) => permissionsApi.trustRemove(path),
    onSuccess: () => {
      toast.success('Folder removido');
      qc.invalidateQueries({ queryKey: ['permissions', 'trust'] });
    },
  });

  const policy = policyQuery.data;
  const shadow = shadowQuery.data ?? [];
  const trust = trustQuery.data ?? [];

  const updateRules = (rules: PermissionRuleDTO[]): void => {
    if (!policy) return;
    saveMut.mutate({ ...policy, rules });
  };
  const updatePolicyDefault = (action: PermissionAction): void => {
    if (!policy) return;
    saveMut.mutate({ ...policy, policy: action });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Lock size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Permissões</h1>
        </div>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Política, regras, modo, folders confiados e sandbox de teste.
          Persistido em ~/.makestudio/permissions.json + permissionMode em settings.json.
        </p>
      </header>
      <SettingsTabs />

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="flex flex-col gap-6">
          {/* ── Policy default + mode ──────────────────────────────── */}
          <Section
            title="Política e modo"
            description="Default decide quando NENHUMA regra bate. Mode aplica BEFORE rules."
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
                <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
                  Policy default
                </div>
                <div className="flex gap-2">
                  {(['allow', 'ask', 'deny'] as PermissionAction[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => updatePolicyDefault(a)}
                      disabled={saveMut.isPending || !policy}
                      className={clsx(
                        'flex-1 rounded border px-3 py-2 text-[12.5px] font-medium uppercase tracking-[0.05em] transition-colors',
                        policy?.policy === a
                          ? ACTION_COLORS[a]
                          : 'border-border-subtle bg-surface-2 text-text-soft hover:bg-surface-3',
                      )}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
                <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
                  Mode
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setModeMut.mutate(m.value)}
                      disabled={setModeMut.isPending || !policy}
                      className={clsx(
                        'flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors',
                        (policy?.mode ?? 'default') === m.value
                          ? 'bg-primary/15 text-primary'
                          : 'text-text-soft hover:bg-surface-3',
                      )}
                    >
                      <span className="text-[12px] font-medium">{m.label}</span>
                      <span className="text-[10.5px] text-dim/80">{m.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          {/* ── Shadow warnings ────────────────────────────────────── */}
          {shadow.length > 0 && (
            <Section
              title={`Avisos de regras sombreadas · ${shadow.length}`}
              description="Regras que nunca disparam porque uma anterior cobre o mesmo escopo. Não quebra nada — só sinaliza configuração inconsistente."
            >
              <ul className="flex flex-col gap-1.5">
                {shadow.map((w, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning"
                  >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11.5px]">
                        {w.earlier.matcher} ({w.earlier.action}) → sombreia {w.shadowed.matcher} ({w.shadowed.action})
                      </div>
                      <div className="text-[10.5px] text-warning/70">{w.reason}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* ── Rules ──────────────────────────────────────────────── */}
          <Section title="Regras" description="Avaliadas em ordem; deny-rules têm prioridade global.">
            <RulesTable
              rules={policy?.rules ?? []}
              onChange={updateRules}
              disabled={saveMut.isPending || !policy}
            />
          </Section>

          {/* ── Trust list ─────────────────────────────────────────── */}
          <Section
            title="Folders confiados"
            description="Diretórios extras que o agent pode acessar. Espelha settings.workingDirs."
          >
            <TrustList
              folders={trust}
              onAdd={(p) => trustAddMut.mutate(p)}
              onRemove={(p) => trustRemoveMut.mutate(p)}
              disabled={trustAddMut.isPending || trustRemoveMut.isPending}
            />
          </Section>

          {/* ── Test sandbox ───────────────────────────────────────── */}
          <Section
            title="Sandbox de teste"
            description="Simula uma chamada de tool e mostra a decisão do engine + qual regra disparou."
          >
            <TestSandbox />
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Section ────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-[13.5px] font-semibold text-text">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[11.5px] text-dim-soft">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

// ─── Rules table ────────────────────────────────────────────────────────

interface RuleDraft {
  tool: string;
  matcher: string;
  action: PermissionAction;
  conditions: ConditionDraft[];
}

function emptyDraft(): RuleDraft {
  return { tool: 'Bash', matcher: '', action: 'allow', conditions: [] };
}

function ruleToDraft(r: PermissionRuleDTO): RuleDraft {
  // Pull the wire matcher from whichever slot the DTO populated. main.ts:
  // ruleToDTO writes the unified `matcher` AND keeps pathPrefix/domain when
  // applicable, so prefer matcher here so we round-trip the user's typed
  // form (e.g. "domain:github.com" stays explicit in the input).
  const matcher = r.matcher || r.pathPrefix || (r.domain ? `domain:${r.domain}` : '');
  return {
    tool: r.tool,
    matcher,
    action: r.action,
    conditions: parseConditions(r.conditions),
  };
}

function draftToRule(d: RuleDraft): PermissionRuleDTO {
  return {
    tool: d.tool.trim(),
    action: d.action,
    matcher: d.matcher.trim() || undefined,
    conditions: stringifyConditions(d.conditions),
  };
}

function RulesTable({
  rules,
  onChange,
  disabled,
}: {
  rules: PermissionRuleDTO[];
  onChange: (next: PermissionRuleDTO[]) => void;
  disabled: boolean;
}): React.ReactElement {
  // editingIdx: -1 = adding new at end, ≥0 = editing existing in-place,
  // null = not editing. Keeping both states unified means the same form
  // serves both flows and edits preserve order naturally.
  const [editingIdx, setEditingIdx] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<RuleDraft>(emptyDraft);

  const startAdd = (): void => {
    setDraft(emptyDraft());
    setEditingIdx(-1);
  };
  const startEdit = (i: number): void => {
    setDraft(ruleToDraft(rules[i]));
    setEditingIdx(i);
  };
  const cancel = (): void => {
    setEditingIdx(null);
    setDraft(emptyDraft());
  };
  const submit = (): void => {
    if (!draft.tool.trim()) {
      toast.error('Tool é obrigatório');
      return;
    }
    const rule = draftToRule(draft);
    if (editingIdx === null) return;
    if (editingIdx === -1) {
      onChange([...rules, rule]);
    } else {
      // Replace in-place — preserves order, which matters because rules
      // are evaluated deny-first then in array order (see permissions.ts).
      onChange(rules.map((r, i) => (i === editingIdx ? rule : r)));
    }
    cancel();
  };
  const remove = (idx: number): void => {
    onChange(rules.filter((_, i) => i !== idx));
  };

  const isEditing = editingIdx !== null;

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <table className="w-full">
        <thead className="bg-surface-2">
          <tr>
            <Th className="w-[140px]">Tool</Th>
            <Th>Matcher</Th>
            <Th className="w-[260px]">Conditions</Th>
            <Th className="w-[100px]">Action</Th>
            <Th className="w-[80px]" />
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && !isEditing && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-[12px] text-dim/70">
                Nenhuma regra. Clique em "Adicionar" para criar a primeira.
              </td>
            </tr>
          )}
          {rules.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle align-top">
              <Td>
                <span className="font-mono text-[12px] text-text">{r.tool}</span>
              </Td>
              <Td>
                {r.matcher || r.pathPrefix || r.domain ? (
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-text-soft">
                    {r.matcher || r.pathPrefix || (r.domain ? `domain:${r.domain}` : '')}
                  </code>
                ) : (
                  <span className="text-[11.5px] text-dim/70">qualquer</span>
                )}
              </Td>
              <Td>
                {r.conditions ? (
                  <code className="text-[11px] text-accent">{r.conditions}</code>
                ) : (
                  <span className="text-[11.5px] text-dim/70">—</span>
                )}
              </Td>
              <Td>
                <span
                  className={clsx(
                    'rounded border px-1.5 py-0.5 font-mono text-[10.5px] uppercase',
                    ACTION_COLORS[r.action],
                  )}
                >
                  {r.action}
                </span>
              </Td>
              <Td>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => startEdit(i)}
                    disabled={disabled || isEditing}
                    className="rounded p-1.5 text-dim-soft hover:bg-surface-3 hover:text-text disabled:opacity-50"
                    title="Editar"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    disabled={disabled || isEditing}
                    className="rounded p-1.5 text-dim-soft hover:bg-surface-3 hover:text-danger disabled:opacity-50"
                    title="Remover"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      {isEditing && (
        <RuleEditor
          draft={draft}
          editingExisting={editingIdx !== -1}
          onChange={setDraft}
          onSave={submit}
          onCancel={cancel}
          disabled={disabled}
        />
      )}
      <div className="border-t border-border-subtle bg-surface-1/40 px-3 py-2">
        {!isEditing && (
          <button
            type="button"
            onClick={startAdd}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded border border-dashed border-border-soft px-3 py-1.5 text-[12px] text-text-soft hover:border-primary/50 hover:text-primary disabled:opacity-50"
          >
            <Plus size={12} />
            Adicionar regra
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Rule editor (add + edit, with structured condition builder) ───────

function RuleEditor({
  draft,
  editingExisting,
  onChange,
  onSave,
  onCancel,
  disabled,
}: {
  draft: RuleDraft;
  editingExisting: boolean;
  onChange: (next: RuleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <div className="border-t-2 border-primary/40 bg-surface-2/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
          {editingExisting ? 'Editando regra' : 'Nova regra'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[160px_1fr_120px]">
        <Field label="Tool">
          <input
            list="tool-presets-rules"
            value={draft.tool}
            onChange={(e) => onChange({ ...draft, tool: e.target.value })}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
          <datalist id="tool-presets-rules">
            {TOOL_PRESETS.map((t) => <option key={t} value={t} />)}
          </datalist>
        </Field>
        <Field label="Matcher (glob, opcional)">
          <input
            value={draft.matcher}
            onChange={(e) => onChange({ ...draft, matcher: e.target.value })}
            placeholder="git *  ·  src/**/*.ts  ·  domain:github.com"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
        <Field label="Action">
          <select
            value={draft.action}
            onChange={(e) => onChange({ ...draft, action: e.target.value as PermissionAction })}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          >
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
          </select>
        </Field>
      </div>

      <ConditionBuilder
        rows={draft.conditions}
        onChange={(rows) => onChange({ ...draft, conditions: rows })}
      />

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
          disabled={disabled}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
        >
          <Save size={12} />
          Salvar
        </button>
      </div>
    </div>
  );
}

// ─── Condition builder ─────────────────────────────────────────────────

function ConditionBuilder({
  rows,
  onChange,
}: {
  rows: ConditionDraft[];
  onChange: (next: ConditionDraft[]) => void;
}): React.ReactElement {
  const setRow = (i: number, patch: Partial<ConditionDraft>): void => {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const add = (): void => {
    onChange([...rows, { kind: 'cwd', value: '', negate: false }]);
  };
  const removeAt = (i: number): void => {
    onChange(rows.filter((_, j) => j !== i));
  };

  return (
    <div className="mt-3 rounded-md border border-border-subtle bg-surface-1/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
          Conditions (TODAS precisam casar)
        </span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 rounded border border-border-subtle bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-soft hover:bg-surface-3"
        >
          <Plus size={10} />
          Adicionar
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-dim/70">
          Sem conditions — a regra dispara sempre que tool/matcher casarem.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, i) => {
            const placeholder = CONDITION_KINDS.find((k) => k.value === row.kind)?.placeholder ?? '';
            return (
              <div key={i} className="grid grid-cols-[auto_120px_1fr_auto] items-center gap-2">
                <label
                  className="flex items-center gap-1 text-[10.5px] text-text-soft"
                  title="Inverter (! prefix) — passa quando NÃO casar"
                >
                  <input
                    type="checkbox"
                    checked={row.negate}
                    onChange={(e) => setRow(i, { negate: e.target.checked })}
                    className="h-3 w-3 cursor-pointer accent-warning"
                  />
                  not
                </label>
                <select
                  value={row.kind}
                  onChange={(e) => setRow(i, { kind: e.target.value as ConditionKind })}
                  className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
                >
                  {CONDITION_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  value={row.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  placeholder={placeholder}
                  className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="rounded p-1 text-dim-soft hover:bg-surface-3 hover:text-danger"
                  title="Remover condição"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Trust list ─────────────────────────────────────────────────────────

function TrustList({
  folders,
  onAdd,
  onRemove,
  disabled,
}: {
  folders: TrustedFolderDTO[];
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  disabled: boolean;
}): React.ReactElement {
  const [draft, setDraft] = React.useState('');
  const submit = (): void => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  };
  return (
    <div className="rounded-md border border-border-subtle">
      {folders.length === 0 ? (
        <div className="border-b border-border-subtle px-4 py-3 text-[12px] text-dim/70">
          Nenhum folder extra.
        </div>
      ) : (
        folders.map((f) => (
          <div
            key={f.path}
            className="flex items-center justify-between border-b border-border-subtle bg-surface-2/40 px-3 py-2 last:border-b-0"
          >
            <code className="truncate font-mono text-[12px] text-text">{f.path}</code>
            <button
              type="button"
              onClick={() => onRemove(f.path)}
              disabled={disabled}
              className="rounded p-1.5 text-dim-soft hover:bg-surface-3 hover:text-danger disabled:opacity-50"
              title="Remover"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="/Users/foo/projetos/extra"
          className="flex-1 rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !draft.trim()}
          className="flex items-center gap-1.5 rounded border border-border-subtle bg-surface-2 px-3 py-1 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-50"
        >
          <Plus size={12} />
          Adicionar
        </button>
      </div>
    </div>
  );
}

// ─── Test sandbox ───────────────────────────────────────────────────────

const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

function TestSandbox(): React.ReactElement {
  const [tool, setTool] = React.useState('Bash');
  const [command, setCommand] = React.useState('git status');
  const [filePath, setFilePath] = React.useState('');
  const [domain, setDomain] = React.useState('');
  const [cwd, setCwd] = React.useState('');
  const [branch, setBranch] = React.useState('');
  const [hour, setHour] = React.useState<string>('');
  const [weekday, setWeekday] = React.useState<string>('');
  const [result, setResult] = React.useState<PermissionTestResultDTO | null>(null);

  const testMut = useMutation({
    mutationFn: () => {
      const hourNum = hour.trim() === '' ? undefined : Number(hour);
      const weekdayNum = weekday.trim() === '' ? undefined : Number(weekday);
      return permissionsApi.test({
        tool,
        command: command || undefined,
        filePath: filePath || undefined,
        domain: domain || undefined,
        cwd: cwd || undefined,
        branch: branch || undefined,
        hour: Number.isFinite(hourNum) ? hourNum : undefined,
        weekday: Number.isFinite(weekdayNum) ? weekdayNum : undefined,
      });
    },
    onSuccess: (r) => setResult(r),
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Tool">
          <input
            list="tool-presets-test"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
          <datalist id="tool-presets-test">
            {TOOL_PRESETS.map((t) => <option key={t} value={t} />)}
          </datalist>
        </Field>
        <Field label="Command (Bash)">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
        <Field label="File path (Read/Edit/...)">
          <input
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="src/foo.ts"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
        <Field label="Domain (WebFetch)">
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="github.com"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
      </div>

      <div className="mt-2 rounded border border-border-subtle bg-surface-1/40 p-2.5">
        <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
          Override de conditions (vazio = usar runtime real)
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="cwd">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/foo/projeto/src"
              className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
            />
          </Field>
          <Field label="branch">
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
            />
          </Field>
          <Field label="hour (0-23)">
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(e.target.value)}
              placeholder="14"
              className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
            />
          </Field>
          <Field label="weekday">
            <select
              value={weekday}
              onChange={(e) => setWeekday(e.target.value)}
              className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
            >
              <option value="">— atual —</option>
              {WEEKDAYS.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => testMut.mutate()}
          disabled={testMut.isPending}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
        >
          <Play size={11} fill="currentColor" />
          Testar
        </button>
        {result && <TestResultBadge result={result} />}
        {result && <SourceBadge source={result.source} />}
      </div>
      {result?.matchedRule && (
        <div className="mt-2 text-[11.5px] text-dim-soft">
          Matched (idx {result.matchedRule.ruleIdx}): <code className="text-accent">{result.matchedRule.tool}({result.matchedRule.matcher}) → {result.matchedRule.action}</code>
        </div>
      )}
      {result?.reason && (
        <div className="mt-1 text-[11px] text-dim/80">{result.reason}</div>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: PermissionTestResultDTO['source'] }): React.ReactElement {
  const label =
    source === 'rule' ? 'rule' : source === 'mode' ? 'mode' : 'default';
  const cls =
    source === 'rule'
      ? 'bg-primary/15 text-primary'
      : source === 'mode'
        ? 'bg-warning/15 text-warning'
        : 'bg-surface-3 text-dim-soft';
  return (
    <span className={clsx('rounded px-1.5 py-0.5 font-mono text-[10.5px] uppercase', cls)}>
      via {label}
    </span>
  );
}

function TestResultBadge({ result }: { result: PermissionTestResultDTO }): React.ReactElement {
  const cls =
    result.decision === 'allow'
      ? 'text-success bg-success/15'
      : result.decision === 'deny'
        ? 'text-danger bg-danger/15'
        : 'text-warning bg-warning/15';
  const Icon =
    result.decision === 'allow'
      ? CheckCircle2
      : result.decision === 'deny'
        ? XCircle
        : HelpCircle;
  return (
    <span
      className={clsx(
        'flex items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium uppercase tracking-[0.05em]',
        cls,
      )}
    >
      <Icon size={12} />
      {result.decision}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
        {label}
      </span>
      {children}
    </label>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <th
      className={clsx(
        'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <td className={clsx('px-3 py-2 align-middle', className)}>{children}</td>;
}
