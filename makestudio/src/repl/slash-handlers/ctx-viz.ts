import { swallow } from '../../utils/log';
/**
 * `/ctx_viz` — Visual context window breakdown.
 *
 * Renders per-category ANSI-colored horizontal bars so you can see
 * at a glance where your context budget is going.
 *
 * Features:
 *  - One colored bar per category (system, tools, user, assistant, tool, memory)
 *  - Total bar with usage percentage and warning threshold
 *  - Proportional to the model's max context window
 */
import chalk from 'chalk';
import type { SlashCommand, SlashContext } from '../slash-registry';
import { ReplContext } from '../context';

// ── Token estimation ─────────────────────────────────────────────────
function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Category definitions with colors ─────────────────────────────────
interface Category {
  label: string;
  tokens: number;
  color: (s: string) => string;
  dimmed: (s: string) => string;
}

const CAT_COLORS = {
  system:     { fg: chalk.hex('#FF6B6B'), dim: chalk.hex('#5A2D2D') },  // red
  tools:      { fg: chalk.hex('#FFD93D'), dim: chalk.hex('#5A4E1A') },  // yellow
  user:       { fg: chalk.hex('#6BCBFF'), dim: chalk.hex('#1E4A6B') },  // blue
  assistant:  { fg: chalk.hex('#6BCF6B'), dim: chalk.hex('#1E5A1E') },  // green
  toolResult: { fg: chalk.hex('#CF6BCF'), dim: chalk.hex('#4A1E4A') },  // magenta
  memory:     { fg: chalk.hex('#6BCFCF'), dim: chalk.hex('#1E4A4A') },  // cyan
};

// ── Data collector — mirrors handleCtxCommand from commands.ts ──────
function collectContextStats(ctx: ReplContext) {
  // System prompt
  let baseSystem = '';
  let memoryTokens = 0;
  let toolsTokens = 0;
  try {
    baseSystem = ctx.buildSystemPrompt();
    // Memory section
    const { findRelevant } = require('./memory');
    const lastQ = ctx.lastUserMessage || '';
    if (lastQ) {
      const relevant = findRelevant(lastQ, 3);
      memoryTokens = relevant.reduce((sum: number, t: any) => sum + roughTokens(t.body.substring(0, 800)), 0);
    }
    // Tool definitions
    const { toolDefinitions } = require('./ai/tools');
    toolsTokens = toolDefinitions.reduce((sum: number, t: any) => sum + roughTokens(JSON.stringify(t)), 0);
  } catch (err) { swallow(err); }

  const systemTokens = roughTokens(baseSystem);

  // Messages by role
  let userTokens = 0, assistantTokens = 0, toolResultTokens = 0;
  for (const m of ctx.messages) {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const t = roughTokens(body);
    if (m.role === 'user') userTokens += t;
    else if (m.role === 'assistant') assistantTokens += t;
    else toolResultTokens += t;
  }

  // Model limit
  const model = (ctx.providerInfo?.model || '').toLowerCase();
  let maxContext = 128_000;
  if (model.includes('claude')) maxContext = 200_000;
  else if (model.includes('gemini')) maxContext = 1_000_000;

  const categories: Category[] = [
    { label: 'system',  tokens: systemTokens,     color: CAT_COLORS.system.fg,    dimmed: CAT_COLORS.system.dim },
    { label: 'tools',   tokens: toolsTokens,       color: CAT_COLORS.tools.fg,     dimmed: CAT_COLORS.tools.dim },
    { label: 'user',    tokens: userTokens,        color: CAT_COLORS.user.fg,      dimmed: CAT_COLORS.user.dim },
    { label: 'assistant', tokens: assistantTokens, color: CAT_COLORS.assistant.fg, dimmed: CAT_COLORS.assistant.dim },
  ];
  if (toolResultTokens > 0) {
    categories.push({ label: 'tool', tokens: toolResultTokens, color: CAT_COLORS.toolResult.fg, dimmed: CAT_COLORS.toolResult.dim });
  }
  if (memoryTokens > 0) {
    categories.push({ label: 'memory', tokens: memoryTokens, color: CAT_COLORS.memory.fg, dimmed: CAT_COLORS.memory.dim });
  }

  const totalTokens = systemTokens + toolsTokens + userTokens + assistantTokens + toolResultTokens + memoryTokens;
  const pct = (totalTokens / maxContext) * 100;

  return { categories, totalTokens, maxContext, pct, model };
}

