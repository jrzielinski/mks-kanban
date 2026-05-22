import { swallow } from '../utils/log';
/**
 * Fine-grained permission system — per-tool, per-path, per-command rules.
 *
 * Policy file: ~/.makestudio/permissions.json (global) and
 *              <project>/.makestudio/permissions.json (project-specific)
 *
 * Format:
 *   {
 *     "policy": "ask" | "allow" | "deny",    // default policy
 *     "rules": [
 *       { "tool": "shell_run",   "command": "npm *",         "action": "allow" },
 *       { "tool": "shell_run",   "command": "rm *",          "action": "ask"   },
 *       { "tool": "shell_run",   "command": "git push *",    "action": "ask"   },
 *       { "tool": "read_file",   "pathPrefix": "api/src/",   "action": "allow" },
 *       { "tool": "web_fetch",   "domain": "github.com",     "action": "allow" },
 *       { "tool": "memory_save", "action": "allow" }
 *     ]
 *   }
 *
 * Rules are checked in order; first match wins. If nothing matches, default policy applies.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type PermissionAction = 'allow' | 'ask' | 'deny';
export type PermissionRule = {
  tool: string;
  command?: string;         // glob pattern against command string
  pathPrefix?: string;      // for file operations
  domain?: string;          // for web_fetch
  action: PermissionAction;
  /** Optional conjunction of side-conditions. All must match for the rule
   *  to fire. Parsed from `&& cwd(/src)` / `&& branch(main)` suffixes. */
  conditions?: PermissionCondition[];
};

/** Side-condition attached to a rule via `&&` / `!` syntax. Evaluated
 *  against the runtime context in ruleMatches. */
export interface PermissionCondition {
  kind: 'cwd' | 'branch' | 'hour' | 'weekday';
  /** Glob or comparison value. For `hour`: "09-17" means 9am-5pm; a plain
   *  number means exact hour. For `weekday`: `mon-fri` or `sat,sun`. */
  value: string;
  /** True when prefixed with `!` (inverted match). */
  negate?: boolean;
}

/**
 * Claude-Code-style PermissionMode. Determines the session-wide baseline
 * before the per-rule engine runs.
 *   - `default`: normal behaviour — rules decide, unmatched → policy.default
 *   - `plan`: Write/Edit/MultiEdit blocked entirely (except plan file); read-only mode
 *   - `acceptEdits`: auto-allow Write/Edit/MultiEdit without prompting (still ask Bash)
 *   - `bypassPermissions`: auto-allow EVERYTHING that isn't explicitly denied
 *   - `dontAsk`: auto-allow everything that isn't matched by a deny rule
 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk';

export interface PermissionPolicy {
  policy: PermissionAction;  // default when no rule matches
  rules: PermissionRule[];
}

/**
 * Parses `Tool(matcher)` syntax into a PermissionRule. Same parser used
 * by the hooks `if` clause (see hooks.ts:matchesIfPattern), but richer
 * — here we understand matcher placement: commands for Bash, pathPrefix
 * for Read/Edit/Write/MultiEdit/Glob/Grep, domain for WebFetch.
 *
 * Returns null when the string isn't parseable — caller should fall back
 * to assuming it's a tool name only (e.g. "Bash" = tool=Bash, no matcher).
 */
/**
 * Split the rule string on `&&` at the top level (outside parens), so
 * `Bash(git *) && cwd(/src/**)` yields `['Bash(git *)', 'cwd(/src/**)']`
 * but `Bash(foo && bar)` stays `['Bash(foo && bar)']`.
 */
function splitOnTopLevelAnd(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '&' && s[i + 1] === '&') {
      out.push(buf);
      buf = '';
      i++; // skip second &
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out.map((p) => p.trim()).filter(Boolean);
}

function parseCondition(clause: string): PermissionCondition | null {
  let c = clause.trim();
  let negate = false;
  if (c.startsWith('!')) { negate = true; c = c.slice(1).trim(); }
  const m = c.match(/^(cwd|branch|hour|weekday)\((.*)\)$/);
  if (!m) return null;
  return { kind: m[1] as PermissionCondition['kind'], value: m[2].trim(), negate };
}

