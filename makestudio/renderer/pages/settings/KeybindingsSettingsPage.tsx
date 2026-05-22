import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Save, X, RotateCcw, Keyboard } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../../lib/clientToast';
import { keybindingsApi } from '../../ipc/client';
import { SettingsTabs } from '../../components/settings/SettingsTabs';

interface ActionMeta {
  action: string;
  description: string;
  defaultCombo: string;
}

// Mirror of agent-core DEFAULTS.keybindings (src/repl/settings.ts) plus
// a human description of where each binding fires.
const ACTION_CATALOG: ActionMeta[] = [
  { action: 'historyPrev', description: 'Volta para o prompt anterior na história do input.', defaultCombo: 'up' },
  { action: 'historyNext', description: 'Avança para o próximo prompt na história do input.', defaultCombo: 'down' },
  { action: 'tabComplete', description: 'Aciona completion (slash commands, @file, etc).', defaultCombo: 'tab' },
  { action: 'reverseSearch', description: 'Busca reversa na história (estilo Ctrl-R do bash).', defaultCombo: 'ctrl+r' },
  { action: 'newline', description: 'Quebra linha no input multi-line sem submeter.', defaultCombo: 'ctrl+j' },
  { action: 'clearScreen', description: 'Limpa o transcript da conversa atual.', defaultCombo: 'ctrl+l' },
  { action: 'cancel', description: 'Cancela a geração em andamento (turn em curso).', defaultCombo: 'escape+escape' },
  { action: 'exit', description: 'Sai do REPL (apenas no modo TUI).', defaultCombo: 'ctrl+c' },
];

