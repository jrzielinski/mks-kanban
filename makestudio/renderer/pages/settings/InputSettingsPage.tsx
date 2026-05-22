import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../../lib/clientToast';
import { settingsApi } from '../../ipc/client';
import { loadVimEnabled, setVimEnabled } from '../../hooks/useVim';
import { SettingsTabs } from '../../components/settings/SettingsTabs';
import type { SettingsDTO, PermissionModeDTO } from '@shared/types';

const PERMISSION_MODES: Array<{ value: PermissionModeDTO; label: string; description: string }> = [
  { value: 'default', label: 'Default', description: 'Regras decidem; o que não bate cai na policy default.' },
  { value: 'plan', label: 'Plan', description: 'Edit/Write/MultiEdit bloqueados; apenas leitura/análise.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Edits liberados automaticamente; Bash continua perguntando.' },
  { value: 'bypassPermissions', label: 'Bypass', description: 'Liberado tudo, exceto deny rules explícitas.' },
  { value: 'dontAsk', label: "Don't ask", description: 'Ask-rules viram allow; deny continua negando.' },
];

export function InputSettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const settingsQuery = useQuery<SettingsDTO>({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get(),
    staleTime: 5_000,
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<SettingsDTO>) => settingsApi.set(patch),
    onSuccess: (next) => {
      qc.setQueryData(['settings'], next);
      toast.success('Configurações salvas');
    },
    onError: (err: any) => toast.error(`Falha: ${err?.message ?? err}`),
  });

  const settings = settingsQuery.data;
  const [appVim, setAppVim] = React.useState<boolean>(() => loadVimEnabled());

  const toggleAppVim = (v: boolean): void => {
    setVimEnabled(v);
    setAppVim(v);
    toast.success(`Vim do app ${v ? 'ligado' : 'desligado'}`);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <h1 className="text-[18px] font-semibold text-text">Entrada</h1>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Preferências de input — vim mode, fast mode, permission mode e
          comportamento de paste/@file.
        </p>
      </header>
      <SettingsTabs />

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="flex flex-col gap-6">
          {/* ── Vim ──────────────────────────────────────────────────── */}
          <Section
            title="Vim mode"
            description="Modal editing no input do REPL. Você pode habilitar separadamente no app (Electron) e na TUI (CLI)."
          >
            <div className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-2/50">
              <ToggleRow
                label="Vim no app"
                description="Vim modal apenas neste app Electron. Persistido no navegador."
                checked={appVim}
                onChange={toggleAppVim}
              />
              <ToggleRow
                label="Vim na TUI"
                description="Vim modal quando você roda makestudio direto no terminal."
                checked={Boolean(settings?.vimMode)}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ vimMode: v })}
              />
            </div>
          </Section>

          {/* ── Fast mode ────────────────────────────────────────────── */}
          <Section
            title="Fast mode"
            description="Roteamento pro modelo fast em tasks leves. Ganha latência, perde profundidade — bom pra rascunhos."
          >
            <div className="rounded-md border border-border-subtle bg-surface-2/50">
              <ToggleRow
                label="Fast mode"
                description="Equivalente ao slash command /fast. Persistido em settings.json."
                checked={Boolean(settings?.fastMode)}
                disabled={updateMut.isPending || !settings}
                onChange={(v) => updateMut.mutate({ fastMode: v })}
              />
            </div>
          </Section>

          {/* ── Permission mode ──────────────────────────────────────── */}
          <Section
            title="Permission mode"
            description="Política de execução session-wide. Aplicada ANTES das regras de permissions.json."
          >
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => updateMut.mutate({ permissionMode: m.value })}
                  disabled={updateMut.isPending || !settings}
                  className={clsx(
                    'flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors',
                    (settings?.permissionMode ?? 'default') === m.value
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border-subtle bg-surface-2 hover:border-border-soft',
                  )}
                >
                  <span className="text-[12.5px] font-medium text-text">{m.label}</span>
                  <span className="text-[11px] text-dim-soft">{m.description}</span>
                </button>
              ))}
            </div>
          </Section>

          {/* ── Paste behaviour ──────────────────────────────────────── */}
          <Section
            title="Paste"
            description="Multi-line paste vira marker compacto pra não estourar o input. Toggle + thresholds editáveis em settings.json (inputPaste.*)."
          >
            <PasteSettings
              settings={settings}
              disabled={updateMut.isPending || !settings}
              onChange={(patch) => updateMut.mutate({ inputPaste: patch })}
            />
            <div className="mt-2 flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-2/50">
              <InfoRow
                label="Paste de imagem → marker [Image #N]"
                description="Ctrl/Cmd+V de imagem do clipboard sobe pra main e roteia pro modelo de visão automaticamente. Sem toggle — sempre ativo."
              />
              <InfoRow
                label="Drag & drop de arquivos"
                description="Arrastar arquivo pro input cria attachment chip com thumbnail (imagens) ou path. Sem toggle — sempre ativo."
              />
            </div>
          </Section>

          {/* ── @file ────────────────────────────────────────────────── */}
          <Section
            title="@file reference"
            description="Picker fuzzy de arquivos quando você digita @token no input. Editável em settings.json (inputAtFile.*)."
          >
            <AtFileSettings
              settings={settings}
              disabled={updateMut.isPending || !settings}
              onChange={(patch) => updateMut.mutate({ inputAtFile: patch })}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

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

