/**
 * UsageView — terminal dashboard for `/usage`.
 *
 * Ports the layout of Claude Code's Stats component to Ink without pulling in
 * asciichart/figures (not installed). The heatmap is rendered with a single
 * Unicode block character in five intensity tiers, coloured with Ink's Text
 * color prop. Two tabs (Overview, Models), three date filters (7d, 30d, All),
 * and keyboard nav via `r` (cycle dates), tab (switch tab), ESC (close).
 */

import * as React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  computeUsage,
  filterDaily,
  heatLevel,
  localDay,
  formatDuration,
  formatTokens,
  tokenComparison,
  UsageStats,
  DailyStat,
  ModelStat,
} from '../usage-aggregator';

type DateRange = '7d' | '30d' | 'all';
type Tab = 'overview' | 'models';

const HEAT_CHAR = '■';
// Orange heat palette matching Claude Code's look (empty → darkest → brightest).
const HEAT_COLORS = ['#3b2518', '#6b3a1f', '#a3551f', '#d97a2c', '#ff9744'] as const;

// Month labels for the 52-week heatmap header.
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

interface HeatWeek {
  monday: Date;
  cells: Array<{ date: string; tokens: number; level: number } | null>;
}

/** Build a 52-week grid of cells ending on today. Each week is 7 cells Mon..Sun. */
function buildHeatmapGrid(daily: DailyStat[], weeks: number): HeatWeek[] {
  const byDate = new Map(daily.map((d) => [d.date, d] as const));
  const max = daily.reduce((m, d) => Math.max(m, d.tokens), 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = (today.getDay() + 6) % 7; // Monday=0 .. Sunday=6
  // Rewind to the Monday of the current week.
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() - dayOfWeek);

  const out: HeatWeek[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const monday = new Date(currentMonday);
    monday.setDate(currentMonday.getDate() - w * 7);
    const cells: HeatWeek['cells'] = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(monday);
      cellDate.setDate(monday.getDate() + d);
      if (cellDate > today) { cells.push(null); continue; }
      const key = localDay(cellDate);
      const stat = byDate.get(key);
      cells.push({
        date: key,
        tokens: stat?.tokens || 0,
        level: stat ? heatLevel(stat.tokens, max) : 0,
      });
    }
    out.push({ monday, cells });
  }
  return out;
}

/** Evaluate where each month label should fall across the heatmap columns. */
function buildMonthHeader(weeks: HeatWeek[]): string {
  // Build a string length = weeks.length characters, with month abbreviation
  // printed at the column where a new month starts.
  const row: string[] = Array(weeks.length).fill(' ');
  let lastMonth = -1;
  for (let i = 0; i < weeks.length; i++) {
    const m = weeks[i].monday.getMonth();
    if (m !== lastMonth) {
      const label = MONTH_LABELS[m];
      // Only print if the full abbreviation fits before next week-slot.
      if (i + label.length <= weeks.length) {
        for (let k = 0; k < label.length; k++) row[i + k] = label[k];
      }
      lastMonth = m;
    }
  }
  return row.join('');
}

function Cards({ stats }: { stats: UsageStats }): React.ReactElement {
  const longestSession = stats.longestSessionMs > 0 ? formatDuration(stats.longestSessionMs) : '—';
  const mostActive = stats.mostActiveDay
    ? new Date(stats.mostActiveDay + 'T00:00:00').toLocaleDateString('pt-BR', { month: 'short', day: 'numeric' })
    : '—';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={30}>
          <Text color="#ff9744">Modelo favorito: </Text>
          <Text>{stats.favoriteModel || '—'}</Text>
        </Box>
        <Box>
          <Text color="#ff9744">Total de tokens: </Text>
          <Text>{formatTokens(stats.totalTokens)}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Box width={30}>
          <Text color="#ff9744">Sessões: </Text>
          <Text>{stats.totalSessions}</Text>
        </Box>
        <Box>
          <Text color="#ff9744">Sessão mais longa: </Text>
          <Text>{longestSession}</Text>
        </Box>
      </Box>
      <Box>
        <Box width={30}>
          <Text color="#ff9744">Dias ativos: </Text>
          <Text>{stats.activeDays}/{stats.totalDays}</Text>
        </Box>
        <Box>
          <Text color="#ff9744">Maior sequência: </Text>
          <Text>{stats.longestStreak} dias</Text>
        </Box>
      </Box>
      <Box>
        <Box width={30}>
          <Text color="#ff9744">Dia mais ativo: </Text>
          <Text>{mostActive}</Text>
        </Box>
        <Box>
          <Text color="#ff9744">Sequência atual: </Text>
          <Text>{stats.currentStreak} dias</Text>
        </Box>
      </Box>
    </Box>
  );
}

