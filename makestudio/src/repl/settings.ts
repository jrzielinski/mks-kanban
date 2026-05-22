import { swallow } from '../utils/log';
/**
 * settings.ts
 *
 * User-level preferences persisted in ~/.makestudio/settings.json.
 * Consumed by slash commands (/theme, /output-style, /vim, /fast,
 * /keybindings, /statusline) and by the TUI on boot.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type OutputStyle = 'default' | 'terse' | 'verbose' | 'explain' | 'code-only';
export type Theme = 'default' | 'classic' | 'dark' | 'light' | 'monokai' | 'dracula' | 'solarized' | 'fedora' | 'ubuntu' | 'arch' | 'gruvbox' | 'nord' | 'code';
/**
 * Chat-bar accent — quick way to recolour the input box border + bar
 * indicators without picking a whole theme. Equivalent to Claude Code's
 * `/color <name>` slash command. `default` falls back to the active
 * theme's `inputBorder` slot.
 */
export type ChatColor = 'default' | 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan' | 'magenta' | 'white' | 'gray';

export interface Settings {
  version: 1;
  theme: Theme;
  /** Chat-bar accent (overrides theme.inputBorder when set to anything
   *  other than 'default'). Set via `/color <name>`. */
  chatColor?: ChatColor;
  outputStyle: OutputStyle;
  vimMode: boolean;
  fastMode: boolean;
  keybindings: Record<string, string>; // action → key combo (e.g. "historyPrev": "up")
  statusline: {
    fields: string[]; // order of fields to show
  };
  workingDirs: string[]; // extra directories the agent can access
  /** Count of REPL boots — used by tips rotation to compute "sessions since last shown". */
  numStartups: number;
  /** tipId → numStartups when last shown. */
  tipsHistory: Record<string, number>;
  /** Disable the welcome-banner tip line. */
  tipsDisabled?: boolean;
  /** Disable the post-turn prompt-suggestion feature (PromptSuggestion). */
  suggestionsDisabled?: boolean;
  /** Disable the "welcome back" recap after idle gaps (AwaySummary). */
  awaySummaryDisabled?: boolean;
  /**
   * PermissionMode (Fase 2.6). Controls the session-wide policy baseline
   * that runs BEFORE the rule engine in permissions.ts.
   *   - default: normal (rules decide; unmatched → policy.default)
   *   - plan: Edit/Write/MultiEdit blocked
   *   - acceptEdits: Edit/Write/MultiEdit auto-allowed, Bash still asks
   *   - bypassPermissions: everything auto-allowed unless a deny rule matches
   *   - dontAsk: ask-rules treated as allow; deny still denies
   */
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
  /** Disable MagicDocs auto-update after each turn. */
  magicDocsDisabled?: boolean;
  /** Disable snapshot-on-edit (fileHistory). Disables /undo-file. */
  fileHistoryDisabled?: boolean;
  /**
   * Disable the automatic verification subagent that runs after any turn
   * with file edits (auto-verify). When left enabled (default), MakeStudio
   * dispatches a read-only verification subagent to run builds/tests/probes
   * and reports PASS/FAIL/PARTIAL to the user. Default OFF — the
   * subagent can burn a lot of tokens verifying a trivial change, and
   * when the verifier gets confused it spirals into long loops. Opt in
   * with /verify on when you genuinely need the safety net.
   */
  autoVerifyEnabled?: boolean;
  /** @deprecated use autoVerifyEnabled. Left for backwards compatibility
   *  so an existing settings.json with autoVerifyDisabled still parses. */
  autoVerifyDisabled?: boolean;
  /**
   * Pre-turn tool routing — when enabled (default), the agent narrows the
   * tool surface to the ~15 most relevant tools for the current prompt
   * (token-overlap ranking + always-include core utility set). Stops
   * the model from reaching for git_log / find / wc on a "como estamos"
   * question, since those tools simply aren't visible to it that turn.
   * Set to true to bypass routing and always expose the full catalogue
   * (useful when running highly varied multi-step tasks where the
   * router might guess wrong on what's relevant).
   */
  toolRoutingDisabled?: boolean;
  /**
   * Lazy MCP tool loading — when true, MCP tools are exposed by name
   * only (description + input_schema stripped to a stub pointing at
   * ToolSearch). Cuts 200-1K tokens / turn on installs with many MCP
   * servers, at the cost of one ToolSearch round-trip when a specific
   * MCP tool is invoked. Default false; only kicks in when there are
   * more than 6 MCP tools registered (small catalogues are cheaper to
   * keep eager). claude-code calls this defer_loading.
   */
  mcpLazyLoad?: boolean;
  /**
   * Cache warming on REPL start — fires one tiny LLM call right after
   * boot (system + tools, max_tokens=4) so Anthropic's prefix cache
   * writes the breakpoints. The first real user prompt then hits cache
   * instead of paying the full cache-write cost. Best-effort; failures
   * are swallowed silently. Default false because it costs one extra
   * call per session even if the user doesn't end up sending anything.
   */
  cacheWarmOnStart?: boolean;
  /**
   * PII redaction for tool outputs sent to the LLM. The local TUI keeps
   * raw values; only the chat-history copy is sanitized. Modes:
   *   - 'off'    — no redaction (default)
   *   - 'tokens' — credit cards (Luhn), SSN, bearer tokens, cookies,
   *                AWS / GitHub / Stripe / Anthropic / OpenAI keys,
   *                JWTs, postgres DSNs with inline password, private
   *                key blocks
   *   - 'strict' — same as 'tokens' + emails + public IPv4 addresses +
   *                phone-shaped runs
   * Env override: MAKESTUDIO_PII_REDACTION=tokens|strict
   */
  piiRedaction?: 'off' | 'tokens' | 'strict';
  /**
   * Disable the built-in deny rules (credential paths, catastrophic
   * Bash patterns). Default false — built-in denies are always active.
   * Set to true ONLY when you understand the risk (typically: running
   * the agent in an ephemeral container where no host secrets exist).
   */
  disableBuiltinDenies?: boolean;
  /**
   * OpenTelemetry tracing for tool dispatch + LLM calls. Spans are
   * written as OTLP/JSON lines to ~/.makestudio/traces/<pid>-<ts>.otlp.jsonl
   * which any OTel collector can ingest via filelog receiver +
   * otlpjson parser. Off by default. Env `MAKESTUDIO_OTEL=1` (or
   * `=stdout` for stderr emit) overrides this.
   */
  otelEnabled?: boolean;
  /**
   * Auto-rewrite drag-and-dropped file paths to @-refs in the input
   * line. When a terminal pastes a path like `/Users/foo/bar.ts`
   * (drag-drop source), the input is replaced with `@/Users/foo/bar.ts`
   * so the at-references resolver attaches the file content to the
   * next message. Default false. Env override:
   * MAKESTUDIO_DND_AT_REF=1.
   */
  dndAutoAtRef?: boolean;
  /**
   * Persist every tool call's input/output to a per-session JSONL log
   * under ~/.makestudio/tool-results/<sessionId>.jsonl. Useful for
   * post-hoc replay, audits, and analysis after the in-memory
   * toolCallHistory has rotated. Default false. Env override:
   * MAKESTUDIO_TOOL_PERSIST=1.
   */
  toolResultPersist?: boolean;
  /**
   * Smart context pruning — stubs/trims old tool_results that the
   * model demonstrably no longer needs (duplicate Read/Glob/Grep
   * results, old failed tool calls, verbose Bash output's middle
   * section). Runs alongside microCompact (not instead of it).
   * Default false. Env override: MAKESTUDIO_SMART_PRUNE=1.
   */
  smartPrune?: boolean;
  /**
   * Pre-spawn LSP servers at REPL startup based on detected project
   * language. Trades extra RAM for ~2-15s lower latency on the first
   * goto-definition / find-references call. Default false. Env
   * override: MAKESTUDIO_LSP_WARM=1.
   */
  lspWarmPool?: boolean;
  /**
   * Parallel I/O prefetch for read-only tool batches. When the model
   * emits multiple Read/Glob/Grep/WebFetch/LSP-query tool_uses in one
   * response, run their executeTool() calls concurrently. Permission
   * checks, hooks, dedup, history, and chatMessages.push remain
   * sequential — only the I/O is parallel. Default false. Env
   * override: MAKESTUDIO_PARALLEL_READ=1.
   */
  parallelReadOnlyExec?: boolean;
  /**
   * Interrupt a turn when search tools (Read/Glob/Grep/WebFetch/lsp_*)
   * return zero useful results back-to-back. Soft hint at 3
   * consecutive zero-results, hard stop at 6. Counter resets on any
   * productive result so legitimate refinement loops aren't punished.
   * Default true. Env override: MAKESTUDIO_ZERO_RESULT_BREAKER=0|1.
   */
  zeroResultBreaker?: boolean;
  /**
   * Tutor: detect "stuck investigating" pattern. After 5 consecutive
   * diagnostic tool calls (Read/Grep/Glob/Bash-search) without a
   * single progress call (Edit/Write/build/commit), inject a system
   * reminder telling the model to either edit or admit defeat.
   * Default true. Env override: MAKESTUDIO_DIAG_STREAK=0 to disable.
   */
  diagnosticStreakBreaker?: boolean;
  /**
   * Verbose mode — when true, tool call cards are shown in the message list.
   * When false (default), tool cards are hidden; only the tool name shows in
   * the status line while busy. Toggle with /verbose or --verbose at startup.
   */
  verbose?: boolean;
  /**
   * Policy settings — enforce constraints regardless of user/project hooks.
   * Equivalent to Claude Code's policySettings (typically pushed via MDM
   * for managed installs).
   */
  policy?: {
    /**
     * When true, only hooks registered via plugins or built-ins fire.
     * User hooks (~/.makestudio/hooks.json) and project hooks
     * (<project>/.makestudio/hooks.json) are completely ignored.
     * Used by admins / dark-factory to lock down hook execution to
     * known-good code.
     */
    allowManagedHooksOnly?: boolean;
  };
  /**
   * Phase 11 — provider effort persisted across restarts. Without this, the
   * default 'medium' resets every reboot and the user has to re-set it on
   * each session. The Electron ProvidersPage writes here via /effort or the
   * effort slider; the REPL reads on boot to seed `ctx.effort`.
   */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Electron UI zoom — applied via webFrame.setZoomFactor(). Range 0.5–4.0. */
  uiScale?: number;
  /**
   * Phase 9 — paste behaviour configuration. Reads consumed by the
   * Electron InputBox (multi-line paste detection threshold + marker
   * generation). Defaults preserve the historical hard-coded constants
   * so existing settings.json files keep behaving the same way.
   */
  inputPaste?: {
    /** Whether multi-line paste is auto-converted to a [Pasted #N +M lines]
     *  marker. When false, the browser default paste runs untouched. */
    autoMarker?: boolean;
    /** Minimum line count to trigger marker conversion. Default 5. */
    markerThresholdLines?: number;
    /** Minimum char count to trigger marker conversion. Default 800. */
    markerThresholdChars?: number;
  };
  /**
   * Phase 9 — @file reference configuration. Controls the fuzzy file-path
   * picker that appears when the user types `@` in the input.
   */
  inputAtFile?: {
    /** Disable the picker entirely — `@token` is treated as plain text. */
    enabled?: boolean;
    /** Cap on the number of results shown in the popover. Default 20. */
    maxResults?: number;
  };
}

