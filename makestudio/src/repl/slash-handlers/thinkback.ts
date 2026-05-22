/**
 * Slash command handler — /thinkback
 *
 * Replays the tool call history for the current session, showing name,
 * duration, input args, and a preview of the result. Inspired by
 * Claude Code's /thinkback command.
 *
 * Usage:
 *   /thinkback        — show all tool calls (last 200, newest first)
 *   /thinkback --all  — show all stored tool calls
 *   /thinkback <N>    — show last N tool calls
 *   /thinkback <name> — filter by tool name (e.g. Read, Edit, Bash)
 *   /thinkback --raw  — show raw JSON for each call
 */
import {
  dim, green, cyan, yellow, red, bold,
} from '../slash-utils';
import type { SlashCommand, SlashContext } from '../slash-registry';

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fmtTimestamp(ts: string): string {
  return ts.slice(11, 19); // HH:MM:SS
}

function previewOutput(output: string): string {
  if (!output) return '<empty>';
  const cleaned = output.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned;
}

function previewInput(input: any): string {
  if (!input) return '';
  // Extract the most meaningful arg for display
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const displayKeys = ['file_path', 'filePath', 'command', 'pattern', 'symbol', 'query', 'url', 'name'];
  for (const dk of displayKeys) {
    if (input[dk]) {
      const v = String(input[dk]);
      return v.length > 40 ? v.slice(0, 40) + '…' : v;
    }
  }
  // fallback: show first key=value
  const k = keys[0];
  const v = String(input[k]);
  return `${k}=${v.length > 30 ? v.slice(0, 30) + '…' : v}`;
}

async function handleSlashThinkback(sc: SlashContext): Promise<void> {
  const { ctx, rest } = sc;
  const history = ctx.toolCallHistory;
  const args = rest.map(a => (a || '').toLowerCase()).filter(Boolean);

  const showAll = args.includes('--all');
  const showRaw = args.includes('--raw');
  const toolFilter = args.find(a => !a.startsWith('--'));

  if (history.length === 0) {
    console.log(`  ${dim('(no tool calls recorded this session)')}`);
    console.log(`  ${dim('Tool calls are tracked from now on — /thinkback will show future calls.')}`);
    return;
  }

  // Determine which entries to show
  let entries = [...history];
  if (toolFilter) {
    entries = entries.filter(e => e?.name?.toLowerCase().includes(toolFilter));
    if (entries.length === 0) {
      console.log(`  ${yellow('!')} No tool calls matching "${toolFilter}"`);
      return;
    }
  }
  if (!showAll && !toolFilter) {
    entries = entries.slice(-200);
  }

  // Group entries into turns (roughly: entries around the same time)
  const turnBreak = 10_000; // 10s gap = new turn
  const grouped: { startTs: string; calls: Array<typeof entries[0]> }[] = [];
  let currentGroup: { startTs: string; calls: Array<typeof entries[0]> } | null = null;
  let prevTs = 0;

  for (const e of entries) {
    const t = new Date(e.timestamp).getTime();
    if (!currentGroup || t - prevTs > turnBreak) {
      currentGroup = { startTs: e.timestamp, calls: [] };
      grouped.push(currentGroup);
    }
    currentGroup.calls.push(e);
    prevTs = t;
  }

  const okCount = entries.filter(e => e?.ok).length;
  const failCount = entries.filter(e => !e?.ok).length;
  const totalMs = entries.reduce((s, e) => s + e.durationMs, 0);

  // Header
  console.log(`  ${bold('Tool call history')} ${dim(`(${history.length} total · showing ${entries.length})`)}`);
  console.log(`  ${dim('ok:')} ${green(String(okCount))}  ${dim('fail:')} ${failCount > 0 ? red(String(failCount)) : dim('0')}  ${dim('total:')} ${dim(fmtDuration(totalMs))}`);
  console.log();

  // Turn groups
  for (const g of grouped) {
    if (grouped.length > 1) {
      console.log(`  ${dim('── ' + fmtTimestamp(g.startTs) + ' ──')}`);
    }
    for (const tc of g.calls) {
      const okMark = tc.ok ? green('✓') : red('✗');
      const inputPreview = previewInput(tc.input);
      const durationStr = dim(fmtDuration(tc.durationMs));
      const nameStr = tc.ok ? cyan(tc.name) : yellow(tc.name);
      const timeStr = dim(fmtTimestamp(tc.timestamp));

      if (showRaw) {
        console.log(`  ${okMark} ${nameStr} ${timeStr} ${durationStr}`);
        console.log(`      ${dim('input:')}  ${JSON.stringify(tc.input).slice(0, 200)}`);
        console.log(`      ${dim('output:')} ${tc.output.slice(0, 200)}`);
      } else if (tc.ok) {
        const outputPreview = previewOutput(tc.output);
        if (inputPreview) {
          console.log(`  ${okMark} ${nameStr} ${cyan('·')} ${dim(inputPreview)} ${durationStr}`);
        } else {
          console.log(`  ${okMark} ${nameStr} ${durationStr}`);
        }
      } else {
        const errPreview = previewOutput(tc.output);
        console.log(`  ${okMark} ${nameStr} ${red(errPreview)} ${durationStr}`);
      }
    }
  }

  // Footer
  console.log();
  console.log(`  ${dim('Use /thinkback <name> to filter (e.g. /thinkback Read), /thinkback --raw for full JSON,')}`);
  console.log(`  ${dim('/thinkback --all to see everything, /thinkback <N> to view last N calls.')}`);
}

export const THINKBACK_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/thinkback', '/tb'], handler: handleSlashThinkback },
];
