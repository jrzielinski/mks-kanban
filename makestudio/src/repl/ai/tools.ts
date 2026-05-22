import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplContext } from '../context';
import { getApiClient } from '../../network/api-client';
import { fileToolDefinitions, executeFileTool, isFileToolName } from './file-tools';
import { advancedToolDefinitions, executeAdvancedTool, isAdvancedToolName, getPluginReplToolDefinitions } from './advanced-tools';
import { isCoordinatorToolName, executeCoordinatorTool, coordinatorLifecycleToolDefs, coordinatorActiveDefs } from './coordinator-tools';
import { findToolHandler } from './tool-handlers';
import { IdempotencyRegistry } from '../../utils/idempotency-registry';

import { swallow } from '../../utils/log';
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'list_projects',
    description: 'List all projects in the DarkFactory with their status, DUM count, and task count.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project',
    description: 'Get project status (DUMs, tasks, progress). Provide projectName (preferred — no need to call list_projects first) OR projectId UUID.',
    input_schema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'Project name as mentioned by user' },
        projectId: { type: 'string', description: 'Project UUID (when you already have it)' },
      },
      required: [],
    },
  },
  {
    name: 'get_dum_details',
    description: 'Get full details of a specific DUM including all its tasks, descriptions, and status.',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID' },
        dumNumber: { type: 'string', description: 'DUM number like DUM-024 or just 24' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_tasks',
    description: 'List tasks for a project. Provide projectName OR projectId. Optionally filter by status.',
    input_schema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'Project name' },
        projectId: { type: 'string', description: 'Project UUID' },
        status: { type: 'string', description: 'Filter: pending|in_progress|completed|failed' },
      },
      required: [],
    },
  },
  {
    name: 'read_execution_state',
    description: 'Read the .makestudio/execution-state.json file from the project directory. Contains DUM execution status and files created per DUM.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'git_status',
    description: 'Run git status in the project directory to see uncommitted changes.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git commits in the project.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        count: { type: 'number', description: 'Number of commits to show (default: 10)' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the project directory.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        filePath: { type: 'string', description: 'Relative file path within the project' },
      },
      required: ['projectPath', 'filePath'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a pattern in the project codebase using grep.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        pattern: { type: 'string', description: 'Search pattern (regex)' },
        glob: { type: 'string', description: 'File glob filter (e.g. "*.ts", "*.dart")' },
      },
      required: ['projectPath', 'pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'List files matching a glob pattern in the project.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts", "app/lib/**/*.dart")' },
      },
      required: ['projectPath', 'pattern'],
    },
  },
  {
    name: 'dispatch_agent',
    description:
      'Spawn a sub-agent with isolated context. subagent_type options:\n' +
      '  "explore" — fast read-only codebase survey (Glob/Grep/Read/LSP). Use INSTEAD of chained Glob/Grep for "does this project have X?" / "find all Y" questions.\n' +
      '  "plan" — produce a markdown implementation plan (read-only).\n' +
      '  "code-reviewer" — review current git diff for correctness/compliance.\n' +
      '  "verification" — verify implementation before reporting done. Pass original task + files changed + approach. Call this AFTER non-trivial changes (2+ file edits, API/UI changes).\n' +
      '  "general-purpose" — research tasks including web.\n' +
      '  <custom> — any agent name from .claude/agents/ or .makestudio/agents/.\n' +
      'Returns a concise summary. Never writes files or runs destructive commands.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear focused task description. Sub-agent has no memory of our conversation unless session_id is reused.' },
        subagent_type: {
          type: 'string',
          description: 'Built-in flavor (explore/plan/code-reviewer/verification/general-purpose) OR name of a custom agent from .claude/agents or .makestudio/agents.',
        },
        role: { type: 'string', description: 'Optional role hint (e.g. "code-surveyor", "api-docs-reader"). Only used when subagent_type is "general-purpose".' },
        session_id: { type: 'string', description: 'Optional session key. When provided, the subagent reuses its prior conversation (per-type, disk-backed pool, 7-day TTL). Use this to chain follow-up questions without re-doing warm-up. Persists across CLI restarts. Discover existing sessions via list_subagent_sessions.' },
        describe: { type: 'string', description: 'Optional short label for this session — stored with the session file so list_subagent_sessions shows what it was about. Only saved when session_id is provided.' },
        model: { type: 'string', enum: ['claude', 'codex', 'gemini'], description: 'Optional model override for this call. claude=default (Sonnet-tier, best for reasoning), codex=fast (Groq/Llama or similar — cheaper/faster, good for explore/Grep tasks), gemini=image (vision-capable). Omit to inherit the main REPL provider.' },
        mode: { type: 'string', enum: ['in_process', 'subprocess'], description: 'Execution mode. in_process (default) shares the main Node process — fast, full safety pipeline, supports session_id. subprocess spawns a headless Node child for true OS-level isolation — use when the subagent runs long Bash workloads (e.g. verification with npm test) and you want to kill it cleanly on timeout. subprocess does NOT support session_id (child dies at end of call).' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dispatch_agents_parallel',
    description: 'Spawn 2-4 READ-ONLY sub-agents in parallel. Use for independent research fan-out (explore/plan/code-reviewer/general-purpose). DO NOT use for edits — parallel edits diverge. Write-capable sub-agents are rejected.',
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Parallel tasks — each is an independent sub-agent invocation.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Clear focused task description.' },
              subagent_type: { type: 'string', description: 'explore | plan | code-reviewer | general-purpose | <custom-read-only-agent>.' },
              role: { type: 'string', description: 'Optional role hint for general-purpose.' },
            },
            required: ['task'],
          },
          minItems: 2,
          maxItems: 4,
        },
        max_concurrency: {
          type: 'number',
          description: 'Optional cap on simultaneously running sub-agents (1-4). Omit for full parallelism (default). Useful when provider quota or machine load makes full fan-out risky.',
          minimum: 1,
          maximum: 4,
        },
        shared_context: {
          type: 'string',
          description: 'Optional shared prelude prepended to every sub-agent task. Use this to give all workers common grounding (e.g. "Auth uses OAuth2 via src/auth.ts") so they do not each re-discover it. Also surfaces the per-run scratchpad path — workers may Read/write there to exchange findings during the fan-out.',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'mcp_list_servers',
    description: 'List configured MCP servers and a count of their tools / resources / prompts. Tools from MCP servers are auto-injected into this tool list, but use this to verify connectivity and discover what each server exposes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mcp_read_resource',
    description: 'Read an MCP resource by URI. Resources are server-exposed read-only data (e.g. a database schema, a config file) — distinct from tools. URIs follow the resource scheme defined by the server.',
    input_schema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'Full resource URI (e.g. "postgres://schema/public", "file:///config.yaml").' },
      },
      required: ['uri'],
    },
  },
  {
    name: 'mcp_get_prompt',
    description: 'Fetch a templated prompt from an MCP server. Prompts are reusable parameterised text templates the server advertises. Returns the rendered prompt body.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Prompt name as advertised by the server.' },
        args: { type: 'object', description: 'Arguments to fill into the prompt template. Keys/shape depend on the server.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'cron_create',
    description: 'Schedule a recurring task. Persisted to ~/.makestudio/schedule.json — survives CLI restarts. Poller checks every minute while the REPL is running; for fires while closed, run `makestudio scheduled-run` from the system crontab. Use for nightly audits, weekly reports, hourly link checks, etc.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short identifier (e.g. "nightly-audit", "weekly-deps-check"). Must be unique.' },
        cron: { type: 'string', description: 'Standard cron expression (5 fields: min hour dom month dow). Examples: "0 2 * * *" = 02:00 daily, "*/15 * * * *" = every 15min, "0 9 * * 1" = Mondays 09:00.' },
        command: { type: 'string', description: 'The REPL command or prompt to fire. Prefix with / for a slash command (e.g. "/analyze --audit"), or a free-text prompt.' },
      },
      required: ['name', 'cron', 'command'],
    },
  },
  {
    name: 'cron_list',
    description: 'List all scheduled tasks (enabled + disabled).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cron_delete',
    description: 'Remove a scheduled task by id or name.',
    input_schema: {
      type: 'object',
      properties: {
        id_or_name: { type: 'string', description: 'Either the UUID or the unique name of the schedule.' },
      },
      required: ['id_or_name'],
    },
  },
  {
    name: 'list_subagent_sessions',
    description: 'List all persisted dispatch_agent sessions on disk (~/.makestudio/subagent-sessions/). Returns id, subagent type, created/updated timestamps, message count, total tokens, and optional description. Use this BEFORE creating a new session to discover an existing one you can resume with session_id.',
    input_schema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: 'Optional filter — only return sessions for this subagent type (explore/plan/code-reviewer/verification/general-purpose/<custom>).' },
      },
      required: [],
    },
  },
  {
    name: 'drop_subagent_session',
    description: 'Permanently delete a persisted dispatch_agent session from both memory and disk. Use to free up a session_id or clean up stale research.',
    input_schema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: 'Subagent type the session belongs to.' },
        session_id: { type: 'string', description: 'Session id to delete.' },
      },
      required: ['subagent_type', 'session_id'],
    },
  },
  {
    name: 'memory_save',
    description: 'Save knowledge to persistent memory for future sessions (preferences, project facts).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short topic name (e.g. "project-barber-stack")' },
        body: { type: 'string', description: 'Markdown content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['name', 'body'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search persistent memory for relevant topics. Use before asking the user for context you may already have.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pin_session_constraint',
    description:
      'Pin a session-wide rule that the user has just stated and that must hold for the rest of the conversation. ' +
      'Call this when the user expresses a durable constraint (any language, any phrasing). Pass `text` as a CANONICAL imperative-form summary ' +
      'of the rule (1 sentence) and OPTIONALLY pass `verifyCommand` — a shell command that proves the rule was met when it exits 0. ' +
      'Choose `verifyCommand` based on THIS project\'s actual stack: `npx tsc --noEmit` for a TypeScript repo, `cargo check` / `cargo test` for Rust, ' +
      '`pytest -q` / `mypy` for Python, `flutter analyze` / `dart test` for Flutter, `go vet ./...` / `go test ./...` for Go, `mvn verify` for Java/Maven, ' +
      '`bundle exec rspec` for Ruby, etc. Inspect the project (CLAUDE.md, lockfiles, build configs) to decide. ' +
      'When the rule is process-only (e.g. "do not commit without explicit permission"), omit `verifyCommand` — the model self-verifies at end-of-turn. ' +
      'Once pinned, the constraint is rendered into every subsequent system prompt so future turns cannot forget it. ' +
      'Do NOT call this for one-off task instructions ("implement X now") — only for rules that should hold across multiple turns.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Canonical imperative form of the rule, e.g. "Typecheck must pass with zero errors before declaring done."',
        },
        verifyCommand: {
          type: 'string',
          description:
            'Optional shell command run at end-of-turn from the project root. Exit 0 = PASS, anything else = FAIL. ' +
            'Examples: `npx tsc --noEmit`, `cargo check`, `pytest -q`, `flutter analyze`, `mvn verify`, `go vet ./...`. ' +
            'Omit when the rule is not mechanically verifiable.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'read_attachment',
    description: 'Fetch full content of a pasted attachment by ID (the N in [Pasted #N]).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Attachment ID (e.g. the N in [Pasted #N])' },
      },
      required: ['id'],
    },
  },
  {
    name: 'shell_run',
    description: 'Execute a shell command (sandboxed). Destructive commands require approval. sandboxLevel: none|readonly|project(default)|full.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root (writable)' },
        command: { type: 'string', description: 'Shell command to execute' },
        sandboxLevel: {
          type: 'string',
          enum: ['none', 'readonly', 'project', 'full'],
          description: 'Sandbox level (default: project).',
        },
      },
      required: ['projectPath', 'command'],
    },
  },
  {
    name: 'hover',
    description: 'Get LSP hover info at a specific position (types, JSDoc, etc). Use when find_definition is not enough.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        filePath: { type: 'string', description: 'Relative path to the file' },
        line: { type: 'number', description: 'Line number (0-based)' },
        character: { type: 'number', description: 'Character offset (0-based)' },
      },
      required: ['projectPath', 'filePath', 'line', 'character'],
    },
  },
  {
    name: 'find_definition',
    description: 'Find where a class, function, interface, enum, or type is DEFINED in the project. Semantic search — better than plain grep. Works for TypeScript and Dart.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        symbol: { type: 'string', description: 'Symbol name (e.g. "UserDto", "getUser", "PaymentStatus")' },
      },
      required: ['projectPath', 'symbol'],
    },
  },
  {
    name: 'find_references',
    description: 'Find all places where a symbol is USED (imports, calls, instantiations). Excludes the definition itself.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        symbol: { type: 'string', description: 'Symbol name to search for usages of' },
      },
      required: ['projectPath', 'symbol'],
    },
  },
  {
    name: 'get_symbols',
    description: 'List all top-level classes, functions, interfaces, enums in a file. Useful to quickly understand a file\'s contents without reading it fully.',
    input_schema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project root' },
        filePath: { type: 'string', description: 'Relative path to the file within the project' },
      },
      required: ['projectPath', 'filePath'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web via DuckDuckGo for up-to-date information (docs, library versions, API schemas). Use when you need recent info outside the codebase.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "NestJS 10 migration guide")' },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'If set, only return results from these domains (e.g. ["docs.python.org", "stackoverflow.com"]).',
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude results from these domains.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a specific URL and return its text content. Use to read documentation pages, API specs, GitHub READMEs. Pass `prompt` to extract only the relevant part.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL (https://...)' },
        prompt: {
          type: 'string',
          description: 'If provided, use the fast model to extract only information relevant to this question/task from the page. Saves tokens when the page is long.',
        },
      },
      required: ['url'],
    },
  },
  // ── File & code tools (Read/Write/Edit/MultiEdit/Glob/Grep/Bash) ──
  ...fileToolDefinitions,
  // ── Advanced tools (LSP, TodoWrite, AskUserQuestion, background Task) ──
  ...advancedToolDefinitions,
];

