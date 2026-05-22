import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  RefreshCw,
  Download,
  TrendingUp,
  Database,
  Zap,
  Calendar,
  ChevronDown,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { usageApi } from '../ipc/client';
import type {
  UsageAggregateDTO,
  UsageHeatmapDTO,
  UsageHeatmapDayDTO,
  UsageMonthDTO,
  ModelStatDTO,
  UsageCsvKind,
} from '@shared/types';

type WindowChoice = 30 | 90 | 365;

const WINDOW_OPTIONS: Array<{ value: WindowChoice; label: string }> = [
  { value: 30, label: '30 d' },
  { value: 90, label: '90 d' },
  { value: 365, label: 'Ano' },
];

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function formatUSD(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function UsagePage(): React.ReactElement {
  const qc = useQueryClient();
  const [daysWindow, setDaysWindow] = React.useState<WindowChoice>(90);

  const aggregateQuery = useQuery<UsageAggregateDTO>({
    queryKey: ['usage', 'aggregate'],
    queryFn: () => usageApi.aggregate(),
    staleTime: 30_000,
  });
  const heatmapQuery = useQuery<UsageHeatmapDTO>({
    queryKey: ['usage', 'heatmap', daysWindow],
    queryFn: () => usageApi.heatmap(daysWindow),
    staleTime: 30_000,
  });

  const exportMut = useMutation({
    mutationFn: (kind: UsageCsvKind) => usageApi.exportCsv({ kind, daysWindow }),
    onSuccess: (res) => {
      if (res.cancelled) return;
      toast.success(`CSV salvo (${(res.bytes / 1024).toFixed(1)} KB) — ${res.filePath}`);
    },
    onError: (e: any) => toast.error(`Falha export: ${e?.message ?? e}`),
  });

  const refresh = (): void => {
    qc.invalidateQueries({ queryKey: ['usage'] });
  };

  const data = aggregateQuery.data;
  const heatmap = heatmapQuery.data;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Uso e custo</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={aggregateQuery.isFetching}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
          >
            <RefreshCw size={12} className={aggregateQuery.isFetching ? 'animate-spin' : ''} />
            Atualizar
          </button>
          <ExportMenu
            disabled={exportMut.isPending || !data}
            onExport={(kind) => exportMut.mutate(kind)}
            isPending={exportMut.isPending}
          />
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {/* ── Top totals strip ─────────────────────────────────────────── */}
        <div className="border-b border-border-subtle bg-surface-1/40 px-6 py-3">
          {data ? (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[12.5px]">
              <span className="text-dim-soft">Total:</span>
              <span className="font-semibold text-text">{formatTokens(data.totalTokens)} tokens</span>
              <span className="text-dim-soft">·</span>
              <span className="text-text-soft">{data.totalSessions.toLocaleString()} sessões</span>
              <span className="text-dim-soft">·</span>
              <span className="text-text-soft">{data.totalEvents.toLocaleString()} eventos</span>
              <span className="text-dim-soft">·</span>
              <span className="font-semibold text-warning">{formatUSD(data.totalCostUSD)}</span>
              <span className="text-dim-soft">·</span>
              <span className="text-text-soft">
                {data.firstDate} → {data.lastDate}
              </span>
            </div>
          ) : (
            <div className="text-[12px] text-dim-soft">
              {aggregateQuery.isLoading ? 'Carregando…' : 'Sem dados.'}
            </div>
          )}
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ── Cards: Streaks, Cache, Insights ──────────────────────── */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <StatCard
              icon={<TrendingUp size={14} className="text-success" />}
              title="Streak"
              value={data ? `${data.streaks.current}d` : '—'}
              hints={data ? [
                `Recorde: ${data.streaks.longest}d`,
                `${data.streaks.activeDays}/${data.streaks.totalDays} dias ativos`,
              ] : []}
            />
            <StatCard
              icon={<Database size={14} className="text-secondary" />}
              title="Cache hit (global)"
              value={data ? formatPercent(data.cacheHitRatioGlobal) : '—'}
              hints={data ? [
                `${formatTokens(data.totalCacheReads)} reads`,
                `${formatTokens(data.totalCacheWrites)} writes`,
              ] : []}
            />
            <StatCard
              icon={<Zap size={14} className="text-warning" />}
              title="Mais ativo"
              value={data?.streaks.mostActiveDay ?? '—'}
              hints={data ? [
                `${data.streaks.mostActiveDayEvents} eventos`,
                data.favoriteModel ? `Favorito: ${data.favoriteModel}` : '',
                `Sessão maior: ${formatDuration(data.longestSessionMs)}`,
              ].filter(Boolean) : []}
            />
          </div>

          {/* ── Heatmap ──────────────────────────────────────────────── */}
          <Section
            title="Heatmap"
            right={
              <div className="flex gap-1">
                {WINDOW_OPTIONS.map((w) => (
                  <button
                    key={w.value}
                    type="button"
                    onClick={() => setDaysWindow(w.value)}
                    className={clsx(
                      'rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em] transition-colors',
                      daysWindow === w.value
                        ? 'bg-primary/15 text-primary'
                        : 'text-dim-soft hover:bg-surface-3 hover:text-text',
                    )}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            }
          >
            {heatmap ? (
              <Heatmap data={heatmap} />
            ) : (
              <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12px] text-dim/70">
                {heatmapQuery.isLoading ? 'Carregando…' : 'Sem dados na janela.'}
              </div>
            )}
          </Section>

          {/* ── Models breakdown ─────────────────────────────────────── */}
          <Section title="Modelos">
            {data && data.models.length > 0 ? (
              <ModelsTable models={data.models} />
            ) : (
              <EmptyState message="Nenhum modelo registrado ainda." />
            )}
          </Section>

          {/* ── Monthly comparison (collapsible) ─────────────────────── */}
          <details className="rounded-md border border-border-subtle bg-surface-1/30">
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-[13px] font-semibold text-text hover:bg-surface-2">
              <Calendar size={13} className="text-dim-soft" />
              Comparação mensal
              <ChevronDown size={13} className="ml-auto text-dim-soft" />
            </summary>
            <div className="border-t border-border-subtle px-4 py-3">
              {data && data.months.length > 0 ? (
                <MonthsTable months={data.months} />
              ) : (
                <EmptyState message="Sem histórico mensal." />
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13.5px] font-semibold text-text">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  icon,
  title,
  value,
  hints,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  hints: string[];
}): React.ReactElement {
  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
        {icon}
        {title}
      </div>
      <div className="mt-1 font-mono text-[20px] font-semibold text-text">{value}</div>
      {hints.length > 0 && (
        <div className="mt-1 space-y-0.5 text-[11px] text-dim-soft">
          {hints.map((h, i) => <div key={i}>{h}</div>)}
        </div>
      )}
    </div>
  );
}

function Heatmap({ data }: { data: UsageHeatmapDTO }): React.ReactElement {
  // Estilo GitHub: linhas Dom..Sáb, colunas = semanas. Pad inicial pra
  // começar no domingo + label dos meses no topo + Seg/Qua/Sex à esquerda.
  const days = data.days;
  if (days.length === 0) {
    return <EmptyState message="Sem atividade nesta janela." />;
  }

  const byDate = new Map<string, UsageHeatmapDayDTO>();
  for (const d of days) byDate.set(d.date, d);

  const start = new Date(days[0].date + 'T00:00:00');
  const end = new Date(days[days.length - 1].date + 'T00:00:00');

  // Cells contíguas, padded pra começar num domingo.
  const cells: Array<UsageHeatmapDayDTO | null> = [];
  const padStart = start.getDay(); // 0=Sun..6=Sat
  for (let i = 0; i < padStart; i++) cells.push(null);
  for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
    const iso = cur.toISOString().slice(0, 10);
    cells.push(byDate.get(iso) ?? { date: iso, tokens: 0, events: 0, level: 0 });
  }

  // Colunas = semanas.
  const cols: Array<Array<UsageHeatmapDayDTO | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7));
  }

  // Labels dos meses: pra cada coluna, se o primeiro dia "real" (não null)
  // for o início do mês ou primeira aparição do mês, mostramos o label.
  const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const monthHeaders: Array<{ col: number; label: string }> = [];
  let prevMonth = -1;
  cols.forEach((col, ci) => {
    const firstReal = col.find((c) => c !== null) as UsageHeatmapDayDTO | undefined;
    if (!firstReal) return;
    const m = new Date(firstReal.date + 'T00:00:00').getMonth();
    if (m !== prevMonth) {
      monthHeaders.push({ col: ci, label: MONTH_LABELS[m] });
      prevMonth = m;
    }
  });

  // Totais agregados pra mostrar no header (estilo "X execuções no período").
  const totalEvents = days.reduce((sum, d) => sum + d.events, 0);
  const totalTokens = days.reduce((sum, d) => sum + d.tokens, 0);
  const activeDays = days.filter((d) => d.events > 0).length;

  // Verde GitHub-like (sobreposto a dark): tons crescentes de #1f6f3f→#39d353
  const levelClass: Record<number, string> = {
    0: 'bg-surface-3/30',
    1: 'bg-success/20',
    2: 'bg-success/45',
    3: 'bg-success/70',
    4: 'bg-success',
  };

  const CELL = 11; // px
  const GAP = 3;
  const STEP = CELL + GAP;
  const LABEL_W = 28; // espaço pros labels Seg/Qua/Sex à esquerda

  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/30 p-3">
      {/* Header com totais — substitui o "3,238 contributions in the last year" do GitHub */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div className="text-[14px] font-semibold text-text">
          {totalEvents.toLocaleString('pt-BR')}{' '}
          {totalEvents === 1 ? 'execução' : 'execuções'}
        </div>
        <div className="text-[11.5px] text-dim-soft">
          {activeDays}{' '}
          {activeDays === 1 ? 'dia ativo' : 'dias ativos'}
          <span className="mx-2 text-dim/40">·</span>
          {formatTokens(totalTokens)} tokens
          <span className="mx-2 text-dim/40">·</span>
          janela de {data.daysWindow}d
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="inline-block min-w-full">
          {/* Linha de meses */}
          <div className="relative" style={{ height: 14, marginLeft: LABEL_W }}>
            {monthHeaders.map(({ col, label }) => (
              <span
                key={`${col}-${label}`}
                className="absolute text-[10px] font-medium text-dim-soft"
                style={{ left: col * STEP }}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Grid: labels à esquerda + colunas */}
          <div className="flex">
            {/* Labels dos dias da semana — mostra Seg/Qua/Sex como o GitHub */}
            <div
              className="flex flex-col text-[10px] text-dim-soft"
              style={{ gap: GAP, width: LABEL_W }}
            >
              {['', 'Seg', '', 'Qua', '', 'Sex', ''].map((lbl, i) => (
                <div
                  key={i}
                  style={{ height: CELL, lineHeight: `${CELL}px` }}
                  className="pr-2 text-right"
                >
                  {lbl}
                </div>
              ))}
            </div>

            {/* Colunas (uma por semana) */}
            <div className="flex" style={{ gap: GAP }}>
              {cols.map((col, ci) => (
                <div key={ci} className="flex flex-col" style={{ gap: GAP }}>
                  {col.map((cell, ri) => (
                    <div
                      key={ri}
                      title={
                        cell
                          ? `${formatHeatmapDate(cell.date)} · ${formatTokens(cell.tokens)} tokens · ${cell.events} ${cell.events === 1 ? 'execução' : 'execuções'}`
                          : ''
                      }
                      style={{ width: CELL, height: CELL }}
                      className={clsx(
                        'rounded-[2px] transition-transform hover:ring-1 hover:ring-text/30',
                        cell ? levelClass[cell.level] : 'bg-transparent',
                      )}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-[10.5px] text-dim-soft">
        <span className="ml-auto">Menos</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <div
            key={l}
            style={{ width: CELL, height: CELL }}
            className={clsx('rounded-[2px]', levelClass[l])}
          />
        ))}
        <span>Mais</span>
      </div>
    </div>
  );
}

/** Formata 2026-05-04 → "04 de mai 2026" pro tooltip. */
function formatHeatmapDate(iso: string): string {
  const t = Date.parse(iso + 'T00:00:00');
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function ModelsTable({ models }: { models: ModelStatDTO[] }): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <table className="w-full">
        <thead className="bg-surface-2">
          <tr>
            <Th>Modelo</Th>
            <Th>Provider</Th>
            <Th className="text-right">Tokens (in/out)</Th>
            <Th className="text-right">Cache</Th>
            <Th className="text-right">Custo</Th>
            <Th className="w-[180px]">% do total</Th>
          </tr>
        </thead>
        <tbody>
          {models.map((m, i) => (
            <tr key={i} className="border-t border-border-subtle">
              <Td>
                <span className="font-mono text-[12px] text-text">{m.model}</span>
              </Td>
              <Td>
                <span className="text-[11.5px] text-dim-soft">{m.provider}</span>
              </Td>
              <Td className="text-right font-mono text-[11.5px] text-text-soft">
                {formatTokens(m.tokensIn)} / {formatTokens(m.tokensOut)}
              </Td>
              <Td className="text-right font-mono text-[11.5px] text-secondary">
                {formatPercent(m.cacheHitRatio)}
              </Td>
              <Td className="text-right font-mono text-[12px] text-warning">
                {formatUSD(m.costUSD)}
              </Td>
              <Td>
                <PercentBar percent={m.percentOfTotal} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthsTable({ months }: { months: UsageMonthDTO[] }): React.ReactElement {
  const max = months.reduce((m, x) => Math.max(m, x.tokens), 1);
  return (
    <div className="space-y-1.5">
      {months.map((m) => (
        <div key={m.month} className="grid grid-cols-[80px_1fr_80px_60px] items-center gap-3 text-[12px]">
          <span className="font-mono text-text-soft">{m.month}</span>
          <div className="h-3 rounded bg-surface-3/40">
            <div
              className="h-3 rounded bg-primary/60"
              style={{ width: `${(m.tokens / max) * 100}%` }}
            />
          </div>
          <span className="text-right font-mono text-text-soft">{formatTokens(m.tokens)}</span>
          <span className="text-right font-mono text-warning">{formatUSD(m.costUSD)}</span>
        </div>
      ))}
    </div>
  );
}

function PercentBar({ percent }: { percent: number }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded bg-surface-3/40">
        <div
          className="h-2 rounded bg-primary"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <span className="w-[44px] text-right font-mono text-[10.5px] text-dim-soft">
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}

function ExportMenu({
  disabled,
  onExport,
  isPending,
}: {
  disabled: boolean;
  onExport: (kind: UsageCsvKind) => void;
  isPending: boolean;
}): React.ReactElement {
  // Lightweight popover (clique abre/fecha) — não usa Radix pra manter
  // a página leve. Fecha quando o usuário clica fora.
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
      >
        <Download size={12} />
        {isPending ? 'Exportando…' : 'Export CSV'}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-[200px] rounded-md border border-border-subtle bg-surface-1 shadow-lg">
          {(['daily', 'models', 'all'] as UsageCsvKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => { setOpen(false); onExport(kind); }}
              className="flex w-full items-center justify-between px-3 py-2 text-[12.5px] text-text-soft hover:bg-surface-2 hover:text-text"
            >
              <span>
                {kind === 'daily' && 'Diário'}
                {kind === 'models' && 'Modelos'}
                {kind === 'all' && 'Tudo'}
              </span>
              <span className="font-mono text-[10.5px] text-dim/80">.csv</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }): React.ReactElement {
  return (
    <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12px] text-dim/70">
      {message}
    </div>
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
