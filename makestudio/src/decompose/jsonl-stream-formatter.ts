/**
 * jsonl-stream-formatter.ts
 *
 * Shared parser for the JSONL stream emitted by `makestudio -p --json` and
 * `claude -p --output-format stream-json`. Converts each parsed line into a
 * human-readable terminal line. Used by:
 *   - `analyze.ts` (deep-analysis subprocess)
 *   - `structure-pass.ts` / `enrich-pass.ts` (decomposition subprocesses)
 *
 * Why this exists: the inner subprocess (`makestudio -p --json`) emits one
 * JSON object per line during the tool loop — `{type:'log',message}` for
 * info, `{type:'assistant',text}` for the final answer, etc. Without parsing
 * the parent shows nothing during the multi-minute tool loop and the user
 * thinks it's hung. Parsing each line as it arrives gives the same live
 * feedback claude-code shows in the foreground.
 *
 * Format coverage:
 *   - makestudio JSONL: `{type: 'log'|'info'|'error'|'assistant', ...}`
 *   - claude stream-JSON: `{type: 'assistant', message: {content: [{type: 'tool_use'|'text', ...}]}}`
 *   - codex / gemini / makestudio plain text fallback (no JSON).
 *
 * Caller decides where the formatted line lands (stdout, debug log, both).
 */

import chalk from 'chalk';

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');

export interface FormattedLine {
  /** What to show in the terminal — already styled with chalk colors. */
  display: string;
  /** Whether this line counts as "activity" (resets the heartbeat / "stuck" timer). */
  hadActivity: boolean;
  /** When the inner CLI emitted a final assistant text, surface it here so
   *  callers that need the result (analyze.ts) can capture it. */
  resultText?: string;
  /** Number of tool calls observed in this line — increments parent counters. */
  toolCallCount?: number;
  /** Cost reported by the inner CLI, if any. Only stream-JSON `result` events
   *  carry this today. */
  costUsd?: number;
}

/**
 * Format a single line of subprocess output. Returns null when the line is
 * empty or pure noise (system events, rate limit pings, etc).
 *
 * @param line - one full line from stdout / stderr (already split by `\n`)
 * @param prefix - terminal prefix the caller wants on every formatted line
 *                 (e.g. `dim('│')` for nested decomposition output)
 */
export function formatStreamLine(line: string, prefix: string = ''): FormattedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // ── 1. Try JSON parse ───────────────────────────────────────────────
  let parsed: any = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — fall through to plain-text branch below.
  }

  if (parsed && typeof parsed === 'object') {
    return formatJsonLine(parsed, prefix);
  }

  // ── 2. Plain text fallback ──────────────────────────────────────────
  // Used by codex / gemini / makestudio without --json. We strip ANSI
  // because the inner CLI may already be coloring its own output and we
  // don't want double-coloring; the chalk wrapper below puts the line
  // in dim grey to distinguish it from the parent's own output.
  if (trimmed.length < 3 || trimmed.length > 500) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = trimmed.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return {
    display: `${prefix}${dim('·')} ${dim(stripped)}`,
    hadActivity: true,
  };
}

