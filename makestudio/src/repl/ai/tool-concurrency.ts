/**
 * tool-concurrency.ts — classifies a tool_use as safe-to-run-in-parallel
 * or not. Mirrors claude-code's per-tool isConcurrencySafe(input)
 * contract from src/Tool.ts.
 *
 * Why this is a SEPARATE classifier from diagnostic-streak.ts:
 *   - diagnostic-streak: classifies for the "stuck investigating"
 *     reminder — Bash with `npm run build` is PROGRESS (resets streak).
 *   - tool-concurrency: classifies for safe-to-parallelise — Bash with
 *     `npm run build` is NOT safe to parallelise (mutates state, races
 *     with other builds). The categories overlap but are not identical.
 *
 * Three signals matter:
 *   - Idempotent: running it twice with the same input gives the same
 *     observable result. Read/Glob/Grep are idempotent. Write is not
 *     (creates the file the first time, overwrites the second).
 *   - Side-effect-free: doesn't mutate disk, network, or external
 *     state. Read/Glob/Grep yes. WebFetch is mostly side-effect-free
 *     (server-side caching aside) so we treat it as safe. Bash with
 *     a write command is not.
 *   - Contention-free: doesn't fight another instance of itself. LSP
 *     ops are safe (LSP server is single-threaded but queues). Bash
 *     `npm install` racing another `npm install` corrupts node_modules.
 *
 * A tool that meets all three is `concurrencySafe = true`. Default is
 * conservative: unknown tools return false.
 */

const ALWAYS_SAFE = new Set([
  'Read', 'read_file',
  'Glob',
  'Grep',
  'WebFetch', 'web_fetch',
  'web_search',
  'lsp_definition', 'lsp_references', 'lsp_hover',
  'lsp_workspace_symbol', 'lsp_document_symbol',
  'lsp_diagnostics',
  'lsp_incoming_calls', 'lsp_outgoing_calls',
  // Read-shaped backend tools
  'get_project', 'get_tasks', 'list_projects',
  'memory_search',
]);

const NEVER_SAFE = new Set([
  // File mutation
  'Edit', 'edit_file',
  'Write', 'write_file',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  // Plan / mode flips — touch ctx state, not parallel-safe
  'EnterPlanMode', 'ExitPlanMode',
  'EnterWorktree', 'ExitWorktree',
  'TodoWrite', 'TodoUpdate',
  // Spawn / dispatch — own concurrency model, don't double-spawn
  'dispatch_agent', 'dispatch_agents_parallel',
  // Notifications & questions — sequential by intent
  'AskUserQuestion',
  'PushNotification',
  // Memory writes
  'memory_save',
]);

// Bash is special: depends on the command. A `git log` is safe, a
// `git commit` is not. Same heuristic as diagnostic-streak's
// classifier but the conclusion is different — `npm run build` IS a
// progress tool there but is NOT concurrency-safe here (two builds
// would race the same dist/).
const BASH_READ_HEAD = /^(grep|rg|find|ls|cat|head|tail|wc|tree|file|du|df|stat|sed -n |awk |which|type|whereis|pwd|env|printenv|date|whoami|id|uname|node --version|npm ls|npm list|git\s+(log|diff|show|status|branch|remote|blame|reflog|describe|tag\s+--list|stash\s+list)|echo |printf )/;

export function isToolConcurrencySafe(toolName: string, toolInput: any): boolean {
  if (ALWAYS_SAFE.has(toolName)) return true;
  if (NEVER_SAFE.has(toolName)) return false;
  if (toolName === 'Bash' || toolName === 'shell_run') {
    const cmd = String(toolInput?.command || '').trim();
    if (!cmd) return false; // empty bash → unknown
    return BASH_READ_HEAD.test(cmd);
  }
  // Unknown tool → assume not safe (conservative, matches claude-code default)
  return false;
}

export interface ToolBatch {
  /** All tools in this batch share the same isConcurrencySafe verdict.
   *  When true, run them via Promise.all. When false, run serial. */
  concurrencySafe: boolean;
  tools: Array<{ id: string; name: string; input: any }>;
}

/**
 * Partition a list of tool_uses into runnable batches:
 *   - Consecutive concurrency-safe tools → grouped together (run in parallel)
 *   - Any non-safe tool → its own batch of size 1 (run serial)
 *
 * Order is preserved across batches so an Edit between two Reads still
 * produces [Read+Read][Edit][...] instead of merging the Reads across
 * the Edit (which would let the second Read see post-Edit state by
 * accident).
 *
 * Port of claude-code's partitionToolCalls (services/tools/toolOrchestration.ts).
 */
export function partitionToolUses(
  toolUses: Array<{ id: string; name: string; input: any }>,
): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const t of toolUses) {
    const safe = isToolConcurrencySafe(t.name, t.input);
    const last = batches[batches.length - 1];
    if (safe && last && last.concurrencySafe) {
      last.tools.push(t);
    } else if (safe) {
      batches.push({ concurrencySafe: true, tools: [t] });
    } else {
      batches.push({ concurrencySafe: false, tools: [t] });
    }
  }
  return batches;
}

/**
 * Cap on the number of tools we run truly concurrently inside a single
 * concurrency-safe batch. Without this, a model emitting 30 Reads would
 * open 30 file handles + 30 simultaneous outbound HTTP fetches if
 * WebFetch is in the mix, which can saturate the system.
 *
 * Tunable via env so power users can lower it on slow disks.
 */
export function getMaxConcurrency(): number {
  const env = parseInt(process.env.MAKESTUDIO_MAX_TOOL_CONCURRENCY || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  return 10; // matches claude-code's default
}
