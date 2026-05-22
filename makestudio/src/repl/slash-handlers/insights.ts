import { readdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getSessionId } from '../debug-log';
import type { SlashCommand, SlashContext } from '../slash-registry';

// ── Types ─────────────────────────────────────────────────
interface DebugEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

interface SessionSummary {
  id: string;
  pid: number;
  argv: string;
  startTs: number;
  endTs: number | null;
  modelCounts: Record<string, number>;
  modelTokens: Record<string, number>;
  toolCounts: Record<string, number>;
  llmCalls: number;
  errorCount: number;
  isCurrent: boolean;
}

// ── Constants ─────────────────────────────────────────────
const DEBUG_DIR = join(homedir(), '.makestudio', 'debug');

// /insights focuses on USAGE PATTERNS — sessions, tokens, tool counts,
// duration, errors. It does NOT estimate $$ costs: that's the job of
// /cost which already owns the pricing table (commands.ts:183). Keeping
// pricing in one place avoids the "duplicated and divergent rate cards"
// trap (see CLAUDE.md hardcode rule).

const MAX_SESSION_FILES = 50;  // most recent N debug logs (perf cap)

// Colored ASCII helpers — no chalk dep, pure ANSI
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

function c(color: string, s: string): string {
  return `${color}${s}${RESET}`;
}

function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

// ── Helpers ───────────────────────────────────────────────
function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (min < 60) return `${min}m ${s}s`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 19);
}

// ── Bar chart (ASCII) ─────────────────────────────────────
function asciiBar(value: number, max: number, width: number): string {
  if (max === 0) return dim('·'.repeat(width));
  const filled = Math.round((value / max) * width);
  return c(CYAN, '█'.repeat(filled)) + dim('░'.repeat(Math.max(0, width - filled)));
}

// ── Parse debug logs ──────────────────────────────────────
function parseSessionLog(filePath: string, currentSessionId?: string): SessionSummary | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    let sessionId = '';
    let pid = 0;
    let argv = '';
    let startTs = 0;
    let endTs: number | null = null;
    const modelCounts: Record<string, number> = {};
    const modelTokens: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    let llmCalls = 0;
    let errorCount = 0;

    for (const line of lines) {
      const ev: DebugEvent = JSON.parse(line);
      if (!ev.ts) continue;
      const ts = new Date(ev.ts).getTime();

      switch (ev.type) {
        case 'session_start':
          sessionId = ev.sessionId as string || '';
          pid = (ev.pid as number) || 0;
          argv = (ev.argv as string) || '';
          startTs = ts;
          break;
        case 'session_end':
          endTs = ts;
          break;
        case 'llm_request': {
          const model = (ev.model as string) || 'unknown';
          modelCounts[model] = (modelCounts[model] || 0) + 1;
          llmCalls++;
          break;
        }
        case 'llm_response': {
          const model = (ev.model as string) || 'unknown';
          const tokensOut = (ev.tokensOut as number) || 0;
          modelTokens[model] = (modelTokens[model] || 0) + tokensOut;
          break;
        }
        case 'tool_call': {
          const tool = (ev.tool as string) || 'unknown';
          if (!tool.startsWith('_')) {
            toolCounts[tool] = (toolCounts[tool] || 0) + 1;
          }
          break;
        }
        case 'tool_result': {
          const err = ev.error as string;
          if (err) errorCount++;
          break;
        }
        case 'bash_end': {
          const code = ev.exitCode as number;
          if (code && code !== 0) errorCount++;
          break;
        }
      }

      // Track last event timestamp as end if no explicit session_end
      if (!endTs || ts > endTs) endTs = ts;
    }

    if (!sessionId) return null;

    return {
      id: sessionId,
      pid,
      argv,
      startTs,
      endTs,
      modelCounts,
      modelTokens,
      toolCounts,
      llmCalls,
      errorCount,
      isCurrent: sessionId === currentSessionId,
    };
  } catch {
    return null;
  }
}

