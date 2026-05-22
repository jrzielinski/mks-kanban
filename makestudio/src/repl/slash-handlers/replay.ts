import { swallow } from '../../utils/log';
/**
 * Slash command handler — /replay
 *
 * Inspect or play-back the persisted tool-call log for a session.
 * Backed by the JSONL file written by tool-result-persist.ts (which is
 * opt-in via settings.toolResultPersist or MAKESTUDIO_TOOL_PERSIST=1).
 *
 * Forms:
 *   /replay                   — list every tool call from the CURRENT session
 *   /replay <sessionId>       — list every tool call from another session
 *   /replay <sid> <range>     — list tool calls within a sequence range
 *                                (e.g. "10-20" or "5+10")
 *   /replay last <N>          — list the last N tool calls of the current session
 *
 * Output is a chronological table:
 *
 *   #  ts                tool       ok    dur    summary
 *   ── ───────────────── ────────── ───   ───── ───────────
 *
 * Designed for INSPECTION, not for actually re-executing the calls
 * (which would have side effects). Replay-with-execute would belong
 * in a separate `/replay --execute` flag and require explicit user
 * authorisation per tool — out of scope for this command.
 */

import * as path from 'path';
import chalk from 'chalk';
import type { SlashCommand, SlashContext } from '../slash-registry';
import { loadToolCallRecords, ToolCallRecord } from '../ai/tool-result-persist';
import { currentSessionFile } from '../sessions';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const red = chalk.hex('#EF4444');
const yellow = chalk.hex('#FBBF24');
const bold = chalk.bold;

const DEFAULT_LIMIT = 50;
const MAX_SUMMARY_LEN = 60;

interface ParsedArgs {
  sid?: string;
  start?: number;
  end?: number;
  lastN?: number;
}

function parseArgs(args: string[], currentSid: string | null): ParsedArgs | { error: string } {
  if (args.length === 0) {
    if (!currentSid) return { error: 'no current session — pass a session id explicitly: /replay <sid>' };
    return { sid: currentSid };
  }

  if (args[0] === 'last') {
    const n = parseInt(args[1] || '20', 10);
    if (isNaN(n) || n < 1) return { error: 'usage: /replay last <N>' };
    if (!currentSid) return { error: 'no current session — pass a session id: /replay <sid> last <N>' };
    return { sid: currentSid, lastN: n };
  }

  // First arg is sid (or "last" handled above). Optional second arg is range.
  const sid = args[0];
  if (args.length === 1) return { sid };

  const range = args[1];
  // "10-20" inclusive end, or "5+10" start + count.
  const dashMatch = range.match(/^(\d+)-(\d+)$/);
  if (dashMatch) {
    const start = parseInt(dashMatch[1], 10);
    const end = parseInt(dashMatch[2], 10);
    if (isNaN(start) || isNaN(end) || start > end) return { error: 'invalid range — try "10-20"' };
    return { sid, start, end };
  }
  const plusMatch = range.match(/^(\d+)\+(\d+)$/);
  if (plusMatch) {
    const start = parseInt(plusMatch[1], 10);
    const count = parseInt(plusMatch[2], 10);
    if (isNaN(start) || isNaN(count) || count < 1) return { error: 'invalid range — try "5+10" (start+count)' };
    return { sid, start, end: start + count - 1 };
  }
  return { error: `unrecognised range: ${range}` };
}

function summariseInput(rec: ToolCallRecord): string {
  const i = rec.input as any;
  if (!i || typeof i !== 'object') {
    const s = String(i);
    return s.length > MAX_SUMMARY_LEN ? s.slice(0, MAX_SUMMARY_LEN - 1) + '…' : s;
  }
  // Tool-shape-specific fields
  if (i.command) return clip(i.command);
  if (i.file_path) {
    const off = i.offset ? `:${i.offset}` : '';
    const lim = i.limit ? `+${i.limit}` : '';
    return clip(i.file_path + off + lim);
  }
  if (i.pattern) return clip('/' + i.pattern + '/');
  if (i.url) return clip(i.url);
  if (i.notebook_path) return clip(i.notebook_path);
  // fallback: 1st 2 keys
  const entries = Object.entries(i).slice(0, 2);
  return clip(entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' '));
}