const DEFAULTS: Settings = {
  version: 1,
  theme: 'default',
  chatColor: 'default',
  outputStyle: 'default',
  vimMode: false,
  fastMode: false,
  keybindings: {
    historyPrev: 'up',
    historyNext: 'down',
    tabComplete: 'tab',
    reverseSearch: 'ctrl+r',
    newline: 'ctrl+j',
    clearScreen: 'ctrl+l',
    cancel: 'escape+escape',
    exit: 'ctrl+c',
  },
  statusline: {
    fields: ['status', 'msgs', 'ctx', 'tokens', 'mode', 'style', 'rules', 'perms'],
  },
  workingDirs: [],
  numStartups: 0,
  tipsHistory: {},
};

/**
 * Settings hierarchy (port of Claude Code's utils/settings):
 *
 *   user      — ~/.makestudio/settings.json         (writable, per-user defaults)
 *   project   — <cwd>/.makestudio/settings.json     (writable, per-project overrides)
 *   managed   — ~/.makestudio/.mdm/settings.json    (READ-ONLY, org/MDM overrides)
 *
 * Precedence (later wins): user < project < managed. Managed is on top
 * because corporate/MDM pushes must not be overrideable by end users.
 * saveSettings() writes to USER by default; saveSettings(patch, 'project')
 * writes to the project layer so team preferences live in git.
 */

