import { swallow } from '../../utils/log';
/**
 * Slash command handler — /diff
 *
 * Show the file changes that happened between two turns of the current
 * session. Backed by the per-turn snapshot machinery in rewind.ts —
 * every Write/Edit/MultiEdit captures the BEFORE state, so we can
 * compute "what did this turn do?" or "what did the last 5 turns do?"
 * without leaving the REPL.
 *
 * Forms:
 *   /diff                 — show all changes since the previous turn
 *                           (i.e. what the most recent turn did)
 *   /diff <N>             — show changes from turn N to current
 *   /diff <from> <to>     — show changes in the closed range [from, to]
 *
 * Output: one entry per touched file, capped to keep the REPL readable.
 * For status='created'/'modified' a unified diff is rendered (using the
 * existing diff-render module). For 'deleted', a small banner + the
 * old content head. For 'unchanged' (touched then reverted), a one-line
 * note so the user knows the snapshot exists but the net effect is nil.
 */

import chalk from 'chalk';
import type { SlashCommand, SlashContext } from '../slash-registry';
import { diffTurns } from '../rewind';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');
const bold = chalk.bold;

const MAX_FILES_SHOWN = 12;
const MAX_DIFF_LINES_PER_FILE = 80;

function parseRange(args: string[], currentTurn: number): { from: number; to: number } | null {
  if (args.length === 0) {
    return { from: Math.max(1, currentTurn), to: currentTurn };
  }
  if (args.length === 1) {
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) return null;
    return { from: n, to: currentTurn };
  }
  const f = parseInt(args[0], 10);
  const t = parseInt(args[1], 10);
  if (isNaN(f) || isNaN(t) || f < 1 || t < f) return null;
  return { from: f, to: t };
}

function statusBadge(s: string): string {
  switch (s) {
    case 'created': return green('+ created');
    case 'deleted': return red('- deleted');
    case 'modified': return yellow('~ modified');
    case 'unchanged': return dim('· unchanged');
    default: return dim(s);
  }
}

function handler(sc: SlashContext): void {
  const { ctx, rest } = sc;
  const args = rest;
  const lines: string[] = [];
  const currentTurn = (ctx as any).currentTurnNum || 0;

  if (currentTurn < 1) {
    console.log(`\n  ${dim('No turns recorded yet — make at least one user request first.')}\n`);
    return;
  }

  const range = parseRange(args, currentTurn);
  if (!range) {
    console.log(`\n  ${red('Usage:')} /diff [<turn>] | /diff <from> <to>\n  ${dim('Examples:')}  /diff   /diff 3   /diff 2 5\n`);
    return;
  }

  const { from, to } = range;
  const entries = diffTurns(ctx, from, to);

  lines.push('');
  lines.push(`  ${bold('Changes')} ${dim('turns ' + from + '..' + to)}`);

  if (entries.length === 0) {
    lines.push(`    ${dim('(no files were touched in this range)')}`);
    console.log(lines.join('\n'));
    return;
  }

  // Summary header
  const counts = entries.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const summary = ['created', 'modified', 'deleted', 'unchanged']
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  lines.push(`    ${dim(summary)}`);
  lines.push('');

  let renderDiff: any = null;
  try { renderDiff = require('../diff-render').renderDiff; }
  catch (err) { swallow(err); }

  let shown = 0;
  for (const e of entries) {
    if (shown >= MAX_FILES_SHOWN) {
      lines.push(`    ${dim('… ' + (entries.length - shown) + ' more file(s) not shown')}`);
      break;
    }
    shown++;

    // Render path relative to ctx.cwd when possible.
    let rel = e.path;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      const cwd = (ctx as any).cwd || process.cwd();
      const r = path.relative(cwd, e.path);
      if (r && !r.startsWith('..')) rel = r;
    } catch (err) { swallow(err); }

    lines.push(`  ${statusBadge(e.status)} ${cyan(rel)} ${dim('(turns ' + e.turns.join(',') + ')')}`);

    if (e.status === 'unchanged') continue;
    if (e.status === 'deleted') {
      const head = e.before.split('\n').slice(0, 5).join('\n');
      lines.push(dim('    (file no longer exists; head of pre-range content:)'));
      for (const ln of head.split('\n')) lines.push(`    ${dim('-')} ${ln}`);
      continue;
    }

    if (renderDiff) {
      try {
        const diff = renderDiff(e.before, e.after, { filePath: rel, context: 2, maxLines: MAX_DIFF_LINES_PER_FILE });
        // Indent the rendered diff so it nests under the file header.
        for (const ln of String(diff).split('\n')) lines.push(`    ${ln}`);
      } catch {
        lines.push(dim(`    [diff render failed; ${e.before.length} → ${e.after.length} chars]`));
      }
    } else {
      lines.push(dim(`    ${e.before.length} → ${e.after.length} chars`));
    }
    lines.push('');
  }

  console.log(lines.join('\n'));
}

export const DIFF_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/diff', '/changes'], handler },
];
