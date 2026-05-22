/**
 * diagnostic-streak.ts — detect when the model is stuck investigating
 * without ever editing. Inspired by the real failure mode observed
 * 2026-05-04: a refactor turn ran 65+ tool calls in a row with
 * `textLen: 0` on every LLM response, all of them grep / Read / find,
 * never an Edit — model already had the answer in earlier results
 * but kept stalling.
 *
 * Each tool is classified into DIAGNOSTIC (reads context) or PROGRESS
 * (mutates state); some are NEUTRAL (TodoWrite, dispatch_agent, etc.)
 * and don't affect the streak. We track a per-turn counter of
 * consecutive diagnostic-only tool calls. When it crosses
 * SOFT_THRESHOLD without a single progress call, we inject a
 * system-reminder pushing the model to act. The streak resets the
 * moment a progress tool runs.
 *
 * Off-by-default the value isn't useful — the rule is what matters,
 * so this is ON by default. Disable via settings.diagnosticStreakBreaker
 * = false or env MAKESTUDIO_DIAG_STREAK=0.
 */

const SOFT_THRESHOLD = 5;
// Turn-wide accumulator catches the "fake progress to reset the counter"
// evasion: Read×4 + trivial Edit + Read×4 + trivial Edit + …. The streak
// counter alone resets each progress, so it never reaches SOFT_THRESHOLD,
// but the user is paying for 15+ diagnostics in one turn. Once the
// total crosses TURN_TOTAL_THRESHOLD we fire a stronger reminder
// regardless of the streak.
const TURN_TOTAL_THRESHOLD = 15;

let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const env = (process.env.MAKESTUDIO_DIAG_STREAK || '').toLowerCase().trim();
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    const s = loadSettings() as any;
    cachedEnabled = s?.diagnosticStreakBreaker !== false;
    return cachedEnabled;
  } catch { cachedEnabled = true; return true; }
}

export function resetDiagnosticStreakCache(): void { cachedEnabled = null; }

const DIAGNOSTIC_TOOL_NAMES = new Set([
  'Read', 'read_file',
  'Glob', 'Grep',
  'WebFetch', 'web_fetch',
  'lsp_definition', 'lsp_references', 'lsp_hover',
  'lsp_workspace_symbol', 'lsp_document_symbol',
  'lsp_diagnostics',
]);

const PROGRESS_TOOL_NAMES = new Set([
  'Edit', 'edit_file',
  'Write', 'write_file',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
]);

// Bash splits diagnostic vs progress by command shape — `git log` is
// just reading state, `git commit` mutates it.
const BASH_DIAGNOSTIC_HEAD = /^(grep|rg|find|ls|cat|head|tail|wc|tree|file|du|df|stat|sed -n |awk |which|type|whereis|pwd|env|printenv|date|whoami|id|uname|node --version|npm ls|npm list|git\s+(log|diff|show|status|branch|remote|blame|reflog|describe|tag\s+--list|stash\s+list))/;
const BASH_PROGRESS_HEAD = /^(npm |yarn |pnpm |bun |node |npx |tsc|nest|webpack|vite|jest|vitest|mocha|playwright|cypress|deno |go |cargo |rustc|gcc |g\+\+|make |ninja |bazel |gradle|mvn |sbt |composer|pip |poetry|uv |ruby |bundle |rails |python |django|flask|kubectl|docker|podman|terraform|ansible|systemctl|sudo|chmod|chown|mkdir|touch|cp |mv |rm |ln |sed -i|tee |dd |truncate|tar |zip |unzip|gpg |openssl|curl -[XPpd]|wget |scp |rsync |git\s+(commit|push|merge|rebase|reset|checkout|cherry-pick|stash\s+(push|pop|drop|clear)|tag\s+(?!--list)|am |bisect|clone|init|add|rm|mv|notes\s+add|notes\s+remove|worktree\s+(add|remove)|fetch|pull))/;

export type ToolKind = 'diagnostic' | 'progress' | 'neutral';

export function classifyTool(toolName: string, toolInput: any): ToolKind {
  if (DIAGNOSTIC_TOOL_NAMES.has(toolName)) return 'diagnostic';
  if (PROGRESS_TOOL_NAMES.has(toolName)) return 'progress';
  if (toolName === 'Bash' || toolName === 'shell_run') {
    const cmd = String(toolInput?.command || '').trim();
    if (!cmd) return 'neutral';
    if (BASH_DIAGNOSTIC_HEAD.test(cmd)) return 'diagnostic';
    if (BASH_PROGRESS_HEAD.test(cmd)) return 'progress';
    return 'neutral';
  }
  // TodoWrite, AskUserQuestion, dispatch_agent, get_project, etc. don't
  // count toward the streak in either direction.
  return 'neutral';
}