function Heatmap({ daily, weeks }: { daily: DailyStat[]; weeks: number }): React.ReactElement {
  const grid = buildHeatmapGrid(daily, weeks);
  const monthRow = buildMonthHeader(grid);
  const dayLabels = ['Seg', '', 'Qua', '', 'Sex', '', ''];

  // Render each day-row across all weeks.
  return (
    <Box flexDirection="column">
      <Box>
        <Text>    </Text>
        <Text color="#ff9744">{monthRow}</Text>
      </Box>
      {dayLabels.map((lbl, dayIdx) => (
        <Box key={dayIdx}>
          <Box width={4}><Text color="#ff9744">{lbl}</Text></Box>
          {grid.map((week, wIdx) => {
            const cell = week.cells[dayIdx];
            if (!cell) return <Text key={wIdx}> </Text>;
            return (
              <Text key={wIdx} color={HEAT_COLORS[cell.level]}>{HEAT_CHAR}</Text>
            );
          })}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text>Menos  </Text>
        {HEAT_COLORS.map((c, i) => <Text key={i} color={c}>{HEAT_CHAR}</Text>)}
        <Text>  Mais</Text>
      </Box>
    </Box>
  );
}

function OverviewTab({ stats, range }: { stats: UsageStats; range: DateRange }): React.ReactElement {
  const weeksMap: Record<DateRange, number> = { '7d': 2, '30d': 6, 'all': 52 };
  const weeks = weeksMap[range];
  const filtered = range === 'all' ? stats.daily : filterDaily(stats.daily, range === '7d' ? 7 : 30);

  const cmp = tokenComparison(stats.totalTokens);

  return (
    <Box flexDirection="column">
      <Heatmap daily={stats.daily} weeks={weeks} />
      <Box marginTop={1}>
        <Text color={range === 'all' ? '#ff9744' : undefined} bold={range === 'all'}>Todos </Text>
        <Text color="#6b7280">· </Text>
        <Text color={range === '7d' ? '#ff9744' : undefined} bold={range === '7d'}>Últimos 7 dias </Text>
        <Text color="#6b7280">· </Text>
        <Text color={range === '30d' ? '#ff9744' : undefined} bold={range === '30d'}>Últimos 30 dias</Text>
      </Box>
      <Cards stats={range === 'all' ? stats : { ...stats, daily: filtered }} />
      {cmp && (
        <Box marginTop={1}>
          <Text color="#ff9744">Você usou ~{cmp.factor}× mais tokens que </Text>
          <Text italic>{cmp.book}</Text>
        </Box>
      )}
    </Box>
  );
}

function ModelsTab({ stats, range }: { stats: UsageStats; range: DateRange }): React.ReactElement {
  // Re-aggregate from daily for the selected window.
  const windowDaily = range === 'all' ? stats.daily : filterDaily(stats.daily, range === '7d' ? 7 : 30);
  const windowTokens = windowDaily.reduce((s, d) => s + d.tokens, 0);

  const rows: Array<ModelStat & { pct: number }> = stats.models.map((m) => ({
    ...m,
    pct: windowTokens > 0 ? (m.tokensTotal / windowTokens) * 100 : 0,
  })).sort((a, b) => b.tokensTotal - a.tokensTotal).slice(0, 8);

  // Simple horizontal bar chart of tokens per day across the window.
  const maxDay = windowDaily.reduce((m, d) => Math.max(m, d.tokens), 0);
  const BAR = '█';

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {windowDaily.slice(-14).map((d) => {
          const pct = maxDay > 0 ? d.tokens / maxDay : 0;
          const barLen = Math.round(pct * 40);
          return (
            <Box key={d.date}>
              <Box width={12}><Text color="#6b7280">{d.date.slice(5)}</Text></Box>
              <Text color="#ff9744">{BAR.repeat(Math.max(0, barLen))}</Text>
              <Text color="#6b7280"> {formatTokens(d.tokens)}</Text>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="#ff9744">Breakdown por modelo</Text>
        {rows.map((m, i) => {
          // Composite key — same model name can appear under multiple
          // providers (e.g. deepseek-v4-flash routed via direct + via
          // backend), so `m.model` alone is not unique. Falling back to
          // index keeps the React reconciler happy when provider is
          // missing from older events.jsonl rows.
          const key = `${m.provider || 'unknown'}|${m.model}|${i}`;
          // Show provider in the line too, so the user sees why the same
          // model name appears more than once instead of looking duplicated.
          const label = m.provider && m.provider !== m.model
            ? `${m.model}  ${'·'} ${m.provider}`
            : m.model;
          return (
            <Box key={key}>
              <Box width={42}><Text>{label}</Text></Box>
              <Box width={30}>
                <Text color="#6b7280">{formatTokens(m.tokensIn)} in · {formatTokens(m.tokensOut)} out</Text>
              </Box>
              <Text color="#ff9744">{m.pct.toFixed(1)}%</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export function UsageView({ onClose }: { onClose: () => void }): React.ReactElement {
  const [stats] = React.useState<UsageStats>(() => computeUsage());
  const [range, setRange] = React.useState<DateRange>('all');
  const [tab, setTab] = React.useState<Tab>('overview');

  useInput((input, key) => {
    if (key.escape || input === 'q') { onClose(); return; }
    if (input === 'r') {
      setRange((r) => (r === 'all' ? '7d' : r === '7d' ? '30d' : 'all'));
      return;
    }
    if (key.tab || input === 't') {
      setTab((t) => (t === 'overview' ? 'models' : 'overview'));
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color={tab === 'overview' ? '#ff9744' : '#6b7280'} bold={tab === 'overview'}>Overview </Text>
        <Text color="#6b7280">· </Text>
        <Text color={tab === 'models' ? '#ff9744' : '#6b7280'} bold={tab === 'models'}>Modelos</Text>
      </Box>
      <Box marginTop={1}>
        {tab === 'overview' ? <OverviewTab stats={stats} range={range} /> : <ModelsTab stats={stats} range={range} />}
      </Box>
      <Box marginTop={1}>
        <Text color="#6b7280">r: mudar período · tab: alternar aba · ESC: fechar</Text>
      </Box>
    </Box>
  );
}
