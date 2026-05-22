import { swallow } from '../../utils/log';
/**
 * advanced-tools.ts
 *
 * Additional code-agent tools:
 *   - LSP (semantic code nav: definition, references, implementation, hover,
 *     workspaceSymbol, documentSymbol, callHierarchy)
 *   - TodoWrite (in-session task list managed by the LLM)
 *   - AskUserQuestion (LLM-driven multi-choice clarification with "Other")
 *   - BackgroundTask (TaskCreate/Output/Status/Stop/List — non-blocking shell)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { ReplContext } from '../context';
import type { ToolDefinition } from './tools';
// ── Per-topic imports (split modules) ─────────────────────────────────────
import {
  todoToolDefinitions,
  todoWriteImpl, todoUpdateImpl, todoListImpl,
} from './advanced-tools/todos';
import {
  askUserQuestionToolDefinition, askUserImpl,
} from './advanced-tools/ask';
import {
  bgTaskToolDefinitions,
  taskCreateImpl, taskOutputImpl, taskStatusImpl, taskStopImpl, taskListImpl,
} from './advanced-tools/bg-tasks';
import {
  worktreeToolDefinitions,
  enterWorktreeImpl, exitWorktreeImpl, worktreeStatusImpl,
} from './advanced-tools/worktree';
import {
  planModeToolDefinitions,
  enterPlanModeImpl, exitPlanModeImpl, planModeStatusImpl,
} from './advanced-tools/plan-mode';
import {
  suggestBackgroundPrToolDefinition, suggestBackgroundPrImpl,
} from './advanced-tools/pr-suggest';
import {
  sleepToolDefinition, sleepImpl,
} from './advanced-tools/sleep';
import {
  cronCreateToolDefinition, cronListToolDefinition, cronDeleteToolDefinition,
  cronCreateImpl, cronListImpl, cronDeleteImpl,
} from './advanced-tools/cron';

import {
  lspDefinition,
  lspDefinitionAt,
  lspReferences,
  lspReferencesAt,
  lspHover,
  lspDocumentSymbols,
  lspImplementation,
  lspWorkspaceSymbols,
  lspIncomingCalls,
  lspOutgoingCalls,
} from '../lsp';
import {
  enterWorktreeForDum,
  exitWorktreeAndMerge,
  exitWorktreeAndDiscard,
  canEnterWorktree,
  WorktreeHandle,
} from '../../core/worktree';

// ── LSP tool ────────────────────────────────────────────────────────────────

export const lspToolDefinition: ToolDefinition = {
  name: 'LSP',
  description:
    'Interact with the Language Server Protocol for semantic code intelligence. Supported operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, incomingCalls, outgoingCalls. Position-based operations take filePath + line + character (1-based). Use this BEFORE Grep when you need accurate symbol navigation (Grep false-positives on identifier matches).',
  input_schema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'goToDefinition',
          'findReferences',
          'hover',
          'documentSymbol',
          'workspaceSymbol',
          'goToImplementation',
          'incomingCalls',
          'outgoingCalls',
        ],
        description: 'Which LSP operation to run.',
      },
      symbol: { type: 'string', description: 'Symbol name (for workspaceSymbol or when no position given).' },
      filePath: { type: 'string', description: 'File path (required for position-based ops and documentSymbol).' },
      line: { type: 'number', description: '1-based line.' },
      character: { type: 'number', description: '1-based char offset.' },
    },
    required: ['operation'],
  },
};

async function runLspTool(input: any, ctx: ReplContext): Promise<string> {
  const root = ctx.activeProject?.localPath || ctx.cwd;
  const op = input.operation;
  let result: any;
  switch (op) {
    case 'goToDefinition':
      if (input.filePath && input.line != null) {
        result = await lspDefinitionAt(root, input.filePath, input.line, input.character ?? 1);
      } else if (input.symbol) {
        result = await lspDefinition(root, input.symbol);
      } else {
        throw new Error('goToDefinition: provide either (filePath + line[, character]) OR symbol');
      }
      break;
    case 'findReferences':
      if (input.filePath && input.line != null) {
        result = await lspReferencesAt(root, input.filePath, input.line, input.character ?? 1);
      } else if (input.symbol) {
        result = await lspReferences(root, input.symbol);
      } else {
        throw new Error('findReferences: provide either (filePath + line[, character]) OR symbol');
      }
      break;
    case 'hover':
      if (!input.filePath || input.line == null) throw new Error('hover: filePath and line required');
      result = await lspHover(root, input.filePath, Math.max(0, input.line - 1), Math.max(0, (input.character ?? 1) - 1));
      break;
    case 'documentSymbol':
      if (!input.filePath) throw new Error('documentSymbol: filePath required');
      result = await lspDocumentSymbols(root, input.filePath);
      break;
    case 'workspaceSymbol':
      if (!input.symbol) throw new Error('workspaceSymbol: symbol required');
      result = await lspWorkspaceSymbols(root, input.symbol);
      break;
    case 'goToImplementation':
      if (!input.filePath || input.line == null) throw new Error('goToImplementation: filePath and line required');
      result = await lspImplementation(root, input.filePath, input.line, input.character ?? 1);
      break;
    case 'incomingCalls':
      if (!input.filePath || input.line == null) throw new Error('incomingCalls: filePath and line required');
      result = await lspIncomingCalls(root, input.filePath, input.line, input.character ?? 1);
      break;
    case 'outgoingCalls':
      if (!input.filePath || input.line == null) throw new Error('outgoingCalls: filePath and line required');
      result = await lspOutgoingCalls(root, input.filePath, input.line, input.character ?? 1);
      break;
    default:
      throw new Error(`Unknown LSP operation: ${op}`);
  }
  return JSON.stringify(result, null, 2);
}

// ── Brief (progress update) ──────────────────────────────────────────────
//
// Port of Claude Code's BriefTool. Lets the model emit a structured
// short update to the user while a long task is in-flight, INSTEAD of
// narrating inline in the chat stream. Use at natural milestones: "found
// the root cause", "started the rebuild", "tests passing, committing".
//
// The update renders as an info toast in the TUI (via bridge.addMessage),
// separate from the assistant's textual reply. Max 120 chars — this is a
// status line, not a paragraph.

export const briefToolDefinition: ToolDefinition = {
  name: 'Brief',
  description:
    'Emit a brief progress update (<= 120 chars) to the user mid-task. Use at real milestones — found the bug, started rebuild, tests passing, committing. NOT for narration or confirmation. One update per meaningful state change; spamming this is worse than silence.',
  input_schema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Status line. Max 120 chars, terse, present tense.' },
      level: { type: 'string', enum: ['info', 'progress', 'warn'], description: 'Default info.' },
    },
    required: ['message'],
  },
};

function briefImpl(input: any, _ctx: ReplContext): string {
  const raw = String(input?.message || '').trim();
  if (!raw) return JSON.stringify({ error: 'message is required' });
  // Hard cap — the tool is explicitly for status lines, not blog posts.
  const message = raw.length > 120 ? raw.slice(0, 117) + '…' : raw;
  const level = (input?.level === 'warn' || input?.level === 'progress' || input?.level === 'info') ? input.level : 'info';
  try {
    const { tuiLog } = require('../tui/bridge');
    tuiLog(message, level === 'progress' ? 'info' : level);
  } catch (err) { swallow(err); }
  try {
    require('../../utils/events').recordEvent('brief', { level, chars: message.length });
  } catch (err) { swallow(err); }
  return JSON.stringify({ ok: true, posted: message, level });
}

// ── Push notification ──────────────────────────────────────────────────────

export const pushNotificationToolDefinition: ToolDefinition = {
  name: 'PushNotification',
  description: 'Send a native desktop notification. Use when a long-running task finishes. One notification per meaningful completion — do not spam.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title (shown bold).' },
      message: { type: 'string', description: 'Body text.' },
      sound: { type: 'boolean', description: 'Play default alert sound. Default false.' },
    },
    required: ['title', 'message'],
  },
};

function pushNotificationImpl(input: any, _ctx: ReplContext): string {
  const title = String(input.title || '').replace(/["\\]/g, '');
  const message = String(input.message || '').replace(/["\\]/g, '');
  const sound = !!input.sound;
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      const soundClause = sound ? ' sound name "Funk"' : '';
      const script = `display notification "${message}" with title "${title}"${soundClause}`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'linux') {
      const args = [title, message];
      spawn('notify-send', args, { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ` +
        `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
        `$template.GetElementsByTagName('text').Item(0).AppendChild($template.CreateTextNode("${title}")) > $null; ` +
        `$template.GetElementsByTagName('text').Item(1).AppendChild($template.CreateTextNode("${message}")) > $null; ` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("MakeStudio").Show([Windows.UI.Notifications.ToastNotification]::new($template));`;
      spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
    } else {
      return JSON.stringify({ sent: false, reason: `Unsupported platform: ${platform}` });
    }
  } catch (err: any) {
    return JSON.stringify({ sent: false, error: err.message });
  }

  return JSON.stringify({ sent: true, platform, title, message });
}

// ── Skill tool (Fase 4.2) ───────────────────────────────────────────────
// Exposes user-defined skills (markdown files in ~/.makestudio/skills/ or
// .makestudio/skills/ in the project) as a callable tool. The LLM calls
// `Skill { skill: 'deploy-staging', args: ['prod'] }` and receives the
// expanded prompt body — which it then treats as new instructions.
//
// Port of Claude Code's SkillTool. The main difference: Claude Code lists
// skills in the tool description at prompt time; we do the same via the
// description string below. Skill list is recomputed per-session (cwd may
// change, project skills differ per project).

// ── VerifyPlanExecution tool (Fase 4.5) ─────────────────────────────────
// Wrapper around `dispatch_agent subagent_type: 'verification'` that also
// runs a pre-check (SWC compile on changed files when they're .ts/.tsx,
// Flutter analyze when they're .dart) before handing off to the LLM
// verifier. Saves tokens — half of "verification failed" cases are just
// a syntax error the compiler caught already.

// ── ToolSearchTool (Fase 4.3) ───────────────────────────────────────────
// Lookup tool for when the registered tool catalog is large (dozens of
// MCP servers, custom tools, etc.). Two query modes:
//   - Keyword:   "notebook jupyter"   → fuzzy across names + descriptions
//   - Select:    "select:Read,Edit"   → exact-name lookup (one or many)
// Returns the full schemas so the model can call the tools correctly.
//
// Unlike Claude Code's ToolSearch which surfaces "deferred" tools not yet
// loaded, our tool just re-exposes what's already registered — useful
// when the provider hides MCP tools behind a limit, or when the model
// needs a refresher on a specific tool's arguments mid-conversation.

export const toolSearchToolDefinition: ToolDefinition = {
  name: 'ToolSearch',
  description: 'Search the tool catalog by keyword or exact names. Queries: "select:Read,Edit" for exact lookup; "notebook jupyter" for keyword search; "+slack send" to require "slack" in the name.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query. See description for syntax.' },
      max_results: { type: 'number', description: 'Max matches to return for keyword queries (default: 5).' },
    },
    required: ['query'],
  },
};

async function toolSearchImpl(input: any, ctx: ReplContext): Promise<string> {
  const query: string = (input?.query || '').trim();
  if (!query) return JSON.stringify({ error: 'query is required' });
  const max = Math.max(1, Math.min(20, Number(input?.max_results) || 5));

  // Gather the full catalog lazily. eval('require') hides this back-edge
  // from rollup's static cycle detector — the codebase convention for
  // intentional runtime-only loads (see file-tools.ts:249, bash.ts:67).
  const catalog: any[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toolDefinitions } = eval('require')('./tools');
    for (const t of toolDefinitions) catalog.push(t);
  } catch (err) { swallow(err); }
  try {
    const { listMcpTools } = require('../mcp');
    if (typeof listMcpTools === 'function') {
      for (const t of listMcpTools()) catalog.push(t);
    }
  } catch (err) { swallow(err); }

  // Dedupe by name — advanced tools are in both advancedToolDefinitions
  // and `toolDefinitions` after spread.
  const uniq = new Map<string, any>();
  for (const t of catalog) if (t?.name && !uniq.has(t.name)) uniq.set(t.name, t);
  const all = Array.from(uniq.values());

  // ── Mode 1: explicit select ──────────────────────────────────────────
  if (query.startsWith('select:')) {
    const names = query.slice('select:'.length).split(',').map((s) => s.trim()).filter(Boolean);
    const matched = names.map((n) => all.find((t) => t.name === n)).filter(Boolean);
    return JSON.stringify({
      mode: 'select',
      requested: names,
      found: matched.map((t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      missing: names.filter((n) => !all.find((t) => t.name === n)),
    });
  }

  // ── Mode 2: keyword (with optional `+term` required filters) ─────────
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const required = tokens.filter((t) => t.startsWith('+')).map((t) => t.slice(1));
  const free = tokens.filter((t) => !t.startsWith('+'));

  const scored: Array<{ t: any; score: number }> = [];
  for (const t of all) {
    const haystack = `${t.name || ''} ${t.description || ''}`.toLowerCase();
    if (required.some((r) => !haystack.includes(r))) continue;
    if (free.length === 0 && required.length > 0) { scored.push({ t, score: 0 }); continue; }
    let score = 0;
    for (const term of free) {
      if (haystack.includes(term)) {
        score -= 1;
        if ((t.name || '').toLowerCase().includes(term)) score -= 3; // name match wins
      }
    }
    if (score < 0) scored.push({ t, score });
  }
  scored.sort((a, b) => a.score - b.score);
  const top = scored.slice(0, max);

  return JSON.stringify({
    mode: 'keyword',
    query,
    total_catalog: all.length,
    matches: top.map(({ t }) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
  });
}

export const verifyPlanExecutionToolDefinition: ToolDefinition = {
  name: 'VerifyPlanExecution',
  description: 'Verify a completed implementation before telling the user you are done. Phase 1: SWC/flutter pre-check (fast). Phase 2: verification subagent (PASS/FAIL/PARTIAL). Call after non-trivial changes.',
  input_schema: {
    type: 'object',
    properties: {
      original_task: { type: 'string', description: 'The user\'s original request (verbatim if possible).' },
      files_changed: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files you modified.' },
      approach: { type: 'string', description: 'One-paragraph summary of how you approached the change.' },
      skip_pre_check: { type: 'boolean', description: 'Set true to skip the local SWC/flutter compile pre-check (e.g. when the project has no SWC config).' },
    },
    required: ['original_task', 'files_changed', 'approach'],
  },
};

async function verifyPlanExecutionImpl(input: any, ctx: ReplContext): Promise<string> {
  const task: string = input.original_task || '';
  const files: string[] = Array.isArray(input.files_changed) ? input.files_changed : [];
  const approach: string = input.approach || '';
  if (!task.trim()) return JSON.stringify({ verdict: 'FAIL', reason: 'original_task missing' });

  // ── Phase 1: local compile pre-check ───────────────────────────────────
  // Cheap, deterministic, zero LLM tokens. If it fails, skip phase 2 — the
  // verifier would just repeat our diagnosis.
  const preCheckFindings: string[] = [];
  if (!input.skip_pre_check) {
    const { execSync } = require('child_process');
    const tsFiles = files.filter((f: string) => /\.(ts|tsx)$/.test(f));
    const dartFiles = files.filter((f: string) => /\.dart$/.test(f));
    for (const f of tsFiles.slice(0, 20)) {
      try {
        execSync(`npx swc "${f}" -d /tmp/verify-plan --strip-leading-paths`, {
          cwd: ctx.cwd, timeout: 30_000, stdio: 'pipe',
        });
      } catch (err: any) {
        const msg = (err.stderr?.toString() || err.message || '').split('\n').slice(0, 5).join('\n');
        preCheckFindings.push(`SWC error on ${f}:\n${msg}`);
      }
    }
    for (const f of dartFiles.slice(0, 20)) {
      try {
        execSync(`fvm flutter analyze --no-fatal-infos "${f}" 2>&1 | tail -10`, {
          cwd: ctx.cwd, timeout: 60_000, stdio: 'pipe', shell: '/bin/sh',
        });
      } catch (err: any) {
        const msg = (err.stdout?.toString() || err.stderr?.toString() || err.message || '').split('\n').slice(0, 5).join('\n');
        preCheckFindings.push(`Flutter analyze error on ${f}:\n${msg}`);
      }
    }
  }

  if (preCheckFindings.length > 0) {
    return JSON.stringify({
      verdict: 'FAIL',
      phase: 'pre-check',
      reason: 'Local compile check failed before running verifier subagent — fix these first, then re-verify.',
      findings: preCheckFindings,
      recommendation: 'Do NOT tell the user you are done. Read the file(s) above, fix the syntax/type errors, then call VerifyPlanExecution again.',
    });
  }

  // ── Phase 2: verification subagent ─────────────────────────────────────
  const verifierTask = [
    `Original user task:`,
    task,
    ``,
    `Files changed: ${files.length > 0 ? files.join(', ') : '(none reported)'}`,
    ``,
    `Approach taken:`,
    approach,
    ``,
    `Verify that the task is actually complete. Run tests, probes, whatever you need. Produce a PASS/FAIL/PARTIAL verdict with evidence.`,
  ].join('\n');

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { executeTool } = eval('require')('./tools');
    const raw = await executeTool('dispatch_agent', {
      task: verifierTask,
      subagent_type: 'verification',
    }, ctx);
    try {
      const parsed = JSON.parse(raw);
      const summary = parsed.summary || '';
      const verdictMatch = summary.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/);
      const verdict = verdictMatch ? verdictMatch[1] : 'FAIL';
      return JSON.stringify({
        verdict,
        phase: 'subagent',
        evidence: summary,
        iterations: parsed.iterations,
        recommendation: verdict === 'PASS'
          ? 'OK to tell the user the task is complete.'
          : 'Fix the issues the verifier found, then re-verify. Do NOT claim completion.',
      });
    } catch {
      return JSON.stringify({ verdict: 'FAIL', phase: 'subagent', reason: 'verifier output not JSON', raw });
    }
  } catch (err: any) {
    return JSON.stringify({ verdict: 'FAIL', phase: 'subagent', reason: err.message || String(err) });
  }
}

export const skillToolDefinition: ToolDefinition = {
  name: 'Skill',
  description: 'Invoke a user or project skill (prompt template from ~/.makestudio/skills/ or .makestudio/skills/). Returns the expanded body — follow it as instructions. Check the Skills section of the dynamic system prompt for available skills.',
  input_schema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill name (matches frontmatter `name` or filename minus .md)' },
      args:  { type: 'array',  items: { type: 'string' }, description: 'Positional args to interpolate into the skill body.' },
    },
    required: ['skill'],
  },
};

async function skillImpl(input: any, ctx: ReplContext): Promise<string> {
  const { loadAllSkills, findSkill, expandSkill } = require('../skills');
  const skills = loadAllSkills(ctx.cwd);
  const name = String(input?.skill || '').trim();
  if (!name) return JSON.stringify({ error: 'Missing `skill` argument.' });
  const sk = findSkill(skills, name);
  if (!sk) {
    const available = skills.map((s: any) => s.name).sort().join(', ') || '(none registered)';
    return JSON.stringify({
      error: `Skill "${name}" not found.`,
      available,
    });
  }
  // Model-invocation gate — some skills (e.g. /debug) should only fire when
  // the user types them explicitly, not when the model auto-picks them.
  // The router bypasses this via a back-door argument `__userInvoked: true`.
  if (sk.disableModelInvocation && !input?.__userInvoked) {
    return JSON.stringify({
      error: `Skill "${name}" is user-only (disableModelInvocation=true). It fires only when the user types /${name}; you cannot self-invoke it.`,
    });
  }
  const args = Array.isArray(input?.args) ? input.args.map(String) : [];
  // expandSkill honours getPromptForCommand (async) when present, else falls
  // back to {{placeholder}} / $ARGUMENTS substitution on skill.body.
  const body = await expandSkill(sk, args.join(' '), ctx.cwd);
  return JSON.stringify({
    skill: sk.name,
    source: sk.source,
    description: sk.description,
    allowedTools: sk.allowedTools || null,
    instructions: body,
    note: 'Treat the `instructions` field as fresh instructions to follow. Act on them.',
  });
}

// ── apply_patch ─────────────────────────────────────────────────────────────

export const applyPatchToolDefinition: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a multi-file diff atomically. Format starts with `*** Begin Patch` and ends with `*** End Patch`. Use `*** Add File: <path>` (followed by `+`-prefixed lines) to create a file, `*** Update File: <path>` (followed by hunks with optional `@@ <context>` markers, ` ` context lines, `-` removed, `+` added, optional `*** End of File` for the last chunk) to edit an existing file, or `*** Delete File: <path>` to remove one. Optional `*** Move to: <newpath>` after an Update header renames the file. PREFER this over Edit when changing 3+ files in one turn or when an Edit would need brittle exact-string matches — apply_patch tolerates whitespace/punctuation drift via four fallback matchers. Paths can be absolute (e.g. `/tmp/foo/bar.ts`) or relative to the workspace cwd; permission gating is the same as Edit/Write.',
  input_schema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Full patch text including the *** Begin Patch and *** End Patch markers.',
      },
    },
    required: ['input'],
  },
};

async function runApplyPatchTool(input: any, ctx: ReplContext): Promise<string> {
  const patchText = String(input?.input || '');
  if (!patchText.trim()) return JSON.stringify({ error: 'Provide a patch input.' });
  const cwd = ctx.activeProject?.localPath || ctx.cwd;
  try {
    const { applyPatch } = require('./apply-patch');
    const result = await applyPatch(patchText, { cwd, signal: ctx.currentAbortController?.signal });
    return result.text;
  } catch (err: any) {
    return `apply_patch failed: ${err.message || err}`;
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export const advancedToolDefinitions: ToolDefinition[] = [
  lspToolDefinition,
  applyPatchToolDefinition,
  ...todoToolDefinitions,
  askUserQuestionToolDefinition,
  ...bgTaskToolDefinitions,
  ...worktreeToolDefinitions,
  ...planModeToolDefinitions,
  pushNotificationToolDefinition,
  sleepToolDefinition,
  briefToolDefinition,
  cronCreateToolDefinition,
  cronListToolDefinition,
  cronDeleteToolDefinition,
  suggestBackgroundPrToolDefinition,
  skillToolDefinition,
  verifyPlanExecutionToolDefinition,
  toolSearchToolDefinition,
];

// ── Plugin-contributed tools ──────────────────────────────────────────────
//
// Plugins can register extra tools via plugin-repl-bridge. Kept in a
// separate map so the core list above stays auditable. Registered tools
// survive REPL re-mounts; /reload-plugins clears and re-registers.
const pluginTools: Map<string, { def: ToolDefinition; execute: (input: any, ctx: any) => Promise<string | object> | string | object; allowedContexts?: Array<'main' | 'subagent'>; }> = new Map();

export function registerPluginReplTool(tool: {
  name: string;
  description: string;
  input_schema: any;
  execute: (input: any, ctx: any) => Promise<string | object> | string | object;
  allowedContexts?: Array<'main' | 'subagent'>;
}): void {
  if (!tool?.name) throw new Error('plugin tool must have a name');
  pluginTools.set(tool.name, {
    def: { name: tool.name, description: tool.description, input_schema: tool.input_schema },
    execute: tool.execute,
    allowedContexts: tool.allowedContexts,
  });
}

export function __clearPluginReplToolsForTests(): void {
  pluginTools.clear();
}

/** Return the current plugin tool definitions — spread into the main
 *  tool list by the chat harness. */