// ── Render helpers ───────────────────────────────────────────────────
const TERM_WIDTH = Math.min(process.stdout.columns || 80, 120);
const BAR_WIDTH = Math.max(20, TERM_WIDTH - 42); // space for label + count + pct

/** Build a proportional colored bar string. */
function renderBar(tokens: number, total: number, maxContext: number, color: (s: string) => string, dimmed: (s: string) => string): string {
  const ratio = maxContext > 0 ? tokens / maxContext : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = '█'.repeat(Math.max(1, filled)) + '░'.repeat(Math.max(0, empty));
  // Color the whole bar based on ratio
  const colored = ratio > 0.3 ? color(bar) : dimmed(bar);
  return colored;
}

function fmt(n: number): string {
  return n.toLocaleString().padStart(8);
}

/** Return chalk function for the given percentage threshold. */
function pctColor(pct: number): chalk.Chalk {
  if (pct > 80) return chalk.red;
  if (pct > 50) return chalk.hex('#FBBF24'); // yellow
  return chalk.green;
}

// ── Command handler ──────────────────────────────────────────────────
function handleCtxViz(ctx: ReplContext): void {
  const stats = collectContextStats(ctx);
  const lines: string[] = [];
  const headerColor = chalk.white.bold;
  const dim = chalk.hex('#64748B');

  // ── Header ───────────────────────────────────────────────────────
  lines.push(`  ${headerColor('Context Window — Visual')}`);
  lines.push('');

  // ── Category bars ────────────────────────────────────────────────
  // Sort by token count descending so the biggest consumer is on top
  const sorted = [...stats.categories].sort((a, b) => b.tokens - a.tokens);
  for (const cat of sorted) {
    const pctOfTotal = stats.totalTokens > 0 ? (cat.tokens / stats.totalTokens) * 100 : 0;
    const pctOfMax   = stats.maxContext > 0 ? (cat.tokens / stats.maxContext) * 100 : 0;
    const bar = renderBar(cat.tokens, stats.totalTokens, stats.maxContext, cat.color, cat.dimmed);
    const label = cat.color(cat.label.padEnd(12));
    const count = chalk.white(fmt(cat.tokens));
    lines.push(`  ${label} ${count}  ${chalk.hex('#64748B')(pctOfTotal.toFixed(1) + '%')}  ${bar}  ${dim(pctOfMax.toFixed(1) + '%')}`);
  }

  // ── Total bar ────────────────────────────────────────────────────
  lines.push(`  ${dim('─'.repeat(Math.min(TERM_WIDTH - 4, 60)))}`);
  const totalBar = renderBar(stats.totalTokens, stats.totalTokens, stats.maxContext, pctColor(stats.pct), dim);
  const totalLabel = chalk.white.bold('total'.padEnd(12));
  const totalCount = chalk.cyan(fmt(stats.totalTokens));
  const totalPct = pctColor(stats.pct);
  lines.push(`  ${totalLabel} ${totalCount}  ${totalPct(stats.pct.toFixed(1) + '%')}  ${totalBar}  ${chalk.hex('#64748B')(`of ${fmt(stats.maxContext)} (${stats.model})`)}`);

  // ── Model limit line ─────────────────────────────────────────────
  lines.push('');
  lines.push(`  ${dim('Model limit:')} ${chalk.cyan(fmt(stats.maxContext))}  ${dim('· tokens')}  ${dim('context window:')} ${pctColor(stats.pct)(stats.pct.toFixed(1) + '%')}`);

  // ── Warning ──────────────────────────────────────────────────────
  if (stats.pct > 80) {
    lines.push('');
    lines.push(`  ${chalk.red('!')} ${dim('Context is getting full. Consider')} ${chalk.cyan('/clear')} ${dim('to reset conversation.')}`);
  }

  console.log(lines.join('\n'));
}

// ── Slash context adapter ────────────────────────────────────────────
async function handleSlashCtxViz(sc: SlashContext): Promise<void> {
  handleCtxViz(sc.ctx);
}

export const CTX_VIZ_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/ctx_viz', '/ctx-viz', '/context-viz'], handler: handleSlashCtxViz },
];