export type SettingsScope = 'user' | 'project' | 'managed';

function userSettingsPath(): string {
  return path.join(os.homedir(), '.makestudio', 'settings.json');
}
function projectSettingsPath(cwd?: string): string {
  return path.join(cwd || process.cwd(), '.makestudio', 'settings.json');
}
function managedSettingsPath(): string {
  return path.join(os.homedir(), '.makestudio', '.mdm', 'settings.json');
}
/** Back-compat — previous single-path consumers still import `settingsPath`. */
function settingsPath(): string { return userSettingsPath(); }

function readJsonOrNull(file: string): any | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function mergeLayer(base: Settings, layer: any): Settings {
  if (!layer || typeof layer !== 'object') return base;
  const merged: Settings = { ...base, ...layer, version: 1 };
  merged.keybindings = { ...base.keybindings, ...(layer.keybindings || {}) };
  merged.statusline = { ...base.statusline, ...(layer.statusline || {}) };
  if (layer.workingDirs !== undefined) merged.workingDirs = layer.workingDirs;
  return merged;
}

let cached: Settings | null = null;
let cachedCwd: string | null = null;

export function loadSettings(cwd?: string): Settings {
  const effectiveCwd = cwd || process.cwd();
  if (cached && cachedCwd === effectiveCwd) return applyRuntimeOverrides(cached);
  let acc: Settings = { ...DEFAULTS };
  acc = mergeLayer(acc, readJsonOrNull(userSettingsPath()));
  acc = mergeLayer(acc, readJsonOrNull(projectSettingsPath(effectiveCwd)));
  // Managed layer on top — an enterprise MDM push WINS over any user/project
  // setting. Invalid JSON in the managed file is logged to stderr and ignored
  // so a bad MDM deployment doesn't lock the user out entirely.
  try {
    const managedRaw = fs.readFileSync(managedSettingsPath(), 'utf8');
    try { acc = mergeLayer(acc, JSON.parse(managedRaw)); }
    catch (e: any) { process.stderr.write(`[settings] managed layer parse failed: ${e.message}\n`); }
  } catch (err) { swallow(err); }
  cached = acc;
  cachedCwd = effectiveCwd;
  return applyRuntimeOverrides(acc);
}