function clip(s: string): string {
  return s.length > MAX_SUMMARY_LEN ? s.slice(0, MAX_SUMMARY_LEN - 1) + '…' : s;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTs(iso: string): string {
  // HH:MM:SS only — saves horizontal space, keeps it scannable.
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso.slice(0, 19);
  return date.toISOString().slice(11, 19);
}

function handler(sc: SlashContext): void {
  const { ctx, rest } = sc;
  const lines: string[] = [];

  let currentSid: string | null = null;
  try {
    const f = currentSessionFile(ctx);
    if (f) currentSid = path.basename(f, '.jsonl');
  } catch (err) { swallow(err); }

  const parsed = parseArgs(rest, currentSid);
  if ('error' in parsed) {
    console.log(`\n  ${red(parsed.error)}\n  ${dim('forms: /replay | /replay <sid> | /replay <sid> 10-20 | /replay last 20')}\n`);
    return;
  }

  const sid = parsed.sid!;
  const records = loadToolCallRecords(sid);
  if (records.length === 0) {
    console.log(
      `\n  ${dim('No tool-call records for session "' + sid + '". ')}` +
      `${dim('Tool result persistence is opt-in — set settings.toolResultPersist=true ' +
             'or MAKESTUDIO_TOOL_PERSIST=1 to start logging.')}\n`,
    );
    return;
  }

  let view = records;
  if (parsed.lastN) view = records.slice(-parsed.lastN);
  else if (parsed.start !== undefined && parsed.end !== undefined) {
    view = records.filter((r) => r.seq >= parsed.start! && r.seq <= parsed.end!);
  } else if (view.length > DEFAULT_LIMIT) {
    view = records.slice(-DEFAULT_LIMIT);
  }

  lines.push('');
  lines.push(`  ${bold('Session')} ${cyan(sid)} ${dim('— ' + records.length + ' tool calls total, showing ' + view.length)}`);
  lines.push('');

  // Aggregate stats
  const ok = view.filter((r) => r.ok).length;
  const fail = view.length - ok;
  const totalMs = view.reduce((s, r) => s + (r.durationMs || 0), 0);
  const byTool = new Map<string, number>();
  for (const r of view) byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1);
  const topTools = Array.from(byTool.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

  lines.push(`  ${dim('ok=')}${green(String(ok))} ${dim('fail=')}${fail > 0 ? red(String(fail)) : dim('0')}  ${dim('total=' + fmtDuration(totalMs))}  ${dim('top=' + topTools.map(([n, c]) => `${n}×${c}`).join(', '))}`);
  lines.push('');
  lines.push(`  ${dim('#'.padStart(4))} ${dim('time'.padEnd(8))} ${dim('tool'.padEnd(12))} ${dim('ok'.padEnd(3))} ${dim('dur'.padEnd(7))} ${dim('summary')}`);
  for (const r of view) {
    const okMark = r.ok ? green('✓') : red('✗');
    const durStr = fmtDuration(r.durationMs || 0).padEnd(7);
    const tool = r.tool.length > 12 ? r.tool.slice(0, 11) + '…' : r.tool.padEnd(12);
    const colorTool = r.ok ? cyan(tool) : (yellow(tool));
    lines.push(`  ${dim(String(r.seq).padStart(4))} ${dim(fmtTs(r.ts))} ${colorTool} ${okMark.padEnd(3)} ${dim(durStr)} ${summariseInput(r)}`);
  }

  console.log(lines.join('\n'));
}

export const REPLAY_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/replay', '/history'], handler },
];