/**
 * Returns toolDefinitions PLUS any plugin-registered REPL tools. Call
 * this right before sending tools to the model so plugin contributions
 * (registered via plugin-repl-bridge) show up. Static `toolDefinitions`
 * stays unchanged to preserve import-site semantics elsewhere.
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  try {
    return [...toolDefinitions, ...getPluginReplToolDefinitions()];
  } catch {
    return toolDefinitions;
  }
}

/**
 * Returns coordinator tool definitions based on current ctx state:
 *   - lifecycle tools (activate/deactivate) are ALWAYS included
 *   - active tools (spawn_worker, send_message, etc.) are included only when coordinatorActive
 */
export function getCoordinatorToolDefs(ctx: ReplContext): ToolDefinition[] {
  return [
    ...coordinatorLifecycleToolDefs,
    ...(ctx.coordinatorActive ? coordinatorActiveDefs : []),
  ];
}

export async function executeTool(name: string, input: any, ctx: ReplContext): Promise<string> {
  // Idempotency check — for side-effect tools, deduplicate when the same
  // tool+input pair arrives within the TTL. Prevents duplicate side effects
  // from retries, message replays, or race conditions.
  const idempotencyKey = IdempotencyRegistry.isSideEffectTool(name)
    ? IdempotencyRegistry.buildKey(name, input || {})
    : null;
  if (idempotencyKey && ctx.idempotencyRegistry) {
    const cached = ctx.idempotencyRegistry.get(idempotencyKey);
    if (cached !== undefined) {
      return cached;
    }
  }
  // Tool-loop detection — runs BEFORE every tool call. When stuck,
  // we either refuse (critical) or surface a warning that the model
  // sees as the tool result. The warning string contains explicit
  // "stop and report failure" guidance straight from the openclaw
  // detector messages, so the model has a clear next step instead
  // of just "your loop was caught".
  try {
    const { detectToolCallLoop, recordToolCall } = require('./tool-loop-detection');
    const state: any = ctx;
    const verdict = detectToolCallLoop(state, name, input, (ctx as any).toolLoopDetectionConfig);
    if (verdict.stuck) {
      // Critical findings hard-stop the call. Warning findings are
      // surfaced as tool output but the call still runs — the model
      // gets BOTH the warning AND the real result so it can decide
      // whether to keep going.
      if (verdict.level === 'critical') {
        // Don't even record the would-be call; the history already
        // tells the story. Return a tool-result-shaped string so the
        // outer loop knows this turn didn't make progress.
        return `[tool-loop-detection] ${verdict.message}\n\nDetector: ${verdict.detector}. Stop calling \`${name}\` with these arguments.`;
      }
      // Warning — record AND prepend to the eventual real result.
      recordToolCall(state, name, input, undefined, (ctx as any).toolLoopDetectionConfig);
      const realResult = await runUnderlyingTool(name, input, ctx);
      try {
        const { recordToolCallOutcome } = require('./tool-loop-detection');
        recordToolCallOutcome(state, {
          toolName: name, toolParams: input, result: realResult,
          config: (ctx as any).toolLoopDetectionConfig,
        });
      } catch (err) { swallow(err); }
      return `[tool-loop-detection] ${verdict.message}\n\n---\n\n${realResult}`;
    }
    recordToolCall(state, name, input, undefined, (ctx as any).toolLoopDetectionConfig);
  } catch (err) { swallow(err); }

  let result: string | undefined;
  let toolErr: any = undefined;
  // Trajectory: record the start now so the seq is the parent for the
  // matching end/error event below.
  let startSeq: number | null = null;
  try {
    const { recordCtxEvent } = require('../trajectory');
    startSeq = recordCtxEvent(ctx, 'tool', 'tool_call_start', {
      tool: name,
      input,
    });
  } catch (err) { swallow(err); }
  const startedAt = Date.now();
  // Per-tool elapsed warning. When a single tool call goes over the
  // soft threshold (30s) the user gets a transient status alert so a
  // slow Bash / Write / Read doesn't look frozen. Self-rearming until
  // the tool finishes — keeps ticking every threshold.
  const TOOL_SLOW_MS = 30_000;
  let slowTimer: NodeJS.Timeout | null = setTimeout(function tick() {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    try {
      const { setTransientStatus } = require('../tui/bridge');
      setTransientStatus?.(`${name} taking longer than usual · ${elapsed}s · Esc Esc to interrupt`, 5000);
    } catch (err) { swallow(err); }
    slowTimer = setTimeout(tick, TOOL_SLOW_MS);
    slowTimer.unref?.();
  }, TOOL_SLOW_MS);
  slowTimer.unref?.();
  const clearSlowTimer = () => {
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
  };
  try {
    result = await runUnderlyingTool(name, input, ctx);
    clearSlowTimer();
    // Store successful result in idempotency registry so the same
    // tool+input pair isn't re-executed within the TTL.
    if (idempotencyKey) {
      try { ctx.idempotencyRegistry.set(idempotencyKey, result); } catch (err) { swallow(err); }
    }
    try {
      const { recordCtxEvent } = require('../trajectory');
      recordCtxEvent(ctx, 'tool', 'tool_call_end', {
        tool: name,
        ms: Date.now() - startedAt,
        // Result preview only — full content lives in session JSONL.
        resultPreview: typeof result === 'string'
          ? result.slice(0, 600)
          : '[non-string]',
      }, startSeq ?? undefined);
    } catch (err) { swallow(err); }
    return result;
  } catch (err: any) {
    toolErr = err;
    clearSlowTimer();
    try {
      const { recordCtxEvent } = require('../trajectory');
      recordCtxEvent(ctx, 'tool', 'tool_call_error', {
        tool: name,
        ms: Date.now() - startedAt,
        error: err?.message || String(err),
      }, startSeq ?? undefined);
    } catch (err) { swallow(err); }
    throw err;
  } finally {
    clearSlowTimer();
    try {
      const { recordToolCallOutcome } = require('./tool-loop-detection');
      const state: any = ctx;
      recordToolCallOutcome(state, {
        toolName: name, toolParams: input, result, error: toolErr,
        config: (ctx as any).toolLoopDetectionConfig,
      });
    } catch (err) { swallow(err); }
  }
}