/**
 * Apply ENV-VAR-scoped overrides on top of the disk-loaded settings.
 * Used by `makestudio -p --yes` so a single subprocess can flip into
 * bypassPermissions for ITS run only — without persisting to
 * ~/.makestudio/settings.json and contaminating future REPL sessions
 * (the bug where users saw "[mode:bypassPermissions]" with no idea why).
 *
 * Currently honours:
 *   MAKESTUDIO_RUNTIME_PERMISSION_MODE — overrides settings.permissionMode
 *
 * Returns a NEW Settings object so the cached one stays clean.
 */
function applyRuntimeOverrides(s: Settings): Settings {
  const pm = process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE as Settings['permissionMode'] | undefined;
  if (pm && ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'].includes(pm)) {
    return { ...s, permissionMode: pm };
  }
  return s;
}

/**
 * Save to the given scope. 'managed' is read-only and throws — the MDM
 * file is pushed by infra, not by the REPL. Defaults to 'user' for
 * backward compatibility with existing callers.
 */
export function saveSettings(patch: Partial<Settings>, scope: SettingsScope = 'user'): Settings {
  if (scope === 'managed') {
    throw new Error('Managed settings are read-only (push via ~/.makestudio/.mdm/settings.json out-of-band).');
  }
  const file = scope === 'project' ? projectSettingsPath() : userSettingsPath();
  const existing = readJsonOrNull(file) || {};
  const next = { ...existing, ...patch, version: 1 };
  if (patch.keybindings) next.keybindings = { ...(existing.keybindings || {}), ...patch.keybindings };
  if (patch.statusline) next.statusline = { ...(existing.statusline || {}), ...patch.statusline };
  if (patch.workingDirs) next.workingDirs = patch.workingDirs;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic write: dois `saveSettings` concorrentes (ex.: ProvidersPage
    // mudando `effort` ao mesmo tempo que ThemeSwitcher salvando `theme`)
    // viam read-modify-write em cima do mesmo arquivo, e o último vencia
    // — perdendo a outra mudança. tmp + rename garante atomicidade
    // independente de ordem de scheduling.
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    cached = null; // force reload so layer precedence re-applies
  } catch (err) { swallow(err); }
  return loadSettings();
}

export function resetSettings(scope: SettingsScope = 'user'): Settings {
  if (scope === 'managed') throw new Error('Managed settings are read-only.');
  const file = scope === 'project' ? projectSettingsPath() : userSettingsPath();
  try { fs.unlinkSync(file); } catch (err) { swallow(err); }
  cached = null;
  return loadSettings();
}

/** Debug helper: which settings file contributed each field? Used by /doctor. */
export function settingsLayerSummary(cwd?: string): { user: boolean; project: boolean; managed: boolean } {
  const effectiveCwd = cwd || process.cwd();
  return {
    user: fs.existsSync(userSettingsPath()),
    project: fs.existsSync(projectSettingsPath(effectiveCwd)),
    managed: fs.existsSync(managedSettingsPath()),
  };
}