function InfoRow({
  label,
  description,
}: {
  label: string;
  description: string;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Info size={13} className="mt-0.5 shrink-0 text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-text">{label}</div>
        <div className="mt-0.5 text-[11.5px] text-dim-soft">{description}</div>
      </div>
    </div>
  );
}

// ─── Paste / @file settings ────────────────────────────────────────────

function PasteSettings({
  settings,
  disabled,
  onChange,
}: {
  settings: SettingsDTO | undefined;
  disabled: boolean;
  onChange: (patch: NonNullable<SettingsDTO['inputPaste']>) => void;
}): React.ReactElement {
  // Defaults match InputBox call site so the UI shows the active runtime
  // values when settings.json doesn't override them.
  const autoMarker = settings?.inputPaste?.autoMarker !== false;
  const lines = settings?.inputPaste?.markerThresholdLines ?? 5;
  const chars = settings?.inputPaste?.markerThresholdChars ?? 800;

  const update = (patch: NonNullable<SettingsDTO['inputPaste']>): void => {
    onChange({
      autoMarker,
      markerThresholdLines: lines,
      markerThresholdChars: chars,
      ...patch,
    });
  };

  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/50">
      <ToggleRow
        label="Auto-marker em paste multi-line"
        description="Paste >= threshold vira [Pasted #N +M lines]; <= mantém o paste padrão do browser."
        checked={autoMarker}
        disabled={disabled}
        onChange={(v) => update({ autoMarker: v })}
      />
      <div className={clsx('grid grid-cols-1 gap-3 border-t border-border-subtle px-3 py-2.5 md:grid-cols-2', !autoMarker && 'opacity-50')}>
        <NumberField
          label="Threshold linhas"
          value={lines}
          min={1}
          max={1000}
          disabled={disabled || !autoMarker}
          onCommit={(n) => update({ markerThresholdLines: n })}
        />
        <NumberField
          label="Threshold chars"
          value={chars}
          min={20}
          max={1_000_000}
          disabled={disabled || !autoMarker}
          onCommit={(n) => update({ markerThresholdChars: n })}
        />
      </div>
    </div>
  );
}

function AtFileSettings({
  settings,
  disabled,
  onChange,
}: {
  settings: SettingsDTO | undefined;
  disabled: boolean;
  onChange: (patch: NonNullable<SettingsDTO['inputAtFile']>) => void;
}): React.ReactElement {
  const enabled = settings?.inputAtFile?.enabled !== false;
  const max = settings?.inputAtFile?.maxResults ?? 20;

  const update = (patch: NonNullable<SettingsDTO['inputAtFile']>): void => {
    onChange({ enabled, maxResults: max, ...patch });
  };

  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/50">
      <ToggleRow
        label="@file picker"
        description="Digite @ no input pra abrir o picker fuzzy de arquivos. Off = @token vira texto puro."
        checked={enabled}
        disabled={disabled}
        onChange={(v) => update({ enabled: v })}
      />
      <div className={clsx('border-t border-border-subtle px-3 py-2.5', !enabled && 'opacity-50')}>
        <NumberField
          label="Máximo de resultados no popover"
          value={max}
          min={1}
          max={200}
          disabled={disabled || !enabled}
          onCommit={(n) => update({ maxResults: n })}
        />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}): React.ReactElement {
  // Local buffer so the user can type freely; commit on blur/Enter only.
  // Avoids firing a settings save on every keystroke.
  const [local, setLocal] = React.useState(String(value));
  React.useEffect(() => { setLocal(String(value)); }, [value]);
  const commit = (): void => {
    const n = Number(local);
    if (!Number.isFinite(n)) { setLocal(String(value)); return; }
    const clamped = Math.max(min, Math.min(max, Math.round(n)));
    if (clamped !== value) onCommit(clamped);
    setLocal(String(clamped));
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
        {label}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
        }}
        className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60"
      />
    </label>
  );
}
