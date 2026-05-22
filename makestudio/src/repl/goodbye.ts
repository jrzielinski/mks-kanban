import { swallow } from '../utils/log';
/**
 * goodbye.ts
 *
 * Prints an interaction summary when the REPL exits (via /quit, /exit, /q
 * or Ctrl+C). Mirrors the style of `gemini --resume`'s shutdown report.
 *
 * Tracked in ReplContext:
 *   - usage.sessionStartedAt   (wall time start)
 *   - stats.toolCallsOk/Fail   (count + success rate)
 *   - stats.apiMs / stats.toolMs (agent-active breakdown)
 *   - currentSessionFile(ctx)  (session id for --continue)
 */

import * as path from 'path';
import chalk from 'chalk';
import { ReplContext } from './context';
import { currentSessionFile } from './sessions';

function getBuildInfo(): { version: string; builtAt: string } {
  try {
    const pkg = require('../../package.json');
    return {
      version: pkg.version || '?',
      builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    };
  } catch {
    return { version: '?', builtAt: '?' };
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function pct(part: number, whole: number): string {
  if (!whole) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function sessionIdFromCtx(ctx: ReplContext): string | null {
  const f = currentSessionFile(ctx);
  if (!f) return null;
  return path.basename(f).replace(/\.jsonl$/, '');
}

const LABEL_WIDTH = 18;
const padLabel = (s: string) => s.padEnd(LABEL_WIDTH, ' ');

export function buildGoodbyeSummary(ctx: ReplContext): string {
  // Read palette lazily so the summary respects the current /theme setting.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const palette = require('./theme').colors();
  const primary = chalk.hex(palette.primary);
  const accent = chalk.hex(palette.accent);
  const success = chalk.hex(palette.success);
  const danger = chalk.hex(palette.danger);
  const dim = chalk.hex(palette.dim);
  const bold = chalk.bold;

  const ok = ctx.stats.toolCallsOk;
  const fail = ctx.stats.toolCallsFail;
  const total = ok + fail;
  const successColored = total === 0
    ? dim('n/a')
    : (() => {
        const rate = (ok / total) * 100;
        const text = `${rate.toFixed(1)}%`;
        if (rate >= 75) return success(text);
        if (rate >= 50) return chalk.hex(palette.warning)(text);
        return danger(text);
      })();

  const wallMs = Date.now() - ctx.usage.sessionStartedAt;
  const apiMs = ctx.stats.apiMs;
  const toolMs = ctx.stats.toolMs;
  const activeMs = apiMs + toolMs;

  const sessionId = sessionIdFromCtx(ctx);

  const build = getBuildInfo();

  const lines: string[] = [];
  lines.push('');
  lines.push(
    primary('Agent powering down. Goodbye!') +
    dim(`  v${build.version}  ·  ${build.builtAt}`)
  );
  lines.push('');
  lines.push(bold('Interaction Summary'));
  if (sessionId) {
    lines.push(`${padLabel('Session ID:')}${accent(sessionId)}`);
  }
  lines.push(
    `${padLabel('Tool Calls:')}${total}  ` +
    dim('( ') + success('ok ' + ok) + dim(' · ') + danger('fail ' + fail) + dim(' )')
  );
  lines.push(`${padLabel('Success Rate:')}${successColored}`);
  lines.push('');
  lines.push(bold('Performance'));
  lines.push(`${padLabel('Wall Time:')}${fmtDuration(wallMs)}`);
  lines.push(`${padLabel('Agent Active:')}${fmtDuration(activeMs)}`);
  lines.push(`${padLabel('  API Time:')}${fmtDuration(apiMs)} ${dim('(' + pct(apiMs, wallMs) + ')')}`);
  lines.push(`${padLabel('  Tool Time:')}${fmtDuration(toolMs)} ${dim('(' + pct(toolMs, wallMs) + ')')}`);
  lines.push('');
  if (sessionId) {
    // Use --resume <id> for a specific session. `--continue` without an id
    // picks the most recent one (which is THIS session only until another
    // starts), so `--continue <id>` does not exist — commander rejects it.
    lines.push(success(`To resume this session: makestudio --resume ${sessionId}`));
  } else {
    lines.push(dim('(no messages persisted — nothing to resume)'));
  }
  lines.push('');

  return lines.join('\n');
}

/** Print the summary to stdout. Safe to call during exit. */
export function printGoodbye(ctx: ReplContext): void {
  try {
    process.stdout.write(buildGoodbyeSummary(ctx) + '\n');
  } catch (err) { swallow(err); }
}