export function parseRuleString(raw: string, action: PermissionAction): PermissionRule | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;

  // Split on top-level `&&` FIRST — the head is the tool rule, the rest
  // are conditions. Lets users write `Bash(git *) && cwd(/src/**)` and
  // `Bash(*) && !branch(main)` naturally.
  const parts = splitOnTopLevelAnd(trimmed);
  const head = parts[0];
  const condClauses = parts.slice(1);

  // Negation prefix `!` — explicit deny regardless of the bucket the rule
  // was pulled from. Lets users write `deny: ["Bash(*)"]` normally AND
  // `allow: ["!Bash(rm *)"]` for a mixed policy. Port of Claude Code's
  // permissionRuleParser negation token.
  let negated = false;
  let h = head;
  if (h.startsWith('!')) {
    negated = true;
    h = h.slice(1).trim();
    if (!h) return null;
  }
  const effectiveAction: PermissionAction = negated ? 'deny' : action;

  const conditions: PermissionCondition[] = [];
  for (const cl of condClauses) {
    const parsed = parseCondition(cl);
    if (parsed) conditions.push(parsed);
    // Silently drop unparseable clauses — better UX than failing the whole rule.
  }
  const attachConds = (r: PermissionRule): PermissionRule =>
    conditions.length > 0 ? { ...r, conditions } : r;

  // "Tool" alone — matches any call of that tool.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(h)) {
    return attachConds({ tool: h, action: effectiveAction });
  }

  const m = h.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (!m) return null;
  const [, tool, matcherRaw] = m;
  const matcher = matcherRaw.trim();

  // Special: `domain:foo.com` in matcher → domain-scoped rule.
  const domainMatch = matcher.match(/^domain:(.+)$/);
  if (domainMatch) return attachConds({ tool, domain: domainMatch[1].trim(), action: effectiveAction });

  // Command-or-path: heuristic based on tool.
  const COMMAND_TOOLS = new Set(['Bash', 'shell_run']);
  if (COMMAND_TOOLS.has(tool)) {
    return attachConds({ tool, command: matcher, action: effectiveAction });
  }
  // Read/Edit/Write/MultiEdit/Glob/Grep/LSP → path-scoped.
  return attachConds({ tool, pathPrefix: matcher, action: effectiveAction });
}

const DEFAULT_POLICY: PermissionPolicy = {
  policy: 'ask',
  rules: [],
};

/**
 * Built-in deny rules — applied ALWAYS, before user/project rules. Even
 * `--dangerously-skip-permissions` / bypassPermissions mode respects
 * deny rules, so these provide a baseline safety net for catastrophic
 * shapes that have no legitimate code-agent use case:
 *
 *   - Reading common secret stash paths (~/.aws/credentials, .ssh keys,
 *     .env, .npmrc, kubeconfig, .pgpass).
 *   - Bash patterns that can permanently destroy a system or its data
 *     (rm -rf /, dd of=raw block device, mkfs, fork bombs, suid bit
 *     setting on root-owned files).
 *
 * Designed for HIGH PRECISION. Every false positive forces the user
 * to either edit their policy.deny to explicitly allow, or set
 * `settings.disableBuiltinDenies: true` to drop the whole list.
 *
 * The list is intentionally conservative — generic `chmod`, `sudo`,
 * `curl | sh` patterns are NOT here because they have legitimate uses
 * and the agent should ask before running them via the normal
 * permission flow. We only block shapes whose primary purpose IS the
 * destructive/credential-reading behaviour.
 */