// ── Report builder ────────────────────────────────────────
function buildReport(sessions: SessionSummary[], currentUsage: any): string {
  const lines: string[] = [];

  // ── Header ──
  lines.push('');
  lines.push(` ${c(BOLD, c(CYAN, '◆  MakeStudio Insights'))}  ${dim(now())}`);
  lines.push(` ${dim('─'.repeat(60))}`);

  // ── Summary ──
  const activeSessions = sessions.filter((s) => s.isCurrent || s.endTs);
  const totalTokens = Object.values(sessions.reduce((acc, s) => {
    for (const [m, t] of Object.entries(s.modelTokens)) {
      acc[m] = (acc[m] || 0) + t;
    }
    return acc;
  }, {} as Record<string, number>)).reduce((a, b) => a + b, 0);

  const totalToolCalls = sessions.reduce((sum, s) => {
    return sum + Object.values(s.toolCounts).reduce((a, b) => a + b, 0);
  }, 0);

  const totalDuration = sessions.reduce((sum, s) => {
    if (s.startTs && s.endTs) return sum + (s.endTs - s.startTs);
    return sum;
  }, 0);

  // Current session stats (from ctx.usage)
  const cur = currentUsage;
  const curTokens = cur?.totalTokens || 0;

  // Show metrics side-by-side
  const metric = (label: string, hist: string, curVal: string) => {
    lines.push(
      `  ${label.padEnd(20)} ${dim('∑')} ${c(CYAN, hist.padEnd(12))} ${dim('now')} ${c(GREEN, curVal)}`
    );
  };

  lines.push('');
  lines.push(` ${bold('Sessions')}`);
  metric('Sessions', `${sessions.length}`, activeSessions.filter((s) => s.isCurrent).length ? '1 active' : '—');
  metric('LLM Tokens', fmt(totalTokens), fmt(curTokens));
  metric('Tool Calls', fmt(totalToolCalls), fmt(currentUsage?.requestCount || 0));
  metric('Duration', fmtDuration(totalDuration), cur?.sessionStartedAt ? fmtDuration(Date.now() - cur.sessionStartedAt) : '—');
  metric('Errors', `${sessions.reduce((s, ss) => s + ss.errorCount, 0)}`, '—');
  lines.push(`  ${dim('(for $$ estimates run /cost or /usage — they own the pricing source)')}`);

  // ── Session Timeline ──
  if (sessions.length > 0) {
    lines.push('');
    lines.push(` ${bold('Sessions Over Time')}`);

    // Group by day
    const dayGroups: Record<string, { sessions: number; tokens: number; calls: number }> = {};
    for (const s of sessions) {
      const day = fmtDate(s.startTs);
      if (!dayGroups[day]) dayGroups[day] = { sessions: 0, tokens: 0, calls: 0 };
      dayGroups[day].sessions++;
      dayGroups[day].tokens += Object.values(s.modelTokens).reduce((a, b) => a + b, 0);
      dayGroups[day].calls += s.llmCalls;
    }

    const days = Object.keys(dayGroups).sort();
    const maxSessions = Math.max(...days.map((d) => dayGroups[d].sessions), 1);
    const barW = 25;

    for (const day of days.slice(-14)) {
      const g = dayGroups[day];
      const bar = asciiBar(g.sessions, maxSessions, barW);
      const today = day === fmtDate(Date.now()) ? c(GREEN, ' ← today') : '';
      lines.push(`  ${dim(day)} ${bar} ${c(CYAN, `${g.sessions}s`)} ${dim(`· ${fmt(g.tokens)} tok`)}${today}`);
    }
  }

  // ── Tool Usage ──
  const allTools: Record<string, number> = {};
  for (const s of sessions) {
    for (const [t, cnt] of Object.entries(s.toolCounts)) {
      allTools[t] = (allTools[t] || 0) + cnt;
    }
  }
  const toolEntries = Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 12);

  if (toolEntries.length > 0) {
    lines.push('');
    lines.push(` ${bold('Tool Usage')}`);
    const maxTool = toolEntries[0][1];
    const barW = 20;
    for (const [tool, count] of toolEntries) {
      const bar = asciiBar(count, maxTool, barW);
      lines.push(`  ${tool.padEnd(18)} ${bar} ${c(CYAN, count.toString())}`);
    }
  }

  // ── Model Usage ──
  const allModels: Record<string, { calls: number; tokens: number }> = {};
  for (const s of sessions) {
    for (const [m, cnt] of Object.entries(s.modelCounts)) {
      if (!allModels[m]) allModels[m] = { calls: 0, tokens: 0 };
      allModels[m].calls += cnt;
      allModels[m].tokens += s.modelTokens[m] || 0;
    }
  }
  const modelEntries = Object.entries(allModels).sort((a, b) => b[1].tokens - a[1].tokens);

  if (modelEntries.length > 0) {
    lines.push('');
    lines.push(` ${bold('Models')}`);
    lines.push(`  ${dim('Model'.padEnd(22))} ${dim('Calls'.padEnd(7))} ${dim('Tokens')}`);
    for (const [model, info] of modelEntries) {
      lines.push(
        `  ${model.padEnd(22)} ${c(CYAN, String(info.calls).padStart(6))} ${c(YELLOW, fmt(info.tokens).padStart(9))}`
      );
    }
  }

  // ── Top Sessions ──
  const ranked = sessions
    .filter((s) => Object.values(s.modelTokens).reduce((a, b) => a + b, 0) > 0)
    .sort((a, b) => {
      const aT = Object.values(a.modelTokens).reduce((s, v) => s + v, 0);
      const bT = Object.values(b.modelTokens).reduce((s, v) => s + v, 0);
      return bT - aT;
    })
    .slice(0, 5);

  if (ranked.length > 0) {
    lines.push('');
    lines.push(` ${bold('Top Sessions by Tokens')}`);
    lines.push(`  ${dim('Date'.padEnd(12))} ${dim('Tokens'.padEnd(10))} ${dim('Calls'.padEnd(7))} ${dim('ID')}`);
    for (const s of ranked) {
      const t = Object.values(s.modelTokens).reduce((a, b) => a + b, 0);
      const cCalls = s.llmCalls;
      const date = fmtDate(s.startTs);
      const id = s.id.slice(0, 8);
      const marker = s.isCurrent ? c(GREEN, ' ← active') : '';
      lines.push(
        `  ${date.padEnd(12)} ${c(YELLOW, fmt(t).padStart(9))} ${c(CYAN, String(cCalls).padStart(6))} ${dim(id)}${marker}`
      );
    }
  }

  // ── Current session detail ──
  if (cur) {
    lines.push('');
    lines.push(` ${bold('Current Session')}`);
    lines.push(`  ${dim('Prompt Tokens:')}  ${fmt(cur.promptTokens || 0)}`);
    lines.push(`  ${dim('Completion:')}    ${fmt(cur.completionTokens || 0)}`);
    lines.push(`  ${dim('Total:')}         ${c(YELLOW, fmt(cur.totalTokens || 0))}`);
    lines.push(`  ${dim('Cache Reads:')}   ${fmt(cur.cacheReads || 0)}`);
    lines.push(`  ${dim('Cache Writes:')}  ${fmt(cur.cacheWrites || 0)}`);
    lines.push(`  ${dim('Requests:')}      ${cur.requestCount || 0}`);
    if (cur.sessionStartedAt) {
      lines.push(`  ${dim('Duration:')}      ${fmtDuration(Date.now() - cur.sessionStartedAt)}`);
    }

    // By origin breakdown
    if (cur.byOrigin) {
      lines.push(`  ${dim('By origin:')}`);
      const origins = cur.byOrigin as Record<string, { totalTokens?: number; requestCount?: number }>;
      for (const [origin, data] of Object.entries(origins)) {
        const tot = data.totalTokens || 0;
        if (tot > 0) {
          lines.push(`    ${origin.padEnd(10)} ${fmt(tot).padStart(9)} tok  ${data.requestCount ?? 0} req`);
        }
      }
    }
  }

  // ── Footer ──
  lines.push('');
  lines.push(` ${dim('─'.repeat(60))}`);
  lines.push(` ${dim('Session logs:')} ${dim(DEBUG_DIR)}`);
  lines.push('');

  return lines.join('\n');
}

// ── Handler ───────────────────────────────────────────────
function handler(sc: SlashContext): void {
  const ctx = sc.ctx;

  // Parse all debug logs
  const sessions: SessionSummary[] = [];
  const curSessionId = getSessionId();

  if (existsSync(DEBUG_DIR)) {
    const files = readdirSync(DEBUG_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse() // newest first
      .slice(0, MAX_SESSION_FILES); // perf cap — parsing 130+ JSONLs is slow

    for (const file of files) {
      const ss = parseSessionLog(join(DEBUG_DIR, file), curSessionId);
      if (ss) sessions.push(ss);
    }
  }

  // Add current session from context if it has data
  const currentUsage = ctx.usage?.totalTokens ? ctx.usage : null;

  const report = buildReport(sessions, currentUsage);
  console.log(report);
}

// ── Register ──────────────────────────────────────────────
// /stats is intentionally NOT aliased here — it's already owned by
// model.ts:391 (handleSlashStats) which shows the per-session totals
// + /by-origin breakdown. Re-binding it would silently override the
// existing handler depending on registration order.
export const INSIGHTS_SLASH_COMMANDS: SlashCommand[] = [
  {
    names: ['/insights', '/insight', '/dashboard'],
    handler,
  },
];
