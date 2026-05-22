/**
 * bash-failure-memory.ts
 *
 * Per-turn memory of failed Bash commands. When the model emits a new
 * Bash whose normalised shape is highly similar to one that ALREADY
 * failed this turn, refuse to dispatch — return the previous error
 * inline instead of paying for another LLM round-trip just to discover
 * the same failure.
 *
 * Observed failure mode: model emits `cat > /tmp/x.py << 'EOF' …` with
 * a quoting bug, gets `unexpected EOF`. Model emits the same heredoc
 * with a different escape, fails again. Three retries before the
 * shell-parse hint (fix #5) finally lands. Each retry is one LLM round
 * trip, ~5-15s of latency.
 *
 * State lives on ctx, rotated per __turnSeq (matches tool-dedup).
 */

const MAX_RECENT = 5;
const SIM_THRESHOLD = 0.75;

interface BashFailureRecord {
  /** Original command, capped for storage. */
  cmd: string;
  /** Normalised shape used for similarity comparison. */
  shape: string;
  /** Truncated stderr — what to surface to the model on a duplicate. */
  error: string;
  /** Wall-clock at failure time, for the "Xs ago" message. */
  at: number;
}

interface BashFailureState {
  turnSeq: number;
  failures: BashFailureRecord[];
}

function getState(ctx: any): BashFailureState {
  const currentTurn = (ctx.__turnSeq as number) || 0;
  let s = ctx.__bashFailureMemory as BashFailureState | undefined;
  if (!s || s.turnSeq !== currentTurn) {
    s = { turnSeq: currentTurn, failures: [] };
    ctx.__bashFailureMemory = s;
  }
  return s;
}

/**
 * Pure: normalise a bash command for shape comparison. Lower-case,
 * collapse whitespace, strip common quote chars (so quote-rotation
 * variants of the same command have the same shape), drop trailing
 * punctuation. The goal is "this command differs only in quote
 * escaping" → identical shape.
 */
export function normalizeBashCommand(cmd: string): string {
  return cmd
    .toLowerCase()
    .replace(/['"`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure: Jaccard similarity over space-split tokens. 0..1 inclusive. */
export function jaccardSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Look up whether `command` is shape-similar to a recent failure on
 * this ctx/turn. Returns the rejection message when blocked, null when
 * the command should proceed normally.
 */
export function checkRepeatedFailure(ctx: any, command: string): string | null {
  const state = getState(ctx);
  if (state.failures.length === 0) return null;
  const newShape = normalizeBashCommand(command);
  for (const f of state.failures) {
    const sim = jaccardSimilarity(newShape, f.shape);
    if (sim >= SIM_THRESHOLD) {
      const ageS = Math.max(1, Math.round((Date.now() - f.at) / 1000));
      const pct = Math.round(sim * 100);
      return [
        `[blocked-by-failure-memory] This command is ${pct}% similar to one that failed ${ageS}s ago in this turn:`,
        `  earlier cmd: ${f.cmd.slice(0, 200)}`,
        `  earlier err: ${f.error.slice(0, 240)}`,
        '',
        'Refusing to dispatch the near-duplicate. Pick a different approach. For long inline scripts:',
        '  1. Write the body to /tmp/<name>.{sh,py} via the Write tool.',
        '  2. Run it with `bash /tmp/<name>.sh` — quote escaping stops mattering.',
      ].join('\n');
    }
  }
  return null;
}

/** Record a fresh failure for future similarity checks. */
export function recordBashFailure(ctx: any, command: string, error: string): void {
  const state = getState(ctx);
  state.failures.push({
    cmd: command.slice(0, 400),
    shape: normalizeBashCommand(command),
    error: error.slice(0, 400),
    at: Date.now(),
  });
  while (state.failures.length > MAX_RECENT) state.failures.shift();
}

/**
 * Heuristic: was THIS exit a "shell-level" failure (parse error,
 * unbalanced quotes, missing heredoc terminator)? Those are the cases
 * worth memorising — a normal program-level exit (e.g. `false` returns 1)
 * is not worth blocking similar future commands on.
 */
export function isShellLevelFailure(stderr: string, exitCode: number): boolean {
  if (!stderr) return false;
  const err = stderr.toLowerCase();
  const PARSE_MARKERS = [
    'unexpected eof',
    'bash: -c: line',
    'bash: -c: linha',
    'unterminated quoted string',
    'syntax error near unexpected token',
    'syntax error: unexpected end of file',
  ];
  if (PARSE_MARKERS.some((p) => err.includes(p))) return true;
  // exit 2 with stderr starting with `bash:` is the "command not found"
  // family — also worth memorising so the model doesn't spam variants.
  if (exitCode === 2 && /^bash:\s/.test(stderr)) return true;
  return false;
}
