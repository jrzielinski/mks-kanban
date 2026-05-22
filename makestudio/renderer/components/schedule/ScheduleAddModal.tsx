import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  X,
  AlarmClock,
  AlertTriangle,
  Info,
  Clock,
  Calendar,
  CalendarDays,
  Repeat,
  Code2,
  CalendarRange,
} from 'lucide-react';
import clsx from 'clsx';
import { scheduleApi } from '../../ipc/client';
import { humanCron } from '../../utils/humanCron';
import type { ScheduleDTO } from '@shared/types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Quando presente, abre em modo edit; ausente => modo create. */
  initial?: ScheduleDTO | null;
}

// ─── Schedule spec model ────────────────────────────────────────────────
//
// O usuário interage com um modelo estruturado (frequência + parâmetros);
// a expressão cron é gerada a partir dele. Apenas o modo "Avançado" expõe
// a expressão raw. Em edição, parseamos o cron existente de volta pro modelo
// se ele bater num pattern conhecido — caso contrário cai em "Avançado".

type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'every' | 'cron';

interface ScheduleSpec {
  frequency: Frequency;
  /** "HH:MM" para daily/weekly/monthly. */
  time: string;
  /** Minuto da hora (0-59) pra "A cada hora". */
  hourlyMinute: number;
  /** Dias da semana (0=Domingo .. 6=Sábado) pra "Toda semana". */
  weekdays: Set<number>;
  /** Dia do mês (1-31) pra "Todo mês". */
  monthDay: number;
  /** Intervalo numérico pra "A cada N min/h". */
  everyN: number;
  everyUnit: 'minute' | 'hour';
  /** Expressão raw do modo "Avançado". */
  rawCron: string;
}

const DEFAULT_SPEC: ScheduleSpec = {
  frequency: 'daily',
  time: '09:00',
  hourlyMinute: 0,
  weekdays: new Set([1, 2, 3, 4, 5]),
  monthDay: 1,
  everyN: 15,
  everyUnit: 'minute',
  rawCron: '0 9 * * *',
};

const DAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0, dom: 0,
  mon: 1, monday: 1, seg: 1,
  tue: 2, tuesday: 2, ter: 2,
  wed: 3, wednesday: 3, qua: 3,
  thu: 4, thursday: 4, qui: 4,
  fri: 5, friday: 5, sex: 5,
  sat: 6, saturday: 6, sab: 6,
};

function parseDayToken(tok: string): number | null {
  const t = tok.trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n >= 0 && n <= 7 ? (n === 7 ? 0 : n) : null;
  }
  return DAY_ALIASES[t] ?? null;
}