/**
 * Original dispatch — extracted from executeTool so the loop-detection
 * wrapper above can call it for both happy-path and warning-path
 * (warning still runs the tool, just prepends a warning message).
 */
async function runUnderlyingTool(name: string, input: any, ctx: ReplContext): Promise<string> {
  // Pre-dispatch input validation. Catches malformed tool_use blocks
  // (empty input / missing required fields / wrong types) BEFORE the
  // underlying impl crashes with a raw Node error like "path argument
  // must be of type string. Received undefined". The validator throws a
  // descriptive message that becomes the tool_result, so the model can
  // self-correct in the same loop instead of looping on opaque errors.
  try {
    const { validateToolInput } = require('./tool-input-validator');
    validateToolInput(name, input);
  } catch (err: any) {
    return `Error in ${name}: ${err.message || String(err)}`;
  }

  // Coordinator tools — handled before file/advanced tools
  if (isCoordinatorToolName(name, ctx)) {
    try {
      return await executeCoordinatorTool(name, input, ctx);
    } catch (err: any) {
      return `Error in ${name}: ${err.message || String(err)}`;
    }
  }
  // File/code tools — dispatched directly, no API call needed.
  if (isFileToolName(name)) {
    try {
      const result = await executeFileTool(name, input, ctx);
      // After a successful Write/Edit/MultiEdit, append any LSP diagnostics
      // for the touched file so the model fixes type errors / missing
      // imports in the next turn instead of waiting for verify-runner.
      // Best-effort: silently skipped when no LSP server is registered for
      // the file's language, when the server hasn't pushed diagnostics
      // yet, or when there are no Error-severity findings.
      if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
        try {
          const fp = input?.file_path || input?.filePath;
          if (fp && typeof fp === 'string') {
            const { getDiagnostics } = require('../lsp');
            const root = ctx.activeProject?.localPath || ctx.cwd;
            const diags = getDiagnostics?.(root, fp);
            if (Array.isArray(diags) && diags.length > 0) {
              const errors = diags.filter((d: any) => d.severity === 1);
              if (errors.length > 0) {
                const lines = errors.slice(0, 10).map((d: any) =>
                  `  ${fp}:${d.line}:${d.character}  ${d.message}${d.source ? ` [${d.source}${d.code ? ' ' + d.code : ''}]` : ''}`,
                );
                const more = errors.length > 10 ? `\n  ... and ${errors.length - 10} more` : '';
                return `${result}\n\n[LSP diagnostics — ${errors.length} error${errors.length === 1 ? '' : 's'} on this file]\n${lines.join('\n')}${more}\nFix these before moving on.`;
              }
            }
          }
        } catch (err) { swallow(err); }
      }
      return result;
    } catch (err: any) {
      return `Error in ${name}: ${err.message || String(err)}`;
    }
  }
  if (isAdvancedToolName(name)) {
    try {
      return await executeAdvancedTool(name, input, ctx);
    } catch (err: any) {
      return `Error in ${name}: ${err.message || String(err)}`;
    }
  }

  // Registry lookup — each tool's body lives in tool-handlers/<topic>.ts.
  // Behaviour identical to the previous switch; the fallback below
  // produces the same self-correcting "no such tool" hint for the model.
  try {
    const handler = findToolHandler(name);
    if (handler) {
      return await handler(input, ctx);
    }
    return JSON.stringify({
      error: `No such tool available: ${name}`,
      hint: buildUnknownToolHint(name),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}


/** Return a plaintext hint explaining how the model might self-correct
 * from an unknown-tool error. Lists the 5 closest tool names by Levenshtein
 * distance, notes the MCP prefix pattern, and suggests ToolSearch. */
function buildUnknownToolHint(attempted: string): string {
  const allNames: string[] = [];
  for (const t of toolDefinitions as any[]) if (t?.name) allNames.push(t.name);
  // Edit-distance with early-out cap at 4 (anything further is "different").
  const scored = allNames
    .map((n) => ({ n, d: levenshtein(n.toLowerCase(), attempted.toLowerCase(), 4) }))
    .filter((x) => x.d <= 4)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.n);
  const suggestions = scored.length > 0 ? `Did you mean one of: ${scored.join(', ')}?` : '';
  const mcpHint = attempted.includes('.')
    ? `MCP tools are exposed with a server prefix: "<serverName>.<toolName>". Verify the server name by running the "ListMcpServers" MCP command if available.`
    : '';
  const toolSearchHint = `Use the ToolSearch tool ({"query": "select:<name>"} for exact lookup, or free-text for keyword search) to discover the correct name and its input_schema.`;
  return [suggestions, mcpHint, toolSearchHint].filter(Boolean).join(' ');
}

/** Bounded Levenshtein — returns early if distance exceeds `cap`. */
function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1).fill(0);
  const curr = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