export function KeybindingsSettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const bindingsQuery = useQuery<Record<string, string>>({
    queryKey: ['keybindings'],
    queryFn: () => keybindingsApi.get(),
    staleTime: 5_000,
  });

  const setMut = useMutation({
    mutationFn: (next: Record<string, string>) => keybindingsApi.set(next),
    onSuccess: (next) => {
      qc.setQueryData(['keybindings'], next);
      toast.success('Keybindings atualizadas');
    },
    onError: (err: any) => toast.error(`Falha: ${err?.message ?? err}`),
  });

  const bindings = bindingsQuery.data ?? {};

  const updateBinding = (action: string, combo: string): void => {
    if (!combo.trim()) return;
    const next = { ...bindings, [action]: combo.trim() };
    setMut.mutate(next);
  };

  const resetBinding = (action: string): void => {
    const meta = ACTION_CATALOG.find((m) => m.action === action);
    if (!meta) return;
    const next = { ...bindings, [action]: meta.defaultCombo };
    setMut.mutate(next);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Keyboard size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Atalhos do teclado</h1>
        </div>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Combos do input do REPL — afeta a TUI e o input do app. Salvos em
          ~/.makestudio/settings.json. Use "Gravar" pra capturar uma combinação
          ou edite o texto direto (formato:{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent">
            ctrl+r
          </code>
          ).
        </p>
      </header>
      <SettingsTabs />

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="overflow-hidden rounded-md border border-border-subtle">
          <table className="w-full">
            <thead className="bg-surface-2">
              <tr>
                <Th className="w-[180px]">Ação</Th>
                <Th>Descrição</Th>
                <Th className="w-[220px]">Combo</Th>
                <Th className="w-[120px]">Ações</Th>
              </tr>
            </thead>
            <tbody>
              {ACTION_CATALOG.map((meta) => {
                const current = bindings[meta.action] ?? meta.defaultCombo;
                const isDefault = current === meta.defaultCombo;
                return (
                  <BindingRow
                    key={meta.action}
                    meta={meta}
                    current={current}
                    isDefault={isDefault}
                    onSave={(combo) => updateBinding(meta.action, combo)}
                    onReset={() => resetBinding(meta.action)}
                    saving={setMut.isPending}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────

function BindingRow({
  meta,
  current,
  isDefault,
  onSave,
  onReset,
  saving,
}: {
  meta: ActionMeta;
  current: string;
  isDefault: boolean;
  onSave: (combo: string) => void;
  onReset: () => void;
  saving: boolean;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(current);
  const [recording, setRecording] = React.useState(false);
  // Sequence mode lets the user record N combos in a row (e.g. `ctrl+x ctrl+s`
  // or the legacy `escape escape`). When off the recorder behaves as before
  // — first valid combo wins, recording stops. Output combos are joined with
  // a single space so they're unambiguous to read.
  const [sequenceMode, setSequenceMode] = React.useState(false);

  React.useEffect(() => {
    if (!editing) setDraft(current);
  }, [current, editing]);

  const startEdit = (): void => {
    setDraft(current);
    setEditing(true);
    setSequenceMode(false);
  };
  const cancelEdit = (): void => {
    setRecording(false);
    setSequenceMode(false);
    setEditing(false);
    setDraft(current);
  };
  const saveEdit = (): void => {
    setRecording(false);
    setSequenceMode(false);
    setEditing(false);
    if (draft.trim() && draft.trim() !== current) onSave(draft);
  };

  const onRecordKey = (e: React.KeyboardEvent): void => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    if (sequenceMode) {
      // Append to draft with a space separator. Reset the visible draft
      // when the previous content was the placeholder (current value).
      setDraft((prev) => {
        const base = prev === current ? '' : prev.trim();
        return base ? `${base} ${combo}` : combo;
      });
      // Stay in recording mode so the user can keep chaining keys until
      // they click Stop / Salvar.
    } else {
      setDraft(combo);
      setRecording(false);
    }
  };

  return (
    <tr className="border-t border-border-subtle">
      <Td>
        <span className="font-mono text-[12px] text-text">{meta.action}</span>
      </Td>
      <Td>
        <span className="text-[12px] text-text-soft">{meta.description}</span>
      </Td>
      <Td>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onRecordKey}
                placeholder={recording ? (sequenceMode ? 'Aperte teclas em sequência…' : 'Pressione…') : meta.defaultCombo}
                className={clsx(
                  'w-full rounded border px-2 py-1 font-mono text-[12px] outline-none transition-colors',
                  recording
                    ? 'border-primary bg-primary/10 text-text'
                    : 'border-border-subtle bg-surface-2 text-text',
                )}
              />
              <button
                type="button"
                onClick={() => {
                  if (recording) {
                    setRecording(false);
                  } else {
                    if (sequenceMode) setDraft('');
                    setRecording(true);
                  }
                }}
                className={clsx(
                  'shrink-0 rounded border px-2 py-1 text-[10.5px] uppercase transition-colors',
                  recording
                    ? 'border-danger/40 bg-danger/15 text-danger'
                    : 'border-border-subtle bg-surface-2 text-text-soft hover:bg-surface-3',
                )}
                title="Gravar combo apertando teclas"
              >
                {recording ? 'Stop' : 'Gravar'}
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-[10.5px] text-dim-soft">
              <input
                type="checkbox"
                checked={sequenceMode}
                onChange={(e) => {
                  setSequenceMode(e.target.checked);
                  // Cancel any active recording when toggling — the semantic
                  // changes mid-recording would be confusing.
                  setRecording(false);
                }}
                className="h-3 w-3 cursor-pointer accent-primary"
              />
              Sequência (chord) — encadeia múltiplos combos com espaço (<code>escape escape</code>, <code>ctrl+x ctrl+s</code>)
            </label>
          </div>
        ) : (
          <code
            className={clsx(
              'inline-block rounded bg-surface-2 px-2 py-1 font-mono text-[12px]',
              isDefault ? 'text-text-soft' : 'text-accent',
            )}
          >
            {current}
          </code>
        )}
      </Td>
      <Td>
        {editing ? (
          <div className="flex items-center gap-1">
            <IconBtn title="Salvar" onClick={saveEdit} disabled={saving}>
              <Save size={12} />
            </IconBtn>
            <IconBtn title="Cancelar" onClick={cancelEdit}>
              <X size={12} />
            </IconBtn>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <IconBtn title="Editar" onClick={startEdit}>
              <Pencil size={12} />
            </IconBtn>
            {!isDefault && (
              <IconBtn title="Restaurar default" onClick={onReset} disabled={saving}>
                <RotateCcw size={12} />
              </IconBtn>
            )}
          </div>
        )}
      </Td>
    </tr>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function comboFromEvent(e: React.KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('cmd');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = e.key.toLowerCase();
  if (['control', 'meta', 'alt', 'shift'].includes(k)) return '';
  const named: Record<string, string> = {
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    ' ': 'space',
    escape: 'escape',
    enter: 'enter',
    tab: 'tab',
    backspace: 'backspace',
    delete: 'delete',
  };
  parts.push(named[k] ?? k);
  return parts.join('+');
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
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
  return (
    <td className={clsx('px-3 py-2 align-middle', className)}>{children}</td>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded p-1.5 text-dim-soft transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