export function getPluginReplToolDefinitions(): ToolDefinition[] {
  return Array.from(pluginTools.values()).map((t) => t.def);
}

async function executePluginReplTool(name: string, input: any, ctx: ReplContext): Promise<string | null> {
  const entry = pluginTools.get(name);
  if (!entry) return null;
  try {
    const r = await entry.execute(input, { cwd: ctx.cwd });
    return typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e: any) {
    return JSON.stringify({ error: `plugin tool "${name}" threw: ${e.message?.substring(0, 200)}` });
  }
}

export async function executeAdvancedTool(name: string, input: any, ctx: ReplContext): Promise<string> {
  switch (name) {
    case 'LSP':                return runLspTool(input, ctx);
    case 'apply_patch':        return runApplyPatchTool(input, ctx);
    case 'TodoWrite':          return todoWriteImpl(input, ctx);
    case 'TodoUpdate':         return todoUpdateImpl(input, ctx);
    case 'TodoList':           return todoListImpl(input, ctx);
    case 'AskUserQuestion':    return askUserImpl(input, ctx);
    case 'TaskCreate':         return taskCreateImpl(input, ctx);
    case 'TaskOutput':         return taskOutputImpl(input, ctx);
    case 'TaskStatus':         return taskStatusImpl(input, ctx);
    case 'TaskStop':           return taskStopImpl(input, ctx);
    case 'TaskList':           return taskListImpl(input, ctx);
    case 'EnterWorktree':      return enterWorktreeImpl(input, ctx);
    case 'ExitWorktree':       return exitWorktreeImpl(input, ctx);
    case 'WorktreeStatus':     return worktreeStatusImpl(input, ctx);
    case 'EnterPlanMode':      return enterPlanModeImpl(input, ctx);
    case 'ExitPlanMode':       return exitPlanModeImpl(input, ctx);
    case 'PlanModeStatus':     return planModeStatusImpl(input, ctx);
    case 'PushNotification':   return pushNotificationImpl(input, ctx);
    case 'Sleep':              return sleepImpl(input, ctx);
    case 'Brief':              return briefImpl(input, ctx);
    case 'CronCreate':         return cronCreateImpl(input);
    case 'CronList':           return cronListImpl();
    case 'CronDelete':         return cronDeleteImpl(input);
    case 'SuggestBackgroundPR': return suggestBackgroundPrImpl(input, ctx);
    case 'Skill':              return skillImpl(input, ctx);
    case 'VerifyPlanExecution': return verifyPlanExecutionImpl(input, ctx);
    case 'ToolSearch':         return toolSearchImpl(input, ctx);
    default: {
      // Plugin-contributed tools — hit the dynamic registry before failing.
      const pluginResult = await executePluginReplTool(name, input, ctx);
      if (pluginResult !== null) return pluginResult;
      throw new Error(`Unknown advanced tool: ${name}`);
    }
  }
}

const HARDCODED_ADVANCED_TOOLS = new Set<string>([
  'LSP', 'TodoWrite', 'TodoUpdate', 'TodoList', 'AskUserQuestion',
  'TaskCreate', 'TaskOutput', 'TaskStatus', 'TaskStop', 'TaskList',
  'EnterWorktree', 'ExitWorktree', 'WorktreeStatus',
  'EnterPlanMode', 'ExitPlanMode', 'PlanModeStatus',
  'Sleep',
  'Brief',
  'CronCreate', 'CronList', 'CronDelete',
  'SuggestBackgroundPR',
  'PushNotification',
  'Skill',
  'VerifyPlanExecution',
  'ToolSearch',
  'apply_patch',
]);

export function isAdvancedToolName(name: string): boolean {
  // Hardcoded core tools OR a plugin-registered tool (Phase: VS Code
  // extension's IdeOpen, etc.). Without checking pluginTools here, the
  // dispatcher in tools.ts:664 short-circuits before executePluginReplTool
  // ever runs, and the LLM sees "no such tool" for every registered
  // plugin tool.
  return HARDCODED_ADVANCED_TOOLS.has(name) || pluginTools.has(name);
}

// Unused imports avoidance
export { fs, path, os };
