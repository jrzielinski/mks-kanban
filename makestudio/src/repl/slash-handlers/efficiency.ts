import { swallow } from '../../utils/log';
/**
 * Slash command handler — /efficiency
 *
 * Token-efficiency dashboard inspired by the rtk-style summary view.
 * Shows where the agent's input tokens went, how many were saved by
 * caching/dedup/compaction, and which tools dominate the spend.
 *
 * Layout:
 *
 *   Total commands:    352
 *   Input tokens:      4.4M
 *   Output tokens:     1.6M
 *   Tokens saved:      2.8M (63.6%)
 *   Total exec time:   1m14s (avg 210ms)
 *   Efficiency meter:  ████████████░░░░░░  63.6%
 *
 *   By Command
 *
 *    #  Command         Count   Saved    Avg%     Time   Impact
 *    1  Read            24      2.4M     51.4%    4ms    ████
 *    2  Grep            129     257.2K   43.7%    3ms    ██
 *    ...
 *
 * Tokens saved heuristic — additive across three sources:
 *   1. cacheReads × 0.9 — tokens paid at 10% rate (Anthropic prefix
 *      cache); the other 90% counts as savings.
 *   2. tool_dedup_block events — each block prevented a re-execute,
 *      saving the typical output size of that tool.
 *   3. microCompact / smartPrune freed chars — events with `freedChars`
 *      get divided by 4 to convert chars→tokens (rough average).
 *
 * Reads from ~/.makestudio/events.jsonl + ctx.usage. No LLM call.
 */

import chalk from 'chalk';
import type { SlashCommand, SlashContext } from '../slash-registry';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');
const bold = chalk.bold;