const BUILTIN_DENY_RULES: PermissionRule[] = [
  // Credential paths (Read/Glob/Grep/Edit/Write)
  { tool: 'Read',      pathPrefix: '**/.aws/credentials',     action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.aws/config',          action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.ssh/id_*',            action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.ssh/*_rsa',           action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.ssh/*_ed25519',       action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.ssh/*_ecdsa',         action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.ssh/*_dsa',           action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.kube/config',         action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.netrc',               action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.pgpass',              action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/.npmrc',               action: 'deny' },
  { tool: 'Read',      pathPrefix: '**/secrets.json',         action: 'deny' },
  // Glob/Grep against the same — block enumeration too
  { tool: 'Glob',      pathPrefix: '**/.ssh/**',              action: 'deny' },
  { tool: 'Glob',      pathPrefix: '**/.aws/**',              action: 'deny' },
  { tool: 'Grep',      pathPrefix: '**/.ssh/**',              action: 'deny' },
  { tool: 'Grep',      pathPrefix: '**/.aws/**',              action: 'deny' },
  // Catastrophic Bash shapes — destructive ops at filesystem root /
  // raw devices / fork bombs / mkfs / dd to /dev/sd* (raw block device).
  { tool: 'Bash',      command: 'rm -rf /',                   action: 'deny' },
  { tool: 'Bash',      command: 'rm -rf /*',                  action: 'deny' },
  { tool: 'Bash',      command: 'rm -rf --no-preserve-root *', action: 'deny' },
  { tool: 'Bash',      command: ':() { :|:& };:',             action: 'deny' },
  { tool: 'Bash',      command: 'mkfs* /dev/*',               action: 'deny' },
  { tool: 'Bash',      command: 'dd if=* of=/dev/sd*',        action: 'deny' },
  { tool: 'Bash',      command: 'dd if=* of=/dev/nvme*',      action: 'deny' },
  { tool: 'Bash',      command: '> /dev/sda*',                action: 'deny' },
  { tool: 'Bash',      command: 'shred /dev/*',               action: 'deny' },
  { tool: 'Bash',      command: 'chmod -R 777 /',             action: 'deny' },
  { tool: 'Bash',      command: 'chown -R * /',               action: 'deny' },
  // shell_run mirror
  { tool: 'shell_run', command: 'rm -rf /',                   action: 'deny' },
  { tool: 'shell_run', command: 'rm -rf /*',                  action: 'deny' },
  { tool: 'shell_run', command: ':() { :|:& };:',             action: 'deny' },
  { tool: 'shell_run', command: 'mkfs* /dev/*',               action: 'deny' },
];

function loadPolicyFrom(file: string): PermissionPolicy | null {
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules: PermissionRule[] = [];

    // Legacy: `rules: [{tool, command, action}, ...]`
    if (Array.isArray(data.rules)) {
      for (const r of data.rules) {
        if (r && r.tool && r.action) rules.push(r);
      }
    }

    // New Claude-Code-style: `allow: ["Bash(git *)", "Read(*.ts)"]` + `deny: [...]`
    for (const raw of (Array.isArray(data.allow) ? data.allow : [])) {
      const r = parseRuleString(String(raw), 'allow');
      if (r) rules.push(r);
    }
    for (const raw of (Array.isArray(data.ask) ? data.ask : [])) {
      const r = parseRuleString(String(raw), 'ask');
      if (r) rules.push(r);
    }
    for (const raw of (Array.isArray(data.deny) ? data.deny : [])) {
      const r = parseRuleString(String(raw), 'deny');
      if (r) rules.push(r);
    }

    return {
      policy: data.policy || 'ask',
      rules,
    };
  } catch {
    return null;
  }
}

export function loadPolicy(projectPath?: string): PermissionPolicy {
  const userFile = path.join(os.homedir(), '.makestudio', 'permissions.json');
  const projectFile = projectPath ? path.join(projectPath, '.makestudio', 'permissions.json') : null;
  const user = loadPolicyFrom(userFile);
  const project = projectFile ? loadPolicyFrom(projectFile) : null;

  // Built-in denies always lead, unless the user has opted out via
  // settings.disableBuiltinDenies. They appear FIRST in the rule list
  // so the deny-first engine evaluates them before any user allow.
  let builtin: PermissionRule[] = BUILTIN_DENY_RULES;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('./settings');
    const s = loadSettings() as any;
    if (s?.disableBuiltinDenies === true) builtin = [];
  } catch (err) { swallow(err); }

  if (!user && !project) return { policy: 'ask', rules: builtin };

  // Project rules take priority (prepended), then user rules. Built-in
  // denies always go first.
  return {
    policy: project?.policy ?? user?.policy ?? 'ask',
    rules: [...builtin, ...(project?.rules || []), ...(user?.rules || [])],
  };
}

// Simple glob matcher (*, ?, ** — no advanced features)
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return re.test(value);
}

/**
 * Canonicalize a user-supplied path so `..` traversal and symlinks cannot
 * sneak outside the pathPrefix. Used ONLY for rule matching (the actual I/O
 * in file-tools resolves separately). See stress test #3 + #4.
 */
function canonicalizePathForMatch(p: string): string {
  try {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  } catch {
    return p;
  }
}

/**
 * Does this rule match the given context? Extracted from evaluate() so the
 * bypassPermissions fast-path can reuse it (stress test #11 — domain filter
 * was previously ignored in that path).
 */
