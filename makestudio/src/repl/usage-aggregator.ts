import { swallow } from '../utils/log';
/**
 * usage-aggregator.ts — turns ~/.makestudio/events.jsonl into the numbers
 * shown by /usage: per-day heatmap, streaks, totals, favourite model, peak
 * day, longest session, comparison-to-book bytes.
 *
 * Session detection: events.jsonl has no session markers. We infer sessions
 * by gap: two consecutive events more than SESSION_GAP_MS apart belong to
 * different sessions. This matches what Claude Code does and approximates
 * what ~/.makestudio/sessions/ shows, without having to reconcile both
 * sources (sessions dir may have dev/test dirs that skew counts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { estimateCost } from './costs';

const EVENTS_FILE = path.join(os.homedir(), '.makestudio', 'events.jsonl');
const EVENTS_FILE_OLD = path.join(os.homedir(), '.makestudio', 'events.jsonl.old');

/** Two events more than this far apart start a new session. 30 min matches CC. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Heatmap intensity buckets — 0..4 where 0 is "inactive". */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface DailyStat {
  date: string;                // 'YYYY-MM-DD' in local TZ
  events: number;
  tokens: number;
  sessions: number;            // sessions that had at least one event on this day
}

export interface ModelStat {
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  events: number;
  /** Cumulative cache reads for this model (count of token_usage events). */
  cacheReads: number;
  cacheWrites: number;
  /** cacheReads / (tokensIn + cacheReads). 0 when denominator is 0. */
  cacheHitRatio: number;
  /** USD estimated via PRICING. 0 when the model isn't in the pricing table. */
  costUSD: number;
}

export interface UsageStats {
  totalEvents: number;
  totalTokens: number;
  totalSessions: number;
  activeDays: number;
  totalDays: number;            // span between first and last day (inclusive)
  firstDate: string | null;
  lastDate: string | null;

  // Streaks (consecutive days with at least one event).
  currentStreak: number;
  longestStreak: number;

  // Insights.
  favoriteModel: string | null;       // most-used (by total tokens)
  mostActiveDay: string | null;        // YYYY-MM-DD
  mostActiveDayEvents: number;
  longestSessionMs: number;            // longest single-session duration

  // Phase 10 — cost + cache aggregates.
  totalCacheReads: number;
  totalCacheWrites: number;
  /** Global ratio across all models — sum(cacheReads) / sum(promptTokens + cacheReads). */
  cacheHitRatioGlobal: number;
  /** USD estimated total. Sum of models[].costUSD. */
  totalCostUSD: number;

  // Raw daily series — consumers pick a window for the heatmap.
  daily: DailyStat[];
  // Per-model aggregate (Models tab).
  models: ModelStat[];
}

export interface MonthStat {
  month: string;          // YYYY-MM
  tokens: number;
  events: number;
  sessions: number;       // count of sessions that touched any day in this month
  costUSD: number;        // proportional from totalCostUSD by token share
}

/** Read both events.jsonl and its rotated predecessor, in chronological order. */
function loadEvents(): any[] {
  const out: any[] = [];
  for (const file of [EVENTS_FILE_OLD, EVENTS_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (err) { swallow(err); }
      }
    } catch (err) { swallow(err); }
  }
  return out;
}

