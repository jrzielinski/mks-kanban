import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, Minus, Pencil, Trash2, Save, X, Monitor, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../../lib/clientToast';
import { settingsApi, themesApi, outputStylesApi } from '../../ipc/client';
import { useThemeStore, THEMES, type ThemeName } from '../../store';
import { SettingsTabs } from '../../components/settings/SettingsTabs';
import type {
  SettingsDTO,
  OutputStyleDTO,
  OutputStyleBodyDTO,
  OutputStyleSaveDTO,
} from '@shared/types';

export function AppearanceSettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const settingsQuery = useQuery<SettingsDTO>({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get(),
    staleTime: 5_000,
  });
  const themesQuery = useQuery<Array<{ name: string }>>({
    queryKey: ['themes', 'list'],
    queryFn: () => themesApi.list(),
    staleTime: 60_000,
  });
  const outputStylesQuery = useQuery<OutputStyleDTO[]>({
    queryKey: ['output-styles'],
    queryFn: () => outputStylesApi.list(),
    staleTime: 60_000,
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<SettingsDTO>) => settingsApi.set(patch),
    onSuccess: (next) => {
      qc.setQueryData(['settings'], next);
      toast.success('Configurações salvas');
    },
    onError: (err: any) => {
      toast.error(`Falha ao salvar: ${err?.message ?? err}`);
    },
  });
  const setOutputStyleMut = useMutation({
    mutationFn: (name: string) => outputStylesApi.set(name),
    onSuccess: (next) => {
      qc.setQueryData(['settings'], next);
      toast.success('Output style atualizado');
    },
  });
  const deleteOutputStyleMut = useMutation({
    mutationFn: (vars: { name: string; scope: 'user' | 'project' }) =>
      outputStylesApi.delete(vars.name, vars.scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['output-styles'] });
      toast.success('Output style removido');
    },
    onError: (e: any) => toast.error(`Falha ao remover: ${e?.message ?? e}`),
  });

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingName, setEditingName] = React.useState<string | null>(null);
  // Track which style row is in "click again to confirm" state. Reset after
  // 3s so a stale armed delete doesn't sit indefinitely.
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3_000);
    return () => clearTimeout(t);
  }, [pendingDelete]);
  const openCreate = (): void => {
    setEditingName(null);
    setEditorOpen(true);
  };
  const openEdit = (name: string): void => {
    setEditingName(name);
    setEditorOpen(true);
  };
  const closeEditor = (): void => {
    setEditorOpen(false);
    setEditingName(null);
  };

  const settings = settingsQuery.data;
  const themes = themesQuery.data ?? [];
  const outputStyles = outputStylesQuery.data ?? [];
  const electronTheme = useThemeStore((s) => s.theme);
  const setElectronTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <h1 className="text-[18px] font-semibold text-text">Aparência</h1>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Tema do app, tema da TUI, output style e toggles de comportamento.
        </p>
      </header>
      <SettingsTabs />

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="flex flex-col gap-6">
          {/* ── Escala da interface ──────────────────────────────────── */}
          <Section
            title="Escala da interface"
            description="Zoom global da UI — útil para notebooks com tela pequena. Salvo em ~/.makestudio/settings.json."
          >
            <UiScaleSlider
              value={settings?.uiScale ?? autoScale()}
              onChange={(v) => updateMut.mutate({ uiScale: v })}
            />
          </Section>

          {/* ── Tema do app (Electron UI) ─────────────────────────────── */}
          <Section
            title="Tema do app"
            description="Tema visual do Electron — afeta apenas esta janela. Salvo no navegador."
          >
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
              {THEMES.filter((t) => !t.hidden || electronTheme === t.id).map((t) => (
                <ThemeCard
                  key={t.id}
                  theme={t}
                  active={electronTheme === t.id}
                  onSelect={() => setElectronTheme(t.id as ThemeName)}
                />
              ))}
            </div>
          </Section>

          {/* ── Tema da TUI / agent-core ─────────────────────────────── */}
          <Section
            title="Tema da TUI"
            description="Paleta usada quando você roda o makestudio direto no terminal (CLI ink-tui)."
          >
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
              {themes.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => updateMut.mutate({ theme: t.name })}
                  disabled={updateMut.isPending}
                  className={clsx(
                    'flex h-10 items-center justify-center rounded-md border px-2 text-[12.5px] transition-colors',
                    settings?.theme === t.name
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border-subtle bg-surface-2 text-text-soft hover:border-border-soft hover:text-text',
                  )}
                >
                  {t.name}
                  {settings?.theme === t.name && (
                    <Check size={11} className="ml-1.5" strokeWidth={2.4} />
                  )}
                </button>
              ))}
            </div>
          </Section>

          {/* ── Output style ─────────────────────────────────────────── */}
          <Section
            title="Output style"
            description="Modo de resposta do agent — afeta o tom e a profundidade das respostas. Editáveis: user/project. Builtin/managed read-only."
          >
            <div className="mb-2 flex items-center justify-end">
              <button
                type="button"
                onClick={openCreate}
                className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3"
              >
                <Plus size={12} />
                Novo output-style
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
              {outputStyles.map((s) => {
                const isActive = settings?.outputStyle === s.name;
                const editable = s.source === 'user' || s.source === 'project';
                return (
                  <div
                    key={s.name}
                    className={clsx(
                      'group flex flex-col gap-1 rounded-md border px-3 py-2 transition-colors',
                      isActive
                        ? 'border-primary/60 bg-primary/10'
                        : 'border-border-subtle bg-surface-2 hover:border-border-soft',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setOutputStyleMut.mutate(s.name)}
                        disabled={setOutputStyleMut.isPending}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate font-mono text-[12.5px] text-text">
                          {s.name}
                        </span>
                        {isActive && <Check size={11} className="shrink-0 text-primary" strokeWidth={2.4} />}
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <SourceBadge source={s.source} />
                        {editable && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEdit(s.name)}
                              title="Editar"
                              className="rounded p-1 text-dim-soft hover:bg-surface-3 hover:text-text"
                            >
                              <Pencil size={11} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (pendingDelete === s.name) {
                                  deleteOutputStyleMut.mutate({ name: s.name, scope: s.source as 'user' | 'project' });
                                  setPendingDelete(null);
                                } else {
                                  setPendingDelete(s.name);
                                }
                              }}
                              title={pendingDelete === s.name ? 'Clique de novo para confirmar' : 'Remover'}
                              disabled={deleteOutputStyleMut.isPending}
                              className={clsx(
                                'rounded p-1 disabled:opacity-50',
                                pendingDelete === s.name
                                  ? 'bg-danger/20 text-danger'
                                  : 'text-dim-soft hover:bg-surface-3 hover:text-danger',
                              )}
                            >
                              <Trash2 size={11} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {s.description && (
                      <span className="text-[11.5px] text-dim-soft">
                        {s.description}
                      </span>
                    )}
                    {s.bodyPreview && (
                      <span className="line-clamp-2 text-[11px] text-dim/80">
                        {s.bodyPreview}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {editorOpen && (
              <OutputStyleEditor
                editingName={editingName}
                onClose={closeEditor}
                onSaved={() => {
                  qc.invalidateQueries({ queryKey: ['output-styles'] });
                  closeEditor();
                }}
              />
            )}
          </Section>

          {/* ── Toggles de comportamento ─────────────────────────────── */}
          <Section
            title="Comportamento do agent"
            description="Toggles persistidos em ~/.makestudio/settings.json — afetam tanto a TUI quanto este app."
          >
            <div className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-2/50">
              <ToggleRow
                label="Verbose"
                description="Mostra cards completos de tool calls no chat (ao invés de só o nome do tool no status line)."
                checked={Boolean(settings?.verbose)}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ verbose: v })}
              />
              <ToggleRow
                label="Tips"
                description="Mostra a linha de tips no welcome banner."
                checked={!settings?.tipsDisabled}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ tipsDisabled: !v })}
              />
              <ToggleRow
                label="Sugestões pós-turn"
                description="Sugestões automáticas de próximo prompt após cada resposta."
                checked={!settings?.suggestionsDisabled}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ suggestionsDisabled: !v })}
              />
              <ToggleRow
                label="Recap após inatividade"
                description='"Welcome back" com resumo quando há gap longo entre turns.'
                checked={!settings?.awaySummaryDisabled}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ awaySummaryDisabled: !v })}
              />
              <ToggleRow
                label="Magic docs"
                description="Atualização automática de CLAUDE.md / TOOLS.md após cada turn."
                checked={!settings?.magicDocsDisabled}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ magicDocsDisabled: !v })}
              />
              <ToggleRow
                label="File history (snapshot-on-edit)"
                description="Snapshot de cada arquivo antes de Edit/Write — habilita /undo-file."
                checked={!settings?.fileHistoryDisabled}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ fileHistoryDisabled: !v })}
              />
              <ToggleRow
                label="Auto-verify (subagent)"
                description="Subagent de verificação roda builds/tests/probes após edits. Off por padrão — pode queimar bastante token."
                checked={Boolean(settings?.autoVerifyEnabled)}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ autoVerifyEnabled: v })}
              />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────

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

