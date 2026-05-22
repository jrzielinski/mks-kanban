import { swallow } from '../../utils/log';
/**
 * Slash command handler — /diagnose
 *
 * Health snapshot of the current REPL session — token spend, cache
 * effectiveness, dedup hits, dispatch failures, microcompact ratio.
 * Designed to answer "where is my budget going?" without leaving the
 * REPL: the user runs /diagnose mid-session, sees actionable hints,
 * and can adjust prompts / settings without spelunking through
 * ~/.makestudio/debug/.
 *
 * Pure read of in-process state + ~/.makestudio/events.jsonl. No
 * mutation, no LLM calls.
 */

import chalk from 'chalk';
import type { SlashCommand, SlashContext } from '../slash-registry';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');
const bold = chalk.bold;

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function pct(num: number, den: number): string {
  if (den <= 0) return '—';
  return `${((num / den) * 100).toFixed(1)}%`;
}

function handler(sc: SlashContext): void {
  const { ctx } = sc;
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${bold('MakeStudio /diagnose')} ${dim('— health snapshot of the current session')}`);

  // ── Tokens ──────────────────────────────────────────────────────
  const u = ctx.usage || ({} as any);
  const totalIn = u.promptTokens || 0;
  const totalOut = u.completionTokens || 0;
  const cacheReads = u.cacheReads || 0;
  const cacheWrites = u.cacheWrites || 0;
  lines.push('');
  lines.push(`  ${bold('Tokens')}`);
  lines.push(`    ${dim('input:')}      ${cyan(fmt(totalIn).padStart(8))} ${dim('(' + (cacheReads > 0 ? pct(cacheReads, totalIn) + ' cache hit)' : 'no cache') + ')')}`);
  lines.push(`    ${dim('output:')}     ${cyan(fmt(totalOut).padStart(8))}`);
  if (cacheWrites > 0) lines.push(`    ${dim('cache writes:')}${dim(' ' + fmt(cacheWrites).padStart(7))}`);

  // ── By origin ───────────────────────────────────────────────────
  const byOrigin: any = (u as any).byOrigin || {};
  const originEntries: Array<[string, any]> = Object.entries(byOrigin).filter(([, v]) => (v as any)?.totalTokens > 0);
  if (originEntries.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Spend by origin')}`);
    for (const [name, val] of originEntries) {
      lines.push(`    ${dim(name.padEnd(10))} ${cyan(fmt((val as any).totalTokens).padStart(8))}  ${dim((val as any).requestCount + ' req')}`);
    }
  }

  // ── Tool dispatch health ────────────────────────────────────────
  // Re-aggregate from the latest tool_call events so we don't depend
  // on per-turn flags being still in scope.
  let dedupHits = 0;
  let dispatchFails = 0;
  let bashFails = 0;
  let toolCalls = 0;
  try {
    const { readRecentEvents } = require('../../utils/events');
    const events = readRecentEvents(2000);
    const ttl = events.filter((e: any) => e.type === 'tool_call');
    toolCalls = ttl.length;
    for (const e of ttl) {
      if (!e.ok) dispatchFails++;
      if (e.tool === 'Bash' && !e.ok) bashFails++;
    }
    for (const e of events) {
      if (e.type === 'tool_dedup_block') dedupHits++;
    }
  } catch (err) { swallow(err); }

  if (toolCalls > 0) {
    lines.push('');
    lines.push(`  ${bold('Tool dispatch')}`);
    lines.push(`    ${dim('total calls:')}   ${cyan(String(toolCalls).padStart(6))}`);
    const failColor = dispatchFails > toolCalls * 0.05 ? red : dim;
    lines.push(`    ${dim('failures:')}      ${failColor(String(dispatchFails).padStart(6))} ${dim('(' + pct(dispatchFails, toolCalls) + ')')}`);
    if (bashFails > 0) lines.push(`    ${dim('bash failures:')} ${(bashFails > 5 ? red : dim)(String(bashFails).padStart(6))}`);
    if (dedupHits > 0) {
      lines.push(`    ${dim('dedup blocks:')}  ${green(String(dedupHits).padStart(6))} ${dim('(saved tool calls — model retried Read/Glob/Grep)')}`);
    }
  }

  // ── Compact / context window ────────────────────────────────────
  const ctxPctRaw = totalIn > 0 ? (totalIn / 200_000) * 100 : 0; // crude fallback
  lines.push('');
  lines.push(`  ${bold('Context window')}`);
  const ctxColor = ctxPctRaw > 80 ? red : ctxPctRaw > 50 ? yellow : green;
  lines.push(`    ${dim('utilisation (rough):')} ${ctxColor(ctxPctRaw.toFixed(0) + '%')}`);
  if ((ctx as any).compactFailures > 0) {
    lines.push(`    ${dim('compact failures:')}    ${red(String((ctx as any).compactFailures))} ${dim('(circuit breaker may have tripped)')}`);
  }

  // ── Hints ───────────────────────────────────────────────────────
  const hints: string[] = [];
  if (toolCalls > 30 && dispatchFails === 0 && dedupHits === 0) {
    hints.push('Heavy tool activity but no dedup hits — consider whether the model is over-investigating. Try /stats for top fanout turns.');
  }
  if (cacheWrites > totalIn * 0.5) {
    hints.push('Cache writes > 50% of input — system/tools changed often. Check for unstable items in the system prompt (effort/style flips, sort instability).');
  }
  if (cacheReads === 0 && totalIn > 10_000) {
    hints.push('No cache reads despite large input volume — provider may not support prompt cache, or cache_control isn\'t being honoured. Run /ctx to inspect.');
  }
  if (bashFails > 5) {
    hints.push('Many Bash failures — check stderr in /thinkback. Frequent failure is often a permission or path issue.');
  }
  if (hints.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Hints')}`);
    for (const h of hints) lines.push(`    ${yellow('!')} ${h}`);
  }

  console.log(lines.join('\n'));
}

export const DIAGNOSE_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/diagnose', '/diag', '/health'], handler },
];