function buildCron(s: ScheduleSpec): string {
  const [hStr, mStr] = s.time.split(':');
  const h = parseInt(hStr || '0', 10);
  const m = parseInt(mStr || '0', 10);
  switch (s.frequency) {
    case 'hourly':
      return `${s.hourlyMinute} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly': {
      const days = [...s.weekdays].sort((a, b) => a - b).join(',') || '*';
      return `${m} ${h} * * ${days}`;
    }
    case 'monthly':
      return `${m} ${h} ${s.monthDay} * *`;
    case 'every':
      return s.everyUnit === 'minute'
        ? `*/${s.everyN} * * * *`
        : `0 */${s.everyN} * * *`;
    case 'cron':
      return s.rawCron;
  }
}

function parseCron(cron: string): ScheduleSpec {
  const trimmed = cron.trim();
  const fallback: ScheduleSpec = { ...DEFAULT_SPEC, frequency: 'cron', rawCron: trimmed };

  // Macros — convertemos em modos friendly equivalentes.
  switch (trimmed) {
    case '@hourly':
      return { ...DEFAULT_SPEC, frequency: 'hourly', hourlyMinute: 0, rawCron: trimmed };
    case '@daily':
    case '@midnight':
      return { ...DEFAULT_SPEC, frequency: 'daily', time: '00:00', rawCron: trimmed };
    case '@weekly':
      return { ...DEFAULT_SPEC, frequency: 'weekly', time: '00:00', weekdays: new Set([0]), rawCron: trimmed };
    case '@monthly':
      return { ...DEFAULT_SPEC, frequency: 'monthly', time: '00:00', monthDay: 1, rawCron: trimmed };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [m, h, dom, mon, dow] = parts;
  const pad2 = (n: string): string => n.padStart(2, '0');

  // every N min: */N * * * *
  const everyMin = m.match(/^\*\/(\d+)$/);
  if (everyMin && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_SPEC, frequency: 'every', everyN: parseInt(everyMin[1], 10), everyUnit: 'minute', rawCron: trimmed };
  }
  // every N hours: 0 */N * * *
  const everyHour = h.match(/^\*\/(\d+)$/);
  if (m === '0' && everyHour && dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_SPEC, frequency: 'every', everyN: parseInt(everyHour[1], 10), everyUnit: 'hour', rawCron: trimmed };
  }
  // hourly with minute: M * * * *
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_SPEC, frequency: 'hourly', hourlyMinute: parseInt(m, 10), rawCron: trimmed };
  }
  // daily: M H * * *
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_SPEC, frequency: 'daily', time: `${pad2(h)}:${pad2(m)}`, rawCron: trimmed };
  }
  // weekly: M H * * D[,D...]
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow !== '*') {
    const tokens = dow.split(',').map((t) => parseDayToken(t));
    if (tokens.every((t) => t !== null)) {
      return {
        ...DEFAULT_SPEC,
        frequency: 'weekly',
        time: `${pad2(h)}:${pad2(m)}`,
        weekdays: new Set(tokens as number[]),
        rawCron: trimmed,
      };
    }
  }
  // monthly: M H D * *
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    return {
      ...DEFAULT_SPEC,
      frequency: 'monthly',
      time: `${pad2(h)}:${pad2(m)}`,
      monthDay: parseInt(dom, 10),
      rawCron: trimmed,
    };
  }

  return fallback;
}

// ─── Component ──────────────────────────────────────────────────────────

export function ScheduleAddModal({
  open,
  onOpenChange,
  initial,
}: Props): React.ReactElement {
  const qc = useQueryClient();
  const isEdit = !!initial;

  const [name, setName] = React.useState('');
  const [command, setCommand] = React.useState('');
  const [spec, setSpec] = React.useState<ScheduleSpec>(DEFAULT_SPEC);
  const [error, setError] = React.useState<string | null>(null);

  // Reset/seed quando abre.
  React.useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setCommand(initial.command);
      setSpec(parseCron(initial.cron));
    } else {
      setName('');
      setCommand('');
      setSpec(DEFAULT_SPEC);
    }
    setError(null);
  }, [open, initial]);

  // Cron derivado da spec — se modo "cron", usa o raw direto; senão builda.
  const cron = React.useMemo(
    () => (spec.frequency === 'cron' ? spec.rawCron : buildCron(spec)),
    [spec],
  );

  const addMut = useMutation({
    mutationFn: (args: { name: string; cron: string; command: string }) =>
      scheduleApi.add(args),
    onSuccess: (res) => {
      if (res.ok) {
        qc.invalidateQueries({ queryKey: ['schedule', 'list'] });
        onOpenChange(false);
      } else {
        setError(res.error ?? 'erro desconhecido');
      }
    },
  });

  const updateMut = useMutation({
    mutationFn: (args: { id: string; patch: Partial<ScheduleDTO> }) =>
      scheduleApi.update(args.id, args.patch),
    onSuccess: (res) => {
      if (res.ok) {
        qc.invalidateQueries({ queryKey: ['schedule', 'list'] });
        onOpenChange(false);
      } else {
        setError(res.error ?? 'erro desconhecido');
      }
    },
  });

  const valid = isValidName(name) && command.trim().length > 0 && cron.trim().length > 0;

  const submit = (): void => {
    setError(null);
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (isEdit && initial) {
      updateMut.mutate({
        id: initial.id,
        patch: {
          name: trimmedName,
          command: trimmedCommand,
          cron: cron.trim(),
        },
      });
    } else {
      addMut.mutate({
        name: trimmedName,
        command: trimmedCommand,
        cron: cron.trim(),
      });
    }
  };

  const loading = addMut.isPending || updateMut.isPending;
  const isSlash = command.trim().startsWith('/');

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[680px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
          <div className="mb-4 flex items-center gap-2">
            <AlarmClock size={14} className="text-secondary" />
            <Dialog.Title className="text-[14px] font-semibold text-text">
              {isEdit ? 'Editar schedule' : 'Novo schedule'}
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

          {/* Nome */}
          <div className="mb-3">
            <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-dim/80">
              Nome
            </label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nightly-audit"
              className="block w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-[13px] text-text placeholder:text-dim/70 focus:border-primary/50 focus:outline-none"
            />
            {!isValidName(name) && name.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-warning">
                <AlertTriangle size={11} />
                Use letras, números, traço ou underscore (1-40 chars).
              </div>
            )}
          </div>

          {/* Comando */}
          <div className="mb-4">
            <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-dim/80">
              Comando
            </label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/analyze --audit  ou  bash -c 'echo hi'"
              className="block w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-[13px] text-text placeholder:text-dim/70 focus:border-primary/50 focus:outline-none"
            />
            {isSlash && (
              <div className="mt-1.5 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/8 px-2 py-1.5 text-[11px] text-warning">
                <Info size={11} className="mt-0.5 shrink-0" />
                <span>
                  Slash commands rodam apenas via poller interno (Electron
                  aberto). O daemon pula slash commands silenciosamente.
                </span>
              </div>
            )}
          </div>

          {/* Quando rodar — schedule builder estruturado */}
          <div className="mb-3">
            <label className="mb-2 block text-[11px] uppercase tracking-[0.1em] text-dim/80">
              Quando rodar?
            </label>
            <FrequencyPicker
              value={spec.frequency}
              onChange={(f) => setSpec((s) => ({ ...s, frequency: f }))}
            />
            <div className="mt-3 rounded-md border border-border-subtle/60 bg-surface-2/40 p-3">
              <FrequencyFields spec={spec} setSpec={setSpec} />
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-text-soft">
              <Info size={11} className="shrink-0 text-dim" />
              <span>{humanCron(cron) || cron}</span>
              {spec.frequency !== 'cron' && (
                <span className="ml-auto font-mono text-[10.5px] text-dim/70">
                  cron: {cron}
                </span>
              )}
            </div>
          </div>

          {/* Preview */}
          <NextRunsPreview cron={cron} />

          {error && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}

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
              onClick={submit}
              disabled={!valid || loading}
              className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Salvando…' : isEdit ? 'Salvar' : 'Criar schedule'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Frequency picker (segmented bar) ───────────────────────────────────

interface FrequencyTab {
  key: Frequency;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

const FREQUENCY_TABS: FrequencyTab[] = [
  { key: 'hourly', label: 'A cada hora', icon: Clock },
  { key: 'daily', label: 'Todo dia', icon: Calendar },
  { key: 'weekly', label: 'Toda semana', icon: CalendarDays },
  { key: 'monthly', label: 'Todo mês', icon: CalendarRange },
  { key: 'every', label: 'Personalizado', icon: Repeat },
  { key: 'cron', label: 'Avançado', icon: Code2 },
];

function FrequencyPicker({
  value,
  onChange,
}: {
  value: Frequency;
  onChange: (f: Frequency) => void;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
      {FREQUENCY_TABS.map(({ key, label, icon: Icon }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={clsx(
              'flex flex-col items-center justify-center gap-1 rounded-md border px-2 py-2 transition-colors',
              active
                ? 'border-primary/50 bg-primary/12 text-primary'
                : 'border-border-subtle bg-surface-2 text-text-soft hover:bg-surface-3',
            )}
            aria-pressed={active}
          >
            <Icon size={14} strokeWidth={1.8} />
            <span className="text-[11px] font-medium leading-tight">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Frequency-specific fields ──────────────────────────────────────────

const WEEKDAY_LABELS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']; // Sun..Sat
const WEEKDAY_FULL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function FrequencyFields({
  spec,
  setSpec,
}: {
  spec: ScheduleSpec;
  setSpec: React.Dispatch<React.SetStateAction<ScheduleSpec>>;
}): React.ReactElement {
  switch (spec.frequency) {
    case 'hourly':
      return (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-soft">
          <span>Aos</span>
          <NumberInput
            value={spec.hourlyMinute}
            onChange={(n) => setSpec((s) => ({ ...s, hourlyMinute: clampInt(n, 0, 59) }))}
            min={0}
            max={59}
            width="w-[70px]"
          />
          <span>minutos da hora</span>
          <span className="text-dim/70">— ex.: aos 30 min, dispara 00:30, 01:30, 02:30…</span>
        </div>
      );
    case 'daily':
      return (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-soft">
          <span>Às</span>
          <TimeInput
            value={spec.time}
            onChange={(t) => setSpec((s) => ({ ...s, time: t }))}
          />
          <span className="text-dim/70">— todo dia, sem exceção</span>
        </div>
      );
    case 'weekly':
      return (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-dim/70">
              Dias da semana
            </div>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_LABELS.map((short, idx) => {
                const checked = spec.weekdays.has(idx);
                return (
                  <button
                    key={idx}
                    type="button"
                    title={WEEKDAY_FULL[idx]}
                    onClick={() => {
                      setSpec((s) => {
                        const next = new Set(s.weekdays);
                        if (next.has(idx)) next.delete(idx);
                        else next.add(idx);
                        return { ...s, weekdays: next };
                      });
                    }}
                    className={clsx(
                      'flex h-9 w-9 items-center justify-center rounded-md border text-[12px] font-semibold transition-colors',
                      checked
                        ? 'border-primary/50 bg-primary/15 text-primary'
                        : 'border-border-subtle bg-surface-2 text-text-soft hover:bg-surface-3',
                    )}
                    aria-pressed={checked}
                  >
                    {short}
                  </button>
                );
              })}
              <div className="ml-2 flex items-center gap-1.5 text-[11px] text-dim">
                <button
                  type="button"
                  onClick={() => setSpec((s) => ({ ...s, weekdays: new Set([1, 2, 3, 4, 5]) }))}
                  className="rounded px-2 py-1 hover:bg-surface-3 hover:text-text-soft"
                >
                  dias úteis
                </button>
                <button
                  type="button"
                  onClick={() => setSpec((s) => ({ ...s, weekdays: new Set([0, 6]) }))}
                  className="rounded px-2 py-1 hover:bg-surface-3 hover:text-text-soft"
                >
                  fim de semana
                </button>
                <button
                  type="button"
                  onClick={() => setSpec((s) => ({ ...s, weekdays: new Set([0, 1, 2, 3, 4, 5, 6]) }))}
                  className="rounded px-2 py-1 hover:bg-surface-3 hover:text-text-soft"
                >
                  todos
                </button>
              </div>
            </div>
            {spec.weekdays.size === 0 && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-warning">
                <AlertTriangle size={11} /> Selecione pelo menos um dia.
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-text-soft">
            <span>Às</span>
            <TimeInput
              value={spec.time}
              onChange={(t) => setSpec((s) => ({ ...s, time: t }))}
            />
          </div>
        </div>
      );
    case 'monthly':
      return (
        <div className="flex flex-col gap-2 text-[12.5px] text-text-soft">
          <div className="flex flex-wrap items-center gap-2">
            <span>Dia</span>
            <NumberInput
              value={spec.monthDay}
              onChange={(n) => setSpec((s) => ({ ...s, monthDay: clampInt(n, 1, 31) }))}
              min={1}
              max={31}
              width="w-[70px]"
            />
            <span>do mês, às</span>
            <TimeInput
              value={spec.time}
              onChange={(t) => setSpec((s) => ({ ...s, time: t }))}
            />
          </div>
          {spec.monthDay > 28 && (
            <div className="flex items-start gap-1.5 text-[11px] text-warning">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                Dias 29-31 podem não existir em todos os meses (Fevereiro, etc).
                A execução é pulada nos meses sem esse dia.
              </span>
            </div>
          )}
        </div>
      );
    case 'every':
      return (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-soft">
          <span>A cada</span>
          <NumberInput
            value={spec.everyN}
            onChange={(n) => {
              const max = spec.everyUnit === 'minute' ? 59 : 23;
              setSpec((s) => ({ ...s, everyN: clampInt(n, 1, max) }));
            }}
            min={1}
            max={spec.everyUnit === 'minute' ? 59 : 23}
            width="w-[80px]"
          />
          <select
            value={spec.everyUnit}
            onChange={(e) => {
              const unit = e.target.value as 'minute' | 'hour';
              const max = unit === 'minute' ? 59 : 23;
              setSpec((s) => ({ ...s, everyUnit: unit, everyN: Math.min(s.everyN, max) }));
            }}
            className="rounded-md border border-border-subtle bg-surface-2 px-2 py-1 text-[12.5px] text-text focus:border-primary/50 focus:outline-none"
          >
            <option value="minute">minutos</option>
            <option value="hour">horas</option>
          </select>
          <span className="text-dim/70">
            — começa no minuto/hora 0 e repete a partir daí
          </span>
        </div>
      );
    case 'cron':
      return (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={spec.rawCron}
            onChange={(e) => setSpec((s) => ({ ...s, rawCron: e.target.value }))}
            placeholder="0 2 * * *"
            className="block w-full rounded-md border border-border-subtle bg-surface-1 px-3 py-2 font-mono text-[13px] text-text placeholder:text-dim/70 focus:border-primary/50 focus:outline-none"
          />
          <div className="flex items-start gap-1.5 text-[11px] text-dim">
            <Info size={11} className="mt-0.5 shrink-0" />
            <span>
              Formato:{' '}
              <span className="font-mono text-text-soft">
                minuto hora dia-mês mês dia-semana
              </span>
              . Suporta também macros como{' '}
              <span className="font-mono text-text-soft">@hourly</span>,{' '}
              <span className="font-mono text-text-soft">@daily</span>,{' '}
              <span className="font-mono text-text-soft">@weekly</span>,{' '}
              <span className="font-mono text-text-soft">@monthly</span>.
            </span>
          </div>
        </div>
      );
  }
}

function TimeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-border-subtle bg-surface-1 px-2 py-1 font-mono text-[13px] text-text focus:border-primary/50 focus:outline-none"
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  width,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  width?: string;
}): React.ReactElement {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        onChange(Number.isNaN(n) ? min : n);
      }}
      min={min}
      max={max}
      className={clsx(
        'rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-center font-mono text-[13px] text-text focus:border-primary/50 focus:outline-none',
        width ?? 'w-[70px]',
      )}
    />
  );
}

function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ─── Preview de próximas execuções ──────────────────────────────────────

function NextRunsPreview({ cron }: { cron: string }): React.ReactElement {
  const [runs, setRuns] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!cron.trim()) {
      setRuns([]);
      setError(null);
      return;
    }
    const handle = window.setTimeout(async () => {
      setError(null);
      try {
        const acc: string[] = [];
        let from: string | undefined = undefined;
        for (let i = 0; i < 5; i++) {
          const res = await scheduleApi.next(cron, from);
          if (res.error || !res.nextRunAt) {
            if (!cancelled) {
              setError(res.error ?? 'cron inválido');
              setRuns([]);
            }
            return;
          }
          acc.push(res.nextRunAt);
          from = res.nextRunAt;
        }
        if (!cancelled) {
          setRuns(acc);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message ?? err));
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [cron]);

  if (error) {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-[12px] text-danger">
        <AlertTriangle size={11} className="mr-1.5 inline" />
        {error}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-subtle/60 bg-surface-2/40 px-3 py-2">
      <div className="mb-1 text-[10.5px] uppercase tracking-[0.1em] text-dim/80">
        Próximas 5 execuções
      </div>
      {runs.length === 0 && (
        <div className="text-[11.5px] text-dim-soft">Calculando…</div>
      )}
      <ul className="space-y-0.5">
        {runs.map((r) => (
          <li
            key={r}
            className="flex items-baseline gap-2 font-mono text-[11.5px] text-text-soft"
          >
            <span className="w-3 text-dim/60">•</span>
            <span>{formatDateTime(r)}</span>
            <span className="text-dim/70">({inFromNow(r)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Utils ──────────────────────────────────────────────────────────────

function isValidName(s: string): boolean {
  return /^[a-z0-9][a-z0-9-_]{0,39}$/i.test(s);
}

function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function inFromNow(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = t - Date.now();
  if (diff < 60_000) return 'em <1min';
  if (diff < 3_600_000) return `em ${Math.round(diff / 60_000)}min`;
  if (diff < 86_400_000) return `em ${Math.round(diff / 3_600_000)}h`;
  return `em ${Math.round(diff / 86_400_000)}d`;
}