/**
 * Read the current git branch for the given cwd. Cheap — single `git
 * symbolic-ref` call per evaluation. Returns null when not a git repo.
 * Memoized for 30s so a policy with several branch conditions doesn't
 * fork `git` per rule.
 */
const branchCache = new Map<string, { at: number; branch: string | null }>();
function getCurrentBranch(cwd: string): string | null {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.branch;
  let branch: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('child_process');
    const out = execSync('git symbolic-ref --short HEAD 2>/dev/null', { cwd, encoding: 'utf8', timeout: 500 });
    branch = out.trim() || null;
  } catch { branch = null; }
  branchCache.set(cwd, { at: Date.now(), branch });
  return branch;
}

/**
 * Optional overrides for time/branch dimensions. The runtime never sets
 * these — only the sandbox UI (Phase 8) injects them so the user can
 * simulate "what would happen on Friday at 3am on branch=hotfix?" without
 * actually mutating the system clock or git state.
 */
export interface ConditionOverrides {
  branch?: string;
  /** ISO weekday lowercase (sun..sat) OR full Date when caller wants
   *  hour+weekday to come from the same instant. */
  now?: Date;
}

/**
 * Evaluate a PermissionCondition against the current runtime. All
 * conditions must pass for the rule to fire; a single failure short-circuits.
 */
function conditionMatches(
  cond: PermissionCondition,
  ctx: { cwd?: string },
  overrides?: ConditionOverrides,
): boolean {
  let matched = false;
  switch (cond.kind) {
    case 'cwd': {
      const here = path.resolve(ctx.cwd || process.cwd());
      const expect = path.resolve(cond.value);
      matched = here === expect || here.startsWith(expect + path.sep) || globMatch(cond.value, here);
      break;
    }
    case 'branch': {
      const br = overrides?.branch ?? getCurrentBranch(ctx.cwd || process.cwd());
      if (!br) { matched = false; break; }
      // Comma-separated list OR glob.
      const candidates = cond.value.split(',').map((v) => v.trim()).filter(Boolean);
      matched = candidates.some((c) => c === br || globMatch(c, br));
      break;
    }
    case 'hour': {
      const now = (overrides?.now ?? new Date()).getHours();
      const range = cond.value.match(/^(\d{1,2})-(\d{1,2})$/);
      if (range) {
        const lo = parseInt(range[1], 10), hi = parseInt(range[2], 10);
        matched = now >= lo && now <= hi;
      } else {
        matched = now === parseInt(cond.value, 10);
      }
      break;
    }
    case 'weekday': {
      const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const today = DAYS[(overrides?.now ?? new Date()).getDay()];
      const range = cond.value.toLowerCase().match(/^(mon|tue|wed|thu|fri|sat|sun)-(mon|tue|wed|thu|fri|sat|sun)$/);
      if (range) {
        const a = DAYS.indexOf(range[1]);
        const b = DAYS.indexOf(range[2]);
        const i = DAYS.indexOf(today);
        matched = a <= b ? (i >= a && i <= b) : (i >= a || i <= b);
      } else {
        const list = cond.value.toLowerCase().split(',').map((v) => v.trim());
        matched = list.includes(today);
      }
      break;
    }
    default:
      matched = false;
  }
  return cond.negate ? !matched : matched;
}

function ruleMatches(
  rule: PermissionRule,
  ctx: { tool: string; command?: string; path?: string; url?: string; cwd?: string },
  overrides?: ConditionOverrides,
): boolean {
  if (rule.tool !== '*' && rule.tool !== ctx.tool) return false;
  if (rule.command && ctx.command && !globMatch(rule.command, ctx.command)) return false;
  if (rule.command && !ctx.command) return false;
  if (rule.pathPrefix) {
    if (!ctx.path) return false;
    const canon = canonicalizePathForMatch(ctx.path);
    const prefix = path.resolve(rule.pathPrefix);
    // Prefix must be a directory ancestor OR the exact path.
    const ok = canon === prefix || canon.startsWith(prefix + path.sep) || globMatch(rule.pathPrefix, canon);
    if (!ok) return false;
  }
  if (rule.domain) {
    if (!ctx.url) return false;
    try {
      const u = new URL(ctx.url);
      const h = u.hostname.toLowerCase().replace(/\.$/, '');
      const d = rule.domain.toLowerCase().replace(/\.$/, '');
      if (h !== d && !h.endsWith('.' + d)) return false;
    } catch { return false; }
  }
  // Conditions last — cheap dimensions first, git call gated behind branch().
  if (rule.conditions && rule.conditions.length > 0) {
    for (const cond of rule.conditions) {
      if (!conditionMatches(cond, ctx, overrides)) return false;
    }
  }
  return true;
}