/** YYYY-MM-DD of a timestamp in the user's local timezone. */
export function localDay(ts: string | number | Date): string {
  const d = typeof ts === 'string' || typeof ts === 'number' ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format a millisecond duration as "<d>d <h>h <m>m" (omitting zero parts). */
export function formatDuration(ms: number): string {
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

/** Format a token count as "123", "12.3k", "55.0m". Matches Claude Code's style. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/** Build the full UsageStats. Cached not worth it — full aggregation on our
 *  typical events.jsonl (~100k lines) takes under 100ms. */
export function computeUsage(): UsageStats {
  const events = loadEvents();

  const dailyMap = new Map<string, DailyStat>();
  const modelMap = new Map<string, ModelStat>();

  // Sessions: sort events by ts, split whenever gap > SESSION_GAP_MS.
  const byTs = events
    .map((e) => ({ ...e, _ts: Date.parse(e.ts) }))
    .filter((e) => Number.isFinite(e._ts))
    .sort((a, b) => a._ts - b._ts);

  const sessions: { start: number; end: number; days: Set<string> }[] = [];
  let currentSession: { start: number; end: number; days: Set<string> } | null = null;
  for (const e of byTs) {
    if (!currentSession || e._ts - currentSession.end > SESSION_GAP_MS) {
      if (currentSession) sessions.push(currentSession);
      currentSession = { start: e._ts, end: e._ts, days: new Set() };
    } else {
      currentSession.end = e._ts;
    }
    currentSession.days.add(localDay(e._ts));
  }
  if (currentSession) sessions.push(currentSession);

  // Aggregate per-day event + token counts.
  for (const e of byTs) {
    const day = localDay(e._ts);
    if (!dailyMap.has(day)) dailyMap.set(day, { date: day, events: 0, tokens: 0, sessions: 0 });
    const d = dailyMap.get(day)!;
    d.events += 1;
    if (e.type === 'token_usage') {
      const total = Number(e.totalTokens || e.promptTokens + e.completionTokens || 0) || 0;
      d.tokens += total;
      const key = `${e.provider || 'unknown'}::${e.model || 'unknown'}`;
      if (!modelMap.has(key)) {
        modelMap.set(key, {
          model: e.model || 'unknown',
          provider: e.provider || 'unknown',
          tokensIn: 0, tokensOut: 0, tokensTotal: 0, events: 0,
          cacheReads: 0, cacheWrites: 0, cacheHitRatio: 0, costUSD: 0,
        });
      }
      const m = modelMap.get(key)!;
      m.tokensIn += Number(e.promptTokens || 0);
      m.tokensOut += Number(e.completionTokens || 0);
      m.tokensTotal += total;
      m.events += 1;
      m.cacheReads += Number(e.cacheReads || 0);
      m.cacheWrites += Number(e.cacheWrites || 0);
    }
  }

  // Compute per-model cache ratio + USD cost in one pass after the reduce
  // — keeps the hot loop above focused on raw accumulation.
  for (const m of modelMap.values()) {
    const denom = m.tokensIn + m.cacheReads;
    m.cacheHitRatio = denom > 0 ? m.cacheReads / denom : 0;
    m.costUSD = estimateCost(m.model, m.tokensIn, m.tokensOut);
  }

  // Mark per-day session count (a session touches multiple days only if it
  // crosses midnight; for most users it's 1/day).
  for (const s of sessions) {
    for (const day of s.days) {
      const d = dailyMap.get(day);
      if (d) d.sessions += 1;
    }
  }

  // Sort daily chronologically.
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Active streaks.
  let currentStreak = 0;
  let longestStreak = 0;
  if (daily.length > 0) {
    let run = 1;
    longestStreak = 1;
    for (let i = 1; i < daily.length; i++) {
      const prev = new Date(daily[i - 1].date + 'T00:00:00').getTime();
      const cur = new Date(daily[i].date + 'T00:00:00').getTime();
      if (cur - prev === 86_400_000) {
        run += 1;
        longestStreak = Math.max(longestStreak, run);
      } else {
        run = 1;
      }
    }
    // currentStreak = run length ending on *today*, if today is active.
    const today = localDay(Date.now());
    const last = daily[daily.length - 1];
    const yesterday = localDay(Date.now() - 86_400_000);
    if (last.date === today) {
      currentStreak = run;
    } else if (last.date === yesterday) {
      currentStreak = run; // grace: yesterday's run still counts for "current"
    } else {
      currentStreak = 0;
    }
  }

  // Favorite model by total tokens.
  const models = Array.from(modelMap.values()).sort((a, b) => b.tokensTotal - a.tokensTotal);
  const favoriteModel = models[0]?.model ?? null;

  // Most active day by event count.
  let mostActiveDay: string | null = null;
  let mostActiveDayEvents = 0;
  for (const d of daily) {
    if (d.events > mostActiveDayEvents) {
      mostActiveDayEvents = d.events;
      mostActiveDay = d.date;
    }
  }

  // Longest session duration.
  const longestSessionMs = sessions.reduce((m, s) => Math.max(m, s.end - s.start), 0);

  const totalEvents = events.length;
  const totalTokens = daily.reduce((sum, d) => sum + d.tokens, 0);
  const totalSessions = sessions.length;
  const activeDays = daily.length;
  const firstDate = daily[0]?.date ?? null;
  const lastDate = daily[daily.length - 1]?.date ?? null;
  const totalDays = firstDate && lastDate
    ? Math.round(
        (new Date(lastDate + 'T00:00:00').getTime() - new Date(firstDate + 'T00:00:00').getTime()) / 86_400_000,
      ) + 1
    : 0;

  // Cache + cost aggregates rollup from per-model stats.
  let totalCacheReads = 0;
  let totalCacheWrites = 0;
  let totalCostUSD = 0;
  let totalPromptIncludingCache = 0;
  for (const m of models) {
    totalCacheReads += m.cacheReads;
    totalCacheWrites += m.cacheWrites;
    totalCostUSD += m.costUSD;
    totalPromptIncludingCache += m.tokensIn + m.cacheReads;
  }
  const cacheHitRatioGlobal = totalPromptIncludingCache > 0
    ? totalCacheReads / totalPromptIncludingCache
    : 0;

  return {
    totalEvents,
    totalTokens,
    totalSessions,
    activeDays,
    totalDays,
    firstDate,
    lastDate,
    currentStreak,
    longestStreak,
    favoriteModel,
    mostActiveDay,
    mostActiveDayEvents,
    longestSessionMs,
    totalCacheReads,
    totalCacheWrites,
    cacheHitRatioGlobal,
    totalCostUSD,
    daily,
    models,
  };
}

/** Classify a day's token count into the heatmap's 0..4 intensity buckets.
 *  Max is the largest daily token count in the window — used to scale. */
export function heatLevel(tokens: number, max: number): HeatLevel {
  if (tokens <= 0 || max <= 0) return 0;
  const pct = tokens / max;
  if (pct <= 0.25) return 1;
  if (pct <= 0.50) return 2;
  if (pct <= 0.75) return 3;
  return 4;
}

/** Slice of the daily series covering the last `days` full days. */
export function filterDaily(daily: DailyStat[], days: number | 'all'): DailyStat[] {
  if (days === 'all' || !Number.isFinite(days as number)) return daily;
  const cutoff = Date.now() - (days as number) * 86_400_000;
  return daily.filter((d) => new Date(d.date + 'T00:00:00').getTime() >= cutoff);
}

/** Humorous comparison — tokens consumed vs famous novels (approx word counts
 *  x ~1.3 tokens/word, then rounded). Picks the closest book so the phrase
 *  makes sense regardless of total. Matches Claude Code's style. */
const COMPARISONS: Array<{ title: string; tokens: number }> = [
  { title: 'The Great Gatsby',         tokens:  62_000 },
  { title: 'The Catcher in the Rye',   tokens:  95_000 },
  { title: 'To Kill a Mockingbird',    tokens: 130_000 },
  { title: 'Harry Potter and the Sorcerer\'s Stone', tokens: 102_000 },
  { title: '1984',                     tokens: 115_000 },
  { title: 'Pride and Prejudice',      tokens: 160_000 },
  { title: 'Moby Dick',                tokens: 277_000 },
  { title: 'The Lord of the Rings',    tokens: 610_000 },
  { title: 'War and Peace',            tokens: 780_000 },
];

/**
 * Group the daily series by calendar month (YYYY-MM). Cost is allocated
 * proportionally to each month's token share of the total — the events
 * stream doesn't tell us which model was used on which day, so a fully
 * accurate per-month cost would require re-reducing per-day per-model.
 * The proportional approximation is good enough for the comparison view
 * and keeps the aggregator O(N) instead of O(N×models).
 */
export function groupByMonth(
  daily: DailyStat[],
  models?: ModelStat[],
): MonthStat[] {
  const totalTokens = daily.reduce((s, d) => s + d.tokens, 0);
  const totalCost = (models ?? []).reduce((s, m) => s + (m.costUSD ?? 0), 0);
  const byMonth = new Map<string, MonthStat>();
  for (const d of daily) {
    const month = d.date.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) {
      byMonth.set(month, { month, tokens: 0, events: 0, sessions: 0, costUSD: 0 });
    }
    const m = byMonth.get(month)!;
    m.tokens += d.tokens;
    m.events += d.events;
    m.sessions += d.sessions;
  }
  // Distribute cost by token share once all months are known.
  if (totalTokens > 0 && totalCost > 0) {
    for (const m of byMonth.values()) {
      m.costUSD = (m.tokens / totalTokens) * totalCost;
    }
  }
  return Array.from(byMonth.values()).sort((a, b) => b.month.localeCompare(a.month));
}

/** Escape a single CSV field — quotes the value when it contains a separator,
 *  newline or double-quote, doubling embedded quotes per RFC 4180. */
function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values: unknown[]): string {
  return values.map(csvField).join(',') + '\n';
}