function ThemeCard({
  theme,
  active,
  onSelect,
}: {
  theme: typeof THEMES[number];
  active: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'group relative flex flex-col gap-1.5 rounded-md border p-2 text-left transition-colors',
        active
          ? 'border-primary/60 bg-primary/10'
          : 'border-border-subtle bg-surface-2 hover:border-border-soft',
      )}
      title={theme.inspired}
    >
      <div className="flex h-7 w-full overflow-hidden rounded">
        {theme.swatch.map((c, i) => (
          <div key={i} className="h-full flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-text">{theme.label}</span>
        {active && <Check size={11} className="text-primary" strokeWidth={2.4} />}
      </div>
      <span className="truncate text-[10.5px] text-dim/80">
        {theme.inspired}
      </span>
    </button>
  );
}

function SourceBadge({
  source,
}: {
  source: OutputStyleDTO['source'];
}): React.ReactElement {
  const meta: Record<OutputStyleDTO['source'], { label: string; cls: string }> = {
    builtin: { label: 'builtin', cls: 'bg-secondary/15 text-secondary' },
    user: { label: 'user', cls: 'bg-success/15 text-success' },
    project: { label: 'project', cls: 'bg-warning/15 text-warning' },
    managed: { label: 'managed', cls: 'bg-danger/15 text-danger' },
  };
  const m = meta[source] ?? { label: String(source), cls: 'bg-surface-3 text-dim-soft' };
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.05em]', m.cls)}>
      {m.label}
    </span>
  );
}