/**
 * Evaluate rules in deny-first order so `allow: ["Bash(*)"] deny: ["Bash(rm *)"]`
 * actually denies (stress test #6 — prior behaviour walked rules in insertion
 * order and the first matching allow short-circuited before deny was checked).
 */
export function evaluate(
  policy: PermissionPolicy,
  ctx: { tool: string; command?: string; path?: string; url?: string; cwd?: string },
): PermissionAction {
  return evaluateDetailed(policy, ctx).action;
}

/**
 * Same engine as evaluate(), but also returns which rule index produced the
 * decision (or -1 when nothing matched and we fell through to policy.policy).
 * Used by the Phase 8 settings UI sandbox so the human-readable "matched rule"
 * label cannot drift from the runtime decision — both come from one source.
 *
 * `overrides` lets the sandbox simulate branch/now without touching git/clock.
 */
export function evaluateDetailed(
  policy: PermissionPolicy,
  ctx: { tool: string; command?: string; path?: string; url?: string; cwd?: string },
  overrides?: ConditionOverrides,
): { action: PermissionAction; ruleIdx: number } {
  for (let i = 0; i < policy.rules.length; i++) {
    const r = policy.rules[i];
    if (r.action === 'deny' && ruleMatches(r, ctx, overrides)) return { action: 'deny', ruleIdx: i };
  }
  for (let i = 0; i < policy.rules.length; i++) {
    const r = policy.rules[i];
    if (r.action !== 'deny' && ruleMatches(r, ctx, overrides)) return { action: r.action, ruleIdx: i };
  }
  return { action: policy.policy, ruleIdx: -1 };
}

export function extractContextFromToolCall(
  toolName: string,
  input: any,
  options: { cwd?: string } = {},
): { tool: string; command?: string; path?: string; url?: string; cwd?: string } {
  const ctx: any = { tool: toolName };
  if ((toolName === 'shell_run' || toolName === 'Bash') && input.command) ctx.command = input.command;
  // Edit-family + notebook path aliases — stress test #12 (notebook_path was
  // not being mapped, so path-scoped NotebookEdit rules silently passed).
  // Glob/Grep use `pattern` as their path-like discriminator; all other
  // file tools use file_path / filePath / notebook_path.
  const PATTERN_TOOLS = new Set(['Glob', 'Grep']);
  const p = PATTERN_TOOLS.has(toolName)
    ? (input.pattern || input.file_path || input.filePath)
    : (input.file_path || input.filePath || input.notebook_path);
  const PATH_TOOLS = new Set([
    'read_file', 'Read',
    'Write', 'Edit', 'MultiEdit',
    'NotebookEdit',
    'Glob', 'Grep', 'LSP',
  ]);
  if (p && PATH_TOOLS.has(toolName)) ctx.path = p;
  if ((toolName === 'web_fetch' || toolName === 'WebFetch') && input.url) ctx.url = input.url;
  // cwd — passed through so conditional rules (cwd/branch) can resolve.
  if (options.cwd) ctx.cwd = options.cwd;
  return ctx;
}

/** Edit-family tools — used by PermissionMode pre-checks. Includes NotebookEdit
 * (stress test #12 — plan-mode bypass via notebook edits). */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file']);
const BASH_TOOLS = new Set(['Bash', 'shell_run']);

/**
 * Read-only built-in tools that are ALWAYS allowed unless there's an explicit
 * deny rule. These are agent-internal tools that read user/project state
 * (memory store, attachments, project metadata) without side effects, network
 * calls, or filesystem writes outside the agent's own data directory.
 * Asking permission for these on every "ola" turns the prompt into a
 * permission whack-a-mole — a usability bug, not a safety win.
 *
 * Adding a tool here means: it can run without prompting even when the
 * policy default is 'ask'. A user who really wants to gate it can still
 * add an explicit deny rule.
 */