/**
 * Serialize daily / models / both as RFC4180 CSV. `kind: 'all'` emits
 * both sections separated by a `## SECTION:` marker line so a downstream
 * tool can split. Numbers are written with full precision; the CSV
 * consumer can format as needed.
 */
export function exportUsageCsv(
  stats: UsageStats,
  kind: 'daily' | 'models' | 'all',
): string {
  const dailyHeader = ['date', 'events', 'tokens', 'sessions'];
  const modelsHeader = [
    'model', 'provider',
    'tokensIn', 'tokensOut', 'tokensTotal', 'events',
    'cacheReads', 'cacheWrites', 'cacheHitRatio', 'costUSD',
  ];
  const dailyBody = stats.daily.map((d) => csvLine([d.date, d.events, d.tokens, d.sessions]));
  const modelsBody = stats.models.map((m) => csvLine([
    m.model, m.provider,
    m.tokensIn, m.tokensOut, m.tokensTotal, m.events,
    m.cacheReads, m.cacheWrites, m.cacheHitRatio.toFixed(4), m.costUSD.toFixed(6),
  ]));
  if (kind === 'daily') return csvLine(dailyHeader) + dailyBody.join('');
  if (kind === 'models') return csvLine(modelsHeader) + modelsBody.join('');
  return [
    '## SECTION: daily',
    csvLine(dailyHeader).trimEnd(),
    ...dailyBody.map((s) => s.trimEnd()),
    '',
    '## SECTION: models',
    csvLine(modelsHeader).trimEnd(),
    ...modelsBody.map((s) => s.trimEnd()),
    '',
  ].join('\n');
}

export function tokenComparison(totalTokens: number): { factor: number; book: string } | null {
  if (totalTokens < 10_000) return null;
  // Prefer a book where the factor is >=1 (so "X× more" reads naturally).
  const candidates = COMPARISONS.filter((b) => totalTokens >= b.tokens);
  const book = candidates[Math.floor(candidates.length / 2)] || COMPARISONS[0];
  return {
    factor: Math.round(totalTokens / book.tokens),
    book: book.title,
  };
}