function formatJsonLine(p: any, prefix: string): FormattedLine | null {
  const t = p.type;

  // ── makestudio -p --json shape ──────────────────────────────────────
  if (t === 'info' && typeof p.message === 'string') {
    return { display: `${prefix}${dim('ℹ')} ${dim(p.message)}`, hadActivity: false };
  }
  if (t === 'log' && typeof p.message === 'string') {
    // Tool-loop console.log forwarded by runHeadless's shim. The agent's
    // chat.ts prints tool calls as `[tool] Name(...)` and tool results
    // as the result preview, so we forward them verbatim.
    const m = p.message.trim();
    if (!m) return null;
    // Highlight tool invocations specifically: `[tool] Read (file_path=...)`
    const toolMatch = m.match(/^\s*\[tool\]\s+(\w+)\s*(.*)$/);
    if (toolMatch) {
      const [, name, rest] = toolMatch;
      return {
        display: `${prefix}${cyan('▸')} ${cyan(name)} ${dim(rest.replace(/^\(|\)$/g, ''))}`,
        hadActivity: true,
        toolCallCount: 1,
      };
    }
    return { display: `${prefix}${dim('·')} ${dim(m)}`, hadActivity: true };
  }
  if (t === 'error' && typeof p.message === 'string') {
    return { display: `${prefix}${red('✗')} ${red(p.message)}`, hadActivity: true };
  }
  if (t === 'assistant' && typeof p.text === 'string') {
    const text = p.text.trim();
    if (!text) return null;
    return {
      display: `${prefix}${green('●')} ${text.length > 200 ? text.slice(0, 200) + '…' : text}`,
      hadActivity: true,
      resultText: text,
    };
  }

  // ── claude stream-JSON shape ────────────────────────────────────────
  if (t === 'assistant' && p.message?.content && Array.isArray(p.message.content)) {
    const blocks = p.message.content as any[];
    const lines: string[] = [];
    let toolCalls = 0;
    let resultText: string | undefined;
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        toolCalls++;
        const name = b.name || 'unknown';
        const input = b.input || {};
        const detail =
          input.file_path ||
          input.path ||
          input.pattern ||
          (typeof input.command === 'string' ? input.command.slice(0, 100) : '') ||
          (typeof input.query === 'string' ? input.query.slice(0, 80) : '') ||
          '';
        lines.push(`${prefix}${cyan('▸')} ${cyan(name)}${detail ? ' ' + dim(detail) : ''}`);
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const text = b.text.trim();
        if (!text) continue;
        if (text.length < 500) {
          lines.push(`${prefix}${dim('·')} ${dim(text)}`);
        }
        resultText = text;
      }
    }
    if (lines.length === 0) return null;
    return {
      display: lines.join('\n'),
      hadActivity: true,
      toolCallCount: toolCalls || undefined,
      resultText,
    };
  }

  if (t === 'result') {
    const cost = p.total_cost_usd || 0;
    const turns = p.num_turns || 0;
    return {
      display: `${prefix}${green('✓')} ${dim(`${turns} turns · $${cost.toFixed(4)}`)}`,
      hadActivity: true,
      resultText: typeof p.result === 'string' ? p.result : undefined,
      costUsd: cost,
    };
  }

  // ── Noise (system events, rate-limit pings, user echoes) ────────────
  if (t === 'system' || t === 'user' || t === 'rate_limit_event') return null;

  // ── Unknown JSON — show key + truncated content for visibility ──────
  const preview = JSON.stringify(p).slice(0, 200);
  return {
    display: `${prefix}${blue('?')} ${dim(preview)}`,
    hadActivity: false,
  };
}

/**
 * Stream parser — buffers partial lines and emits one FormattedLine per
 * complete line. Use one instance per stream (stdout, stderr) per process.
 */
export class JsonlStreamReader {
  private buffer = '';
  constructor(private readonly prefix: string = '') {}

  /** Feed a chunk of bytes (from `proc.stdout.on('data')`). */
  push(chunk: Buffer | string): FormattedLine[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // last segment is incomplete
    const out: FormattedLine[] = [];
    for (const line of lines) {
      const f = formatStreamLine(line, this.prefix);
      if (f) out.push(f);
    }
    return out;
  }

  /** Flush any remaining buffered content (call on `proc.on('close')`). */
  flush(): FormattedLine[] {
    if (!this.buffer.trim()) return [];
    const f = formatStreamLine(this.buffer, this.prefix);
    this.buffer = '';
    return f ? [f] : [];
  }
}

// Re-export the chalk wrappers callers use to compose their own prefixes.
export const dimC = dim;
export const cyanC = cyan;
export const greenC = green;
export const yellowC = yellow;