const SAFE_BUILTIN_TOOLS = new Set([
  // Memory store — reads/writes only inside ~/.makestudio/memory/.
  'memory_search',
  'memory_save',
  // Project metadata — read-only views of the user's own projects.
  'list_projects',
  'project_status',
  'active_project',
  // Attachments — fetch content the user already pasted into the chat.
  'read_attachment',
  // Session bookkeeping — pure metadata, no I/O surprises.
  'pin_session_constraint',
  // Todo list — agent-internal task tracker.
  'TodoWrite',
  // Sub-agent dispatch isn't here — those run other tools and need their
  // own permission evaluation.
]);

/**
 * PermissionMode-aware evaluation. Applies mode-specific shortcuts BEFORE
 * the rule engine runs.
 *
 *   plan              → Edit-family returns 'deny' (any other tool passes to rules)
 *   acceptEdits       → Edit-family returns 'allow' (Bash still goes to rules)
 *   bypassPermissions → everything returns 'allow' unless a deny rule matches
 *   dontAsk           → rules decide; unmatched → 'allow' instead of default
 *   default           → same as evaluate() — rules + policy.default
 */
export function evaluateWithMode(
  policy: PermissionPolicy,
  mode: PermissionMode,
  ctx: { tool: string; command?: string; path?: string; url?: string; cwd?: string },
  overrides?: ConditionOverrides,
): PermissionAction {
  return evaluateWithModeDetailed(policy, mode, ctx, overrides).action;
}

/**
 * Mode-aware detailed evaluation. Returns the same `{ action, ruleIdx }`
 * as evaluateDetailed plus a `source` discriminator so the sandbox UI can
 * differentiate between mode-shortcut decisions ('mode') and rule-engine
 * decisions ('rule' / 'policy-default'). ruleIdx is -1 unless the decision
 * came from a specific rule.
 */
export function evaluateWithModeDetailed(
  policy: PermissionPolicy,
  mode: PermissionMode,
  ctx: { tool: string; command?: string; path?: string; url?: string; cwd?: string },
  overrides?: ConditionOverrides,
): { action: PermissionAction; ruleIdx: number; source: 'mode' | 'rule' | 'policy-default' } {
  if (mode === 'plan' && EDIT_TOOLS.has(ctx.tool)) return { action: 'deny', ruleIdx: -1, source: 'mode' };
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(ctx.tool)) return { action: 'allow', ruleIdx: -1, source: 'mode' };

  // Safe agent-internal tools (memory, project metadata, attachments) bypass
  // the prompt entirely UNLESS the user authored a deny rule. Without this
  // shortcut, every chat turn that reads memory or queries the project list
  // would block on a "requires permission" modal — a usability bug.
  if (SAFE_BUILTIN_TOOLS.has(ctx.tool)) {
    for (let i = 0; i < policy.rules.length; i++) {
      const r = policy.rules[i];
      if (r.action === 'deny' && ruleMatches(r, ctx, overrides)) {
        return { action: 'deny', ruleIdx: i, source: 'rule' };
      }
    }
    return { action: 'allow', ruleIdx: -1, source: 'mode' };
  }

  if (mode === 'bypassPermissions') {
    // Deny rules still win — this is a safety valve, not a total bypass.
    // Reuse ruleMatches() so domain filters (WebFetch(domain:...)) actually
    // work in this mode. Stress test #11.
    for (let i = 0; i < policy.rules.length; i++) {
      const r = policy.rules[i];
      if (r.action === 'deny' && ruleMatches(r, ctx, overrides)) return { action: 'deny', ruleIdx: i, source: 'rule' };
    }
    return { action: 'allow', ruleIdx: -1, source: 'mode' };
  }

  if (mode === 'dontAsk') {
    const r = evaluateDetailed(policy, ctx, overrides);
    if (r.action === 'ask') return { action: 'allow', ruleIdx: r.ruleIdx, source: 'mode' };
    return { ...r, source: r.ruleIdx >= 0 ? 'rule' : 'policy-default' };
  }

  // default: unmodified rule engine.
  const r = evaluateDetailed(policy, ctx, overrides);
  return { ...r, source: r.ruleIdx >= 0 ? 'rule' : 'policy-default' };
}

/**
 * Detect shadowed rules — pairs where a later rule is unreachable because
 * an earlier rule covers a superset AND differs in action. Used by /doctor
 * to warn on policy authoring mistakes. The engine itself already does the
 * right thing (deny-first), but a misconfigured policy still deserves a
 * warning so the author knows what will never fire. Port of Claude Code's
 * permissions/shadowedRuleDetection.ts.
 */