const BAR_WIDTH = 30;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtMs(ms: number): string {
  if (ms < 1) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function bar(filledFraction: number, width: number, color: (s: string) => string): string {
  const f = Number.isFinite(filledFraction) ? Math.max(0, Math.min(1, filledFraction)) : 0;
  const filled = Math.max(0, Math.min(width, Math.round(width * f)));
  const empty = Math.max(0, width - filled);
  return color('█'.repeat(filled)) + dim('░'.repeat(empty));
}

function pctColor(p: number): (s: string) => string {
  if (p >= 60) return green.bold;
  if (p >= 30) return yellow.bold;
  return red.bold;
}

interface ToolStat {
  count: number;
  totalMs: number;
  totalOutputChars: number;
  fail: number;
}

function handler(sc: SlashContext): void {
  try {
    handlerImpl(sc);
  } catch (err: any) {
    console.log(`\n  ${red('/efficiency crashed:')} ${dim(err?.stack?.split('\n').slice(0, 3).join(' | ') || String(err))}\n`);
  }
}

function handlerImpl(sc: SlashContext): void {
  const { ctx } = sc;

  // ── Aggregate from in-memory toolCallHistory ─────────────────
  // Defensive — `toolCallHistory` is initialised on ctx but a freshly-
  // booted REPL with zero LLM calls may not have it populated yet.
  const rawHistory = (ctx as any).toolCallHistory;
  const history = (Array.isArray(rawHistory) ? rawHistory : []) as Array<{
    name: string;
    output: string;
    durationMs: number;
    ok: boolean;
  }>;

  const byTool = new Map<string, ToolStat>();
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const name: string = (typeof h.name === 'string' && h.name.length > 0) ? h.name : 'unknown';
    const slot = byTool.get(name) || { count: 0, totalMs: 0, totalOutputChars: 0, fail: 0 };
    slot.count++;
    slot.totalMs += Number(h.durationMs) || 0;
    slot.totalOutputChars += (typeof h.output === 'string' ? h.output.length : 0);
    if (h.ok === false) slot.fail++;
    byTool.set(name, slot);
  }

  // ── Saved-tokens heuristic ────────────────────────────────────
  // 1. Cache reads × 0.9 (Anthropic prefix-cache discount)
  const usage = (ctx as any).usage || {};
  const cacheReads = usage.cacheReads || 0;
  const savedCache = cacheReads * 0.9;

  // 2. tool_dedup_block events — each block prevented a re-execute.
  let savedDedup = 0;
  let dedupBlocks = 0;
  let microCompactFreedChars = 0;
  let smartPruneFreedChars = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readRecentEvents } = require('../../utils/events');
    const events = readRecentEvents(2000);
    // Average output size by tool, used to estimate dedup savings.
    const avgOutputByTool = new Map<string, number>();
    for (const [name, s] of byTool) {
      avgOutputByTool.set(name, s.count > 0 ? s.totalOutputChars / s.count : 0);
    }
    for (const e of events) {
      if (e.type === 'tool_dedup_block') {
        dedupBlocks++;
        const tool = String((e as any).tool || '');
        const avg = avgOutputByTool.get(tool) ?? 800;
        savedDedup += avg / 4; // chars → tokens (~4 chars/token)
      }
      if ((e as any).type === 'compact_summary' || (e as any).msg === 'micro_compact') {
        microCompactFreedChars += Number((e as any).freedChars || 0);
      }
      if ((e as any).msg === 'smart_prune') {
        smartPruneFreedChars += Number((e as any).freedChars || 0);
      }
    }
  } catch (err) { swallow(err); }

  const savedCompact = (microCompactFreedChars + smartPruneFreedChars) / 4;
  const savedTotal = Math.round(savedCache + savedDedup + savedCompact);

  // ── Header block ─────────────────────────────────────────────
  const totalCommands = history.length;
  const totalInput = usage.promptTokens || 0;
  const totalOutput = usage.completionTokens || 0;
  const totalDuration = history.reduce((s, h) => s + (Number(h?.durationMs) || 0), 0);
  const avgDuration = totalCommands > 0 ? totalDuration / totalCommands : 0;
  const denominator = savedTotal + totalInput;
  const efficiencyPct = denominator > 0 ? (savedTotal / denominator) * 100 : 0;

  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${bold('Total commands:')}    ${cyan(String(totalCommands))}`);
  lines.push(`  ${bold('Input tokens:')}      ${cyan(fmtTokens(totalInput))}${cacheReads > 0 ? dim(`  (${fmtTokens(cacheReads)} cached)`) : ''}`);
  lines.push(`  ${bold('Output tokens:')}     ${cyan(fmtTokens(totalOutput))}`);
  if (savedTotal > 0) {
    const breakdownParts: string[] = [];
    if (savedCache > 0) breakdownParts.push(`cache=${fmtTokens(savedCache)}`);
    if (savedDedup > 0) breakdownParts.push(`dedup=${fmtTokens(savedDedup)}×${dedupBlocks}`);
    if (savedCompact > 0) breakdownParts.push(`compact=${fmtTokens(savedCompact)}`);
    const breakdown = breakdownParts.length > 0 ? dim(`  (${breakdownParts.join(', ')})`) : '';
    lines.push(`  ${bold('Tokens saved:')}      ${green(fmtTokens(savedTotal))} ${green(`(${efficiencyPct.toFixed(1)}%)`)}${breakdown}`);
  } else {
    lines.push(`  ${bold('Tokens saved:')}      ${dim('0  (no cache/dedup activity recorded)')}`);
  }
  lines.push(`  ${bold('Total exec time:')}   ${cyan(fmtMs(totalDuration))} ${dim(`(avg ${fmtMs(avgDuration)})`)}`);
  const meterColor = efficiencyPct >= 60 ? green : efficiencyPct >= 30 ? yellow : red;
  lines.push(`  ${bold('Efficiency meter:')}  ${bar(efficiencyPct / 100, BAR_WIDTH, meterColor)}  ${pctColor(efficiencyPct)(efficiencyPct.toFixed(1) + '%')}`);

  // ── By-command table ─────────────────────────────────────────
  if (byTool.size > 0) {
    lines.push('');
    lines.push(`  ${bold('By Command')}`);
    lines.push('');
    lines.push(
      `  ${dim('#'.padStart(3))}  ${dim('Command'.padEnd(22))}` +
      `  ${dim('Count'.padStart(6))}` +
      `  ${dim('Saved'.padStart(8))}` +
      `  ${dim('Avg%'.padStart(7))}` +
      `  ${dim('Time'.padStart(7))}` +
      `  ${dim('Impact')}`,
    );

    // Compute per-tool saved tokens.
    const perToolSaved = new Map<string, number>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readRecentEvents } = require('../../utils/events');
      const events = readRecentEvents(2000);
      for (const e of events) {
        if (e.type === 'tool_dedup_block') {
          const tool = String((e as any).tool || '');
          const slot = byTool.get(tool);
          const avg = slot && slot.count > 0 ? slot.totalOutputChars / slot.count : 800;
          perToolSaved.set(tool, (perToolSaved.get(tool) || 0) + avg / 4);
        }
      }
    } catch (err) { swallow(err); }

    // Sort by saved DESC then count DESC.
    const rows = Array.from(byTool.entries())
      .map(([name, s]) => ({
        name,
        count: s.count,
        avgMs: s.count > 0 ? s.totalMs / s.count : 0,
        saved: perToolSaved.get(name) || 0,
        outputChars: s.totalOutputChars,
        fail: s.fail,
      }))
      .sort((a, b) => (b.saved - a.saved) || (b.count - a.count))
      .slice(0, 15);

    const maxSaved = Math.max(1, ...rows.map((r) => r.saved));
    let i = 1;
    for (const r of rows) {
      const idx = String(i++).padStart(3);
      const name = (r.name.length > 22 ? r.name.slice(0, 21) + '…' : r.name).padEnd(22);
      const count = String(r.count).padStart(6);
      const saved = fmtTokens(r.saved).padStart(8);
      const avgPct = r.outputChars > 0 ? Math.min(100, (r.saved * 4 / r.outputChars) * 100) : 0;
      const avgPctStr = (avgPct.toFixed(1) + '%').padStart(7);
      const timeStr = fmtMs(r.avgMs).padStart(7);
      const impactFrac = r.saved / maxSaved;
      const impact = bar(impactFrac, 12, cyan);
      const nameColor = r.fail > 0 ? red : cyan;
      const savedColor = r.saved > 0 ? green : dim;
      const pctC = pctColor(avgPct);
      lines.push(`  ${dim(idx)}  ${nameColor(name)}  ${cyan(count)}  ${savedColor(saved)}  ${pctC(avgPctStr)}  ${dim(timeStr)}  ${impact}`);
    }
  }

  lines.push('');
  console.log(lines.join('\n'));
}

export const EFFICIENCY_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/efficiency', '/eff'], handler },
];