export interface StreakOutcome {
  /** Soft hint to inject as a `user`-role system-reminder. Empty when
   *  the streak hasn't crossed the threshold yet, or already fired
   *  this turn. */
  softHint?: string;
  /** Current consecutive diagnostic count (for diagnostics / /diagnose). */
  streak: number;
}

/**
 * Update the per-context streak counter and return what should happen.
 * Caller passes the just-completed tool's name + input; we mutate
 * ctx.__diagnosticStreak and ctx.__diagnosticStreakHintFired.
 */
export function noteToolForStreak(
  ctx: any,
  toolName: string,
  toolInput: any,
): StreakOutcome {
  if (!ctx) return { streak: 0 };
  if (!isEnabled()) return { streak: 0 };

  const kind = classifyTool(toolName, toolInput);
  if (kind === 'progress') {
    ctx.__diagnosticStreak = 0;
    ctx.__diagnosticStreakHintFired = false;
    return { streak: 0 };
  }
  if (kind === 'neutral') {
    return { streak: ctx.__diagnosticStreak || 0 };
  }
  // diagnostic — bump both streak and turn-total
  const streak = (ctx.__diagnosticStreak || 0) + 1;
  ctx.__diagnosticStreak = streak;
  const turnTotal = (ctx.__diagnosticTurnTotal || 0) + 1;
  ctx.__diagnosticTurnTotal = turnTotal;

  if (streak >= SOFT_THRESHOLD && !ctx.__diagnosticStreakHintFired) {
    ctx.__diagnosticStreakHintFired = true;
    return { streak, softHint: buildHint(streak) };
  }
  // Turn-wide check — defeats the "1 fake Edit resets the counter" evasion.
  // Fires once per turn even if streak never reached SOFT_THRESHOLD.
  if (turnTotal >= TURN_TOTAL_THRESHOLD && !ctx.__diagnosticTurnHintFired) {
    ctx.__diagnosticTurnHintFired = true;
    return { streak, softHint: buildTurnHint(turnTotal) };
  }
  return { streak };
}

function buildHint(streak: number): string {
  return (
    `<system-reminder>` +
    `You've made ${streak} consecutive diagnostic tool calls (Read/Grep/Glob/Bash-search) ` +
    `WITHOUT a single progress tool call (Edit/Write/MultiEdit/Bash-build/test/commit). ` +
    `This is the "stuck investigating" pattern — you already have the information you need.\n\n` +
    `Pick ONE now:\n` +
    `  (a) Make the edit you've been preparing — the answer is in your prior tool results.\n` +
    `  (b) Run \`tsc --noEmit\` (or the project's build) to get the FULL error panorama instead of greping symbols one by one.\n` +
    `  (c) State honestly: "I can't find X" or ask the user for direction.\n\n` +
    `Do NOT issue another Read/Grep/Glob/find/ls before doing one of (a)/(b)/(c). ` +
    `If your next tool is diagnostic again, you are stalling — and the user is paying for it.` +
    `</system-reminder>`
  );
}

function buildTurnHint(total: number): string {
  return (
    `<system-reminder>` +
    `${total} diagnostic tool calls in this turn — well past the budget for "investigating". ` +
    `Even with intervening edits, this is a turn dominated by exploration. The pattern usually ` +
    `means the model is dancing around the actual change instead of committing to it.\n\n` +
    `STOP gathering more context. With ${total} read-shaped calls, you have it. Either:\n` +
    `  (a) Make the substantive change you've been circling around — full Edit/MultiEdit/Write, not a placeholder.\n` +
    `  (b) Stop and ask the user; the task may not be tractable from current information.\n\n` +
    `If your next action is another Read/Grep/Glob you are stalling.` +
    `</system-reminder>`
  );
}

export function resetDiagnosticStreak(ctx: any): void {
  if (!ctx) return;
  ctx.__diagnosticStreak = 0;
  ctx.__diagnosticStreakHintFired = false;
  ctx.__diagnosticTurnTotal = 0;
  ctx.__diagnosticTurnHintFired = false;
}