export interface ShadowWarning {
  tool: string;
  earlier: { matcher: string; action: PermissionAction };
  shadowed: { matcher: string; action: PermissionAction };
  reason: string;
}

function ruleMatcherLabel(r: PermissionRule): string {
  if (r.command) return `${r.tool}(${r.command})`;
  if (r.pathPrefix) return `${r.tool}(${r.pathPrefix})`;
  if (r.domain) return `${r.tool}(domain:${r.domain})`;
  return r.tool;
}

function matcherCoversCriterion(a: string | undefined, b: string | undefined): boolean {
  if (!a || a === '*') return true;
  if (!b) return false;
  if (a === b) return true;
  if (a.endsWith('*')) return b.startsWith(a.slice(0, -1));
  return false;
}

/**
 * Persist a PermissionPolicy. Writes the legacy `{policy, rules: [...]}`
 * shape (richer than the Claude-Code allow/ask/deny string lists since it
 * preserves conditions and exposes the action explicitly). loadPolicy()
 * already parses this shape, so round-trips are idempotent.
 *
 * scope='user' writes to ~/.makestudio/permissions.json
 * scope='project' writes to <projectPath>/.makestudio/permissions.json
 *
 * Conditions are serialized as the readable `kind(value)` form (with `!`
 * prefix for negate) so a human editing the file by hand sees the same
 * syntax accepted by parseRuleString. The runtime evaluate() reads the
 * structured `conditions` array directly, so both representations work.
 */
export function savePolicy(
  policy: PermissionPolicy,
  scope: 'user' | 'project' = 'user',
  projectPath?: string,
): PermissionPolicy {
  const file =
    scope === 'project'
      ? path.join(projectPath || process.cwd(), '.makestudio', 'permissions.json')
      : path.join(os.homedir(), '.makestudio', 'permissions.json');

  const serialized = {
    policy: policy.policy,
    rules: policy.rules.map((r) => ({
      tool: r.tool,
      ...(r.command !== undefined ? { command: r.command } : {}),
      ...(r.pathPrefix !== undefined ? { pathPrefix: r.pathPrefix } : {}),
      ...(r.domain !== undefined ? { domain: r.domain } : {}),
      action: r.action,
      ...(r.conditions && r.conditions.length > 0
        ? {
            conditions: r.conditions.map((c) => ({
              kind: c.kind,
              value: c.value,
              ...(c.negate ? { negate: true } : {}),
            })),
          }
        : {}),
    })),
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(serialized, null, 2), 'utf8');
  } catch (e: any) {
    throw new Error(`Failed to write ${file}: ${e?.message ?? e}`);
  }
  return policy;
}

/**
 * Round-trip a single rule string through parseRuleString. Used by the UI
 * before submitting a free-text rule so the user sees the same canonical
 * form the runtime will store. Returns null when the string is unparseable.
 */
export function tryParseRuleString(
  raw: string,
  action: PermissionAction,
): PermissionRule | null {
  return parseRuleString(raw, action);
}

export function detectShadowedRules(policy: PermissionPolicy): ShadowWarning[] {
  const out: ShadowWarning[] = [];
  for (let i = 0; i < policy.rules.length; i++) {
    for (let j = i + 1; j < policy.rules.length; j++) {
      const a = policy.rules[i];
      const b = policy.rules[j];
      if (a.action === b.action) continue;
      if (a.tool !== b.tool && a.tool !== '*') continue;
      if (b.command && !matcherCoversCriterion(a.command, b.command)) continue;
      if (b.pathPrefix && !matcherCoversCriterion(a.pathPrefix, b.pathPrefix)) continue;
      if (b.domain && !matcherCoversCriterion(a.domain, b.domain)) continue;
      // With our deny-first engine, only deny→allow/ask is genuinely unreachable.
      if (a.action === 'deny' && b.action !== 'deny') {
        out.push({
          tool: b.tool,
          earlier: { matcher: ruleMatcherLabel(a), action: a.action },
          shadowed: { matcher: ruleMatcherLabel(b), action: b.action },
          reason: `earlier deny rule matches a superset — later ${b.action} will never fire`,
        });
      }
    }
  }
  return out;
}