// ─── Output style editor ────────────────────────────────────────────────

function OutputStyleEditor({
  editingName,
  onClose,
  onSaved,
}: {
  editingName: string | null;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactElement {
  // Load body when editing existing — null means "create new" so we start empty.
  const bodyQuery = useQuery<OutputStyleBodyDTO | null>({
    queryKey: ['output-styles', 'body', editingName],
    queryFn: () => (editingName ? outputStylesApi.getBody(editingName) : Promise.resolve(null)),
    enabled: editingName !== null,
    staleTime: 0,
  });

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [keepCoding, setKeepCoding] = React.useState(true);
  const [body, setBody] = React.useState('');
  const [scope, setScope] = React.useState<'user' | 'project'>('user');

  // Hydrate from loaded body. The dependency on bodyQuery.data covers both
  // initial load (editingName != null) and the create flow (data === null).
  React.useEffect(() => {
    const d = bodyQuery.data;
    if (editingName === null) {
      setName('');
      setDescription('');
      setKeepCoding(true);
      setBody('');
      setScope('user');
      return;
    }
    if (d) {
      setName(d.name);
      setDescription(d.description ?? '');
      setKeepCoding(d.keepCodingInstructions !== false);
      setBody(d.body ?? '');
      setScope(d.source === 'project' ? 'project' : 'user');
    }
  }, [editingName, bodyQuery.data]);

  const saveMut = useMutation({
    mutationFn: (args: OutputStyleSaveDTO) => outputStylesApi.save(args),
    onSuccess: () => {
      toast.success('Output style salvo');
      onSaved();
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Nome é obrigatório');
      return;
    }
    saveMut.mutate({
      name: trimmed,
      description: description.trim(),
      keepCodingInstructions: keepCoding,
      body,
      scope,
    });
  };

  const isLoading = editingName !== null && bodyQuery.isLoading;
  const sourceReadOnly = bodyQuery.data?.source === 'builtin' || bodyQuery.data?.source === 'managed';

  return (
    <div className="mt-3 rounded-md border-2 border-primary/40 bg-surface-2/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-text">
          {editingName ? `Editando "${editingName}"` : 'Novo output-style'}
        </h3>
        {isLoading && <Loader2 size={14} className="animate-spin text-dim-soft" />}
      </div>

      {sourceReadOnly && (
        <div className="mb-3 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11.5px] text-warning">
          Este style é {bodyQuery.data?.source} e read-only — salvar criará uma cópia user/project com o mesmo nome (não permitido para builtin).
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_140px]">
        <Field label="Nome">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={editingName !== null}
            placeholder="meu-style"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60"
          />
        </Field>
        <Field label="Descrição">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tom + profundidade do output"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
          />
        </Field>
        <Field label="Scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'user' | 'project')}
            disabled={editingName !== null}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60"
          >
            <option value="user">user (~/.makestudio)</option>
            <option value="project">project (./.makestudio)</option>
          </select>
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[12px] text-text-soft">
        <input
          type="checkbox"
          checked={keepCoding}
          onChange={(e) => setKeepCoding(e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-primary"
        />
        keepCodingInstructions — preserva a seção builtin de instruções de coding no system prompt
      </label>

      <Field label="Body (Markdown — apendado ao system prompt)" className="mt-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          placeholder='Be terse. Answer first. Skip preamble.'
          className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary"
        />
      </Field>

      {bodyQuery.data?.filePath && (
        <div className="mt-2 text-[11px] text-dim/70">
          Arquivo: <code className="text-accent">{bodyQuery.data.filePath}</code>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3"
        >
          <X size={12} />
          Cancelar
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saveMut.isPending}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
        >
          <Save size={12} />
          {saveMut.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </div>
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

// ─── UI Scale ───────────────────────────────────────────────────────────

const SCALE_MIN = 0.5;
const SCALE_MAX = 2.0;
const SCALE_STEP = 0.05;

function autoScale(): number {
  const w = window.screen.width;
  if (w <= 1280) return 1.2;
  if (w <= 1440) return 1.1;
  if (w <= 1680) return 1.05;
  return 1.0;
}

const SCALE_PRESETS: Array<{ label: string; value: number }> = [
  { label: '50%',  value: 0.5  },
  { label: '75%',  value: 0.75 },
  { label: '90%',  value: 0.9  },
  { label: '100%', value: 1.0  },
  { label: '110%', value: 1.1  },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5  },
  { label: '175%', value: 1.75 },
  { label: '200%', value: 2.0  },
];

const TICK_LABELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

function clampScale(v: number): number {
  const snapped = Math.round(v / SCALE_STEP) * SCALE_STEP;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(snapped.toFixed(2))));
}

function UiScaleSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  // Local state so the thumb moves freely during drag without waiting for
  // the async mutation to round-trip through the query cache.
  const [local, setLocal] = React.useState(() => clampScale(value));

  React.useEffect(() => { setLocal(clampScale(value)); }, [value]);

  // Listen for zoom changes pushed from main (menu shortcuts).
  React.useEffect(() => {
    const unsub = window.makestudio.events.on<{ uiScale?: number }>(
      'settings:changed',
      (dto) => { if (dto?.uiScale != null) setLocal(clampScale(dto.uiScale)); },
    );
    return unsub;
  }, []);

  const screenW = window.screen.width;
  const suggested = clampScale(autoScale());

  const apply = (raw: number): void => {
    const next = clampScale(raw);
    setLocal(next);
    document.documentElement.style.setProperty('--ui-scale', String(next));
    onChange(next);
  };
  const nudge = (delta: number): void => apply(local + delta);

  const percent = Math.round(local * 100);
  const trackPct = ((local - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;
  const atMin = local <= SCALE_MIN + 1e-3;
  const atMax = local >= SCALE_MAX - 1e-3;
  const isDefault = Math.abs(local - 1.0) < 1e-3;

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2/40 px-5 py-4">
      {/* Header: big % display + nudge/reset */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[28px] font-semibold leading-none tabular-nums text-text">
            {percent}
            <span className="ml-0.5 text-[16px] font-medium text-dim-soft">%</span>
          </span>
          {!isDefault && (
            <button
              type="button"
              onClick={() => apply(1.0)}
              className="flex items-center gap-1 text-[11px] text-dim-soft transition-colors hover:text-text"
            >
              <RotateCcw size={11} />
              redefinir
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <NudgeButton onClick={() => nudge(-SCALE_STEP)} disabled={atMin} ariaLabel="Diminuir">
            <Minus size={13} strokeWidth={2.5} />
          </NudgeButton>
          <NudgeButton onClick={() => nudge(SCALE_STEP)} disabled={atMax} ariaLabel="Aumentar">
            <Plus size={13} strokeWidth={2.5} />
          </NudgeButton>
        </div>
      </div>

      {/* Slider */}
      <div className="mt-4">
        <input
          type="range"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={SCALE_STEP}
          value={local}
          onChange={(e) => apply(parseFloat(e.target.value))}
          className="ui-scale-slider"
          style={{ ['--ui-scale-pct' as string]: `${trackPct}%` }}
          aria-label="Escala da interface"
        />

        {/* Tick labels */}
        <div className="relative mt-1 h-4">
          {TICK_LABELS.map((t) => {
            const pct = ((t - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;
            const major = t === 1.0;
            return (
              <span
                key={t}
                className={clsx(
                  'absolute top-0 -translate-x-1/2 text-[10px] tabular-nums',
                  major ? 'font-medium text-text-soft' : 'text-dim/70',
                )}
                style={{ left: `${pct}%` }}
              >
                {Math.round(t * 100)}%
              </span>
            );
          })}
        </div>
      </div>

      {/* Presets */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {SCALE_PRESETS.map((p) => {
          const active = Math.abs(local - p.value) < 1e-3;
          const recommended = Math.abs(suggested - p.value) < 1e-3;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => apply(p.value)}
              className={clsx(
                'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] tabular-nums transition-colors',
                active
                  ? 'bg-primary/15 font-medium text-primary ring-1 ring-inset ring-primary/40'
                  : 'bg-surface-3 text-text-soft hover:bg-surface-3/70 hover:text-text',
              )}
            >
              {p.label}
              {recommended && (
                <span
                  className={clsx('h-1.5 w-1.5 rounded-full', active ? 'bg-primary' : 'bg-primary/60')}
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Footer: screen info + suggested */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim-soft">
        <span className="flex items-center gap-1.5">
          <Monitor size={11} />
          Tela {screenW}px
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-primary/60" aria-hidden />
          recomendado
          {Math.abs(local - suggested) > 1e-3 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => apply(suggested)}
                className="text-primary underline-offset-2 hover:underline"
              >
                aplicar {Math.round(suggested * 100)}%
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function NudgeButton({
  onClick,
  disabled,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-border-subtle bg-surface-3 text-text-soft transition-colors hover:border-border-soft hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-subtle disabled:hover:text-text-soft"
    >
      {children}
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-start justify-between gap-4 px-3 py-2.5 transition-colors',
        disabled ? 'opacity-60' : 'hover:bg-surface-2',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-text">{label}</div>
        <div className="mt-0.5 text-[11.5px] text-dim-soft">{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 cursor-pointer accent-primary"
      />
    </label>
  );
}
