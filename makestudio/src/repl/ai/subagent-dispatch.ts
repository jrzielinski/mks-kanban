import { swallow } from '../../utils/log';
/**
 * subagent-dispatch.ts — handlers for dispatch_agent and
 * dispatch_agents_parallel. Extracted from tools.ts to keep that file's
 * switch statement readable.
 *
 * Behavior is identical to the previous inline cases; only location changed.
 * The executeTool() reference needed by dispatch_agent (for nested sub-tool
 * calls) and dispatch_agents_parallel (for the fan-out) is resolved via
 * lazy require to avoid a circular import.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplContext } from '../context';
import { buildSubagentConfig } from './subagent-config';

function truncate(text: string, maxLen: number = 3000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n... (truncated, ${text.length - maxLen} chars omitted)`;
}

/**
 * Fold per-call subagent token usage into the ctx-level aggregate. Typed
 * through ctx.subagentTokens (declared in ReplContext) so refactors can't
 * silently drop fields. Called on every dispatch_agent completion.
 */
function foldSubagentTokens(
  ctx: ReplContext,
  subagentType: string,
  tokens: { prompt: number; completion: number; total: number },
): void {
  try {
    const agg = ctx.subagentTokens ?? { prompt: 0, completion: 0, total: 0, calls: 0, byType: {} };
    agg.prompt += tokens.prompt;
    agg.completion += tokens.completion;
    agg.total += tokens.total;
    agg.calls += 1;
    const perType = agg.byType[subagentType] ?? { prompt: 0, completion: 0, total: 0, calls: 0 };
    perType.prompt += tokens.prompt;
    perType.completion += tokens.completion;
    perType.total += tokens.total;
    perType.calls += 1;
    agg.byType[subagentType] = perType;
    ctx.subagentTokens = agg;
  } catch (err) { swallow(err); }
}

// Tool categories used by the parallel validator. Kept in sync with the
// corresponding sets previously inlined in tools.ts.
const READ_ONLY_BUILTIN = new Set(['explore', 'plan', 'code-reviewer', 'general-purpose']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'shell_run', 'NotebookEdit']);

/**
 * Emit a progress line for the TUI so the user sees what a subagent is doing
 * while it runs. Previously dispatch_agent/dispatch_agents_parallel were
 * completely silent — the main loop showed the outer tool spinner but gave
 * no signal on what the inner work was. Logs route through the bridge as
 * role:'info' so they render in the message list (not the dynamic area,
 * which would scroll on every write).
 */
function dispatchLog(label: string, text: string): void {
  const line = `[${label}] ${text}`;
  try {
    const { getTuiBridge } = require('../tui/bridge');
    const bridge = getTuiBridge?.();
    if (bridge) { bridge.addMessage({ role: 'info', text: line }); return; }
  } catch (err) { swallow(err); }
  if (process.env.MAKESTUDIO_DEBUG) process.stderr.write(line + '\n');
}

/** Short preview of arbitrary string for log lines. */
function preview(s: string, max = 110): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

/**
 * Tools that are inherently read-only and stateless. When the permission
 * engine returns 'ask' for one of these INSIDE a subagent, we auto-allow:
 * the subagent's allowedNames whitelist has already gated capabilities, and
 * forcing users to add explicit allow-rules for basic Read/Grep kills any
 * read-only subagent in default permission mode. Bash/Write/Edit are NOT
 * here — they still go through the full permission pipeline and 'ask' → deny.
 */
const SAFE_READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LSP',
  'list_projects', 'get_project', 'get_tasks', 'get_dum_details',
  'read_execution_state', 'read_attachment',
  'find_definition', 'find_references', 'get_symbols', 'hover',
  'read_file', 'list_files', 'search_code',
  'git_status', 'git_log',
  'web_search', 'web_fetch',
]);

export async function executeDispatchAgentsParallel(ctx: ReplContext, input: any): Promise<string> {
  if (!Array.isArray(input?.tasks) || input.tasks.length < 2) {
    return JSON.stringify({ error: 'tasks array (min 2) is required — use dispatch_agent for single invocations.' });
  }
  if (input.tasks.length > 4) {
    return JSON.stringify({ error: 'max 4 parallel subagents (cost/stability cap)' });
  }
  const { findCustomAgent: findCA } = require('./custom-agents');
  // Upfront validation — reject if ANY task targets a write-capable subagent.
  // We NEVER parallelise anything that can mutate the tree.
  for (const t of input.tasks) {
    const st = t.subagent_type;
    if (!st) continue; // defaults to general-purpose (read-only)
    if (READ_ONLY_BUILTIN.has(st)) continue;
    if (st === 'verification') {
      return JSON.stringify({ error: 'verification is intentionally sequential (touches Bash); use dispatch_agent.' });
    }
    const custom = findCA(ctx.cwd, st);
    if (!custom) {
      return JSON.stringify({ error: `Unknown subagent_type "${st}". Use built-in read-only types or a registered custom agent.` });
    }
    if (custom.tools && custom.tools.some((n: string) => WRITE_TOOLS.has(n))) {
      return JSON.stringify({ error: `Custom agent "${st}" has write-capable tools (${custom.tools.filter((n: string) => WRITE_TOOLS.has(n)).join(', ')}). Parallel execution would produce divergent edits. Run sequentially via dispatch_agent.` });
    }
  }

  // Fan out — each invocation is a normal executeTool('dispatch_agent') so
  // all the per-type system prompts, tool whitelists and retries already
  // apply. Promise.allSettled captures errors per-task.
  //
  // max_concurrency: when set, run tasks through a simple semaphore that
  // keeps only N in flight at a time. Default (omitted / > tasks.length)
  // preserves the original all-at-once behaviour.
  //
  // shared_context: prepended to every task so all workers start with the
  // same grounding. Each run also gets a scratchpad directory that workers
  // can Read/write to exchange findings mid-run.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // eval('require') hides this back-edge from rollup's cycle detector.
  const { executeTool } = eval('require')('./tools');
  const parallelStart = Date.now();
  const cap = typeof input.max_concurrency === 'number' ? input.max_concurrency : 0;
  const runId = `par-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const runScratchDir = path.join(os.homedir(), '.makestudio', 'scratch', runId);
  try { fs.mkdirSync(runScratchDir, { recursive: true }); } catch (err) { swallow(err); }
  const sharedPrelude = input.shared_context
    ? `## Shared context\n\n${input.shared_context}\n\n`
    : '';
  const scratchPrelude = `## Shared scratchpad (this parallel run)\n\nDirectory: ${runScratchDir}/\nOther workers are running in parallel on related tasks. As they write findings to this directory (you or they via Bash: \`echo ... > ${runScratchDir}/<id>.md\`), any worker may Read them to cross-check. Write your own partial findings with a descriptive filename if they would help other workers.\n\n`;
  const buildAugmentedTask = (t: any) => `${sharedPrelude}${scratchPrelude}## Your task\n\n${t.task}`;

  // Announce the fan-out so the user sees what's starting.
  dispatchLog('parallel', `running ${input.tasks.length} subagent${input.tasks.length === 1 ? '' : 's'}${cap > 0 && cap < input.tasks.length ? ` (${cap} at a time)` : ''}`);
  input.tasks.forEach((t: any, i: number) => {
    const stype = t.subagent_type || 'general-purpose';
    dispatchLog(`par-${i}:${stype}`, preview(t.task, 90));
  });

  const runOne = (t: any, idx: number) => {
    const stype = t.subagent_type || 'general-purpose';
    const startMs = Date.now();
    return executeTool('dispatch_agent', {
      task: buildAugmentedTask(t),
      subagent_type: t.subagent_type,
      role: t.role,
      __dispatchLabel: `par-${idx}:${stype}`, // consumed by dispatch_agent for progress logs
    }, ctx).then((v: string) => {
      const secs = Math.round((Date.now() - startMs) / 1000);
      let info = `done (${secs}s)`;
      try {
        const parsed = JSON.parse(v);
        if (parsed.tokens?.total) info = `done (${secs}s, ${(parsed.tokens.total / 1000).toFixed(1)}k tok)`;
        if (parsed.error) info = `failed: ${preview(parsed.error, 80)}`;
      } catch (err) { swallow(err); }
      dispatchLog(`par-${idx}:${stype}`, info);
      return v;
    }).catch((err: any) => {
      dispatchLog(`par-${idx}:${stype}`, `failed: ${err?.message || err}`);
      throw err;
    });
  };

  let settled: PromiseSettledResult<string>[];
  if (cap > 0 && cap < input.tasks.length) {
    settled = new Array(input.tasks.length);
    let nextIdx = 0;
    const worker = async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= input.tasks.length) return;
        try {
          const v = await runOne(input.tasks[i], i);
          settled[i] = { status: 'fulfilled', value: v };
        } catch (e) {
          settled[i] = { status: 'rejected', reason: e };
        }
      }
    };
    const pool = Array.from({ length: Math.min(cap, input.tasks.length) }, () => worker());
    await Promise.all(pool);
  } else {
    settled = await Promise.allSettled(input.tasks.map((t: any, i: number) => runOne(t, i)));
  }
  const results = settled.map((r, i) => {
    const base: any = { index: i, task: input.tasks[i].task, subagent_type: input.tasks[i].subagent_type || 'general-purpose' };
    if (r.status === 'fulfilled') {
      try { return { ...base, ok: true, result: JSON.parse(r.value) }; }
      catch { return { ...base, ok: true, result: { raw: r.value } }; }
    }
    return { ...base, ok: false, error: (r.reason?.message || String(r.reason)).substring(0, 300) };
  });
  try {
    require('../../utils/events').recordEvent('parallel_dispatch', {
      n: input.tasks.length,
      ok: results.filter((r) => r.ok).length,
      durationMs: Date.now() - parallelStart,
    });
  } catch (err) { swallow(err); }
  let scratchpadKeys: string[] = [];
  try { scratchpadKeys = fs.readdirSync(runScratchDir); } catch (err) { swallow(err); }
  return JSON.stringify({
    n: input.tasks.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    wallClockMs: Date.now() - parallelStart,
    runId,
    scratchpad: { dir: runScratchDir, keys: scratchpadKeys },
    results,
  });
}

// Circuit breaker for dispatch_agent failures. When the backend returns
// 4xx (bad request) or the subagent itself errors out repeatedly, the
// model tends to retry — burning 30s and tokens per failed call. Trip
// after 3 consecutive failures and refuse all dispatch_agent calls for
// the next 5 minutes; the user can rerun once the cooldown is over.
const SUBAGENT_BREAKER_MAX_FAILURES = 3;
const SUBAGENT_BREAKER_COOLDOWN_MS = 5 * 60_000;
let subagentBreakerFailures = 0;
let subagentBreakerOpenUntil = 0;

function recordSubagentFailure(_kind: string): void {
  subagentBreakerFailures += 1;
  if (subagentBreakerFailures >= SUBAGENT_BREAKER_MAX_FAILURES) {
    subagentBreakerOpenUntil = Date.now() + SUBAGENT_BREAKER_COOLDOWN_MS;
  }
}

function recordSubagentSuccess(): void {
  subagentBreakerFailures = 0;
  subagentBreakerOpenUntil = 0;
}

function subagentBreakerStatus(): { blocked: boolean; reason?: string } {
  const now = Date.now();
  if (subagentBreakerOpenUntil > now) {
    const remainSec = Math.ceil((subagentBreakerOpenUntil - now) / 1000);
    return {
      blocked: true,
      reason: `dispatch_agent circuit breaker OPEN (${subagentBreakerFailures} consecutive failures) — cooling down ${remainSec}s. Try again later, or run the work directly.`,
    };
  }
  return { blocked: false };
}

export async function executeDispatchAgent(ctx: ReplContext, input: any): Promise<string> {
  if (!input.task) return JSON.stringify({ error: 'task is required' });

  // Circuit breaker — refuse rapidly when subagents have been failing.
  // Keeps the model from burning more tokens on calls that would just
  // 400 again. The 5-minute cooldown is long enough that the user can
  // notice and restart, short enough not to be permanently disabling.
  const breaker = subagentBreakerStatus();
  if (breaker.blocked) {
    return JSON.stringify({ error: breaker.reason });
  }

  // Recursion guard: a subagent that itself calls dispatch_agent would fan
  // out exponentially. Hard-cap at depth 2 so main→subagent is fine but
  // subagent→subagent is rejected.
  const MAX_SUBAGENT_DEPTH = 2;
  const currentDepth = (ctx as any).__subagentDepth || 0;
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    return JSON.stringify({
      error: `subagent recursion limit reached (depth ${currentDepth} >= ${MAX_SUBAGENT_DEPTH}). A subagent cannot itself dispatch another subagent.`,
    });
  }
  (ctx as any).__subagentDepth = currentDepth + 1;
  const { getProvider } = require('./providers');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { executeTool, toolDefinitions } = eval('require')('./tools');
  const subagentType: string = input.subagent_type || 'general-purpose';

  // Worktree isolation — when caller passes `isolation: 'worktree'`,
  // create a fresh git worktree on a throwaway branch and run the
  // subagent against THAT path instead of the user's working tree.
  // Cleanup happens in the surrounding try/finally below. Errors
  // during creation surface as a regular subagent error (the dispatch
  // never half-runs).
  let worktreeHandle: any = null;
  let worktreeKept = false;
  let projectPath = ctx.activeProject?.localPath || ctx.cwd;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wantsWorktreeIsolation, createSubagentWorktree } = require('./subagent-worktree');
    if (wantsWorktreeIsolation(input)) {
      worktreeHandle = createSubagentWorktree(projectPath, subagentType);
      projectPath = worktreeHandle.path;
      worktreeKept = !!input.keepWorktree;
    }
  } catch (err: any) {
    return JSON.stringify({
      error: `Worktree isolation failed: ${err.message || String(err)}. Retry without isolation:'worktree' or run from a git repo root.`,
    });
  }
  // Label used on progress lines. When invoked from dispatch_agents_parallel
  // the caller injects `par-<i>:<type>`; solo invocations fall back to the type.
  const logLabel: string = input.__dispatchLabel || subagentType;
  const soloDispatch = !input.__dispatchLabel;
  if (soloDispatch) dispatchLog(logLabel, `starting (${preview(input.task, 80)})`);
  try {
    const { runHooks } = require('../hooks');
    runHooks('SubagentStart', { projectPath, toolName: 'dispatch_agent', toolInput: input, currentAbortController: (ctx as any).currentAbortController }).catch(() => {});
  } catch (err) { swallow(err); }

  let cfg;
  try {
    cfg = buildSubagentConfig(subagentType, ctx, input.role);
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
  const subAgentSystem = cfg.system;
  const allowedNames = cfg.allowedTools;
  // A subagent is "read-only overall" when NONE of its allowed tools can
  // mutate state (no Write/Edit/MultiEdit/Bash/shell_run/NotebookEdit in the
  // whitelist). In that case, any tool in its whitelist auto-allows on `ask`
  // since the whitelist itself is the permission gate — the hardcoded SAFE
  // list would miss custom tools (e.g. MCP read tools, custom Grep variants)
  // that a user-defined read-only agent might declare.
  const isReadOnlySubagent = !allowedNames.some((n: string) => WRITE_TOOLS.has(n));
  const effectiveProviderName: string = input.model || cfg.model || ctx.provider;

  // Subprocess mode: delegate the whole loop to a headless Node child.
  if (input.mode === 'subprocess') {
    try {
      const { runDispatchSubprocess } = require('./subagent-subprocess');
      const res = await runDispatchSubprocess({
        workerId: `dispatch-${subagentType}-${Date.now().toString(36).slice(-6)}`,
        system: subAgentSystem,
        task: input.task,
        tools: allowedNames,
        maxIters: cfg.maxTurns,
        model: effectiveProviderName,
        timeoutMs: cfg.timeoutMs,
      });
      foldSubagentTokens(ctx, subagentType, res.tokens);
      return JSON.stringify({
        subagent_type: subagentType,
        task: input.task,
        summary: res.result || '(no output)',
        tokens: res.tokens,
        mode: 'subprocess',
        model: effectiveProviderName,
        subprocess_session: res.sessionId,
      });
    } catch (err: any) {
      return JSON.stringify({ error: `subprocess dispatch failed: ${err.message || String(err)}` });
    } finally {
      (ctx as any).__subagentDepth = Math.max(0, ((ctx as any).__subagentDepth || 1) - 1);
    }
  }

  const provider = getProvider(effectiveProviderName);
  const subTools = (toolDefinitions as any[]).filter((t: any) => allowedNames.includes(t.name));

  // Session pool: reuse prior conversation when session_id is provided.
  const sessionId: string | undefined = typeof input.session_id === 'string' && input.session_id.trim()
    ? input.session_id.trim()
    : undefined;
  let messages: any[];
  let sessionResumed = false;
  if (sessionId) {
    const { loadSession } = require('./subagent-pool');
    const prior = loadSession(subagentType, sessionId);
    if (prior && prior.length > 0) {
      messages = [...prior, { role: 'user', content: input.task }];
      sessionResumed = true;
    } else {
      messages = [{ role: 'user', content: input.task }];
    }
  } else {
    messages = [{ role: 'user', content: input.task }];
  }
  let finalText = '';
  const subagentTokens = { prompt: 0, completion: 0, total: 0 };
  const MAX_ITERS = cfg.maxTurns;
  const SUBAGENT_TIMEOUT_MS = cfg.timeoutMs;
  const abortCtl = new AbortController();
  const parentAbort: AbortSignal | undefined = (ctx as any).currentAbortController?.signal;
  const onParentAbort = () => abortCtl.abort('parent aborted');
  if (parentAbort) {
    if (parentAbort.aborted) abortCtl.abort('parent aborted');
    else parentAbort.addEventListener('abort', onParentAbort, { once: true });
  }
  const timeoutHandle = setTimeout(() => abortCtl.abort(`subagent timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`), SUBAGENT_TIMEOUT_MS);
  timeoutHandle.unref?.();

  try {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      if (abortCtl.signal.aborted) {
        return JSON.stringify({
          subagent_type: subagentType,
          task: input.task,
          aborted: true,
          reason: String(abortCtl.signal.reason || 'aborted'),
          partialSummary: finalText.trim() || '(no output — aborted before first completion)',
          iterations: iter,
          tokens: subagentTokens,
        });
      }
      // Cache sharing across parallel subagents: when 4 explore agents
      // run in parallel they all carry the same `subAgentSystem` (built
      // from buildSubagentConfig per-type) and the same `subTools`, so
      // Anthropic's cache_control byte-prefix lookup naturally hits
      // across them — no extra plumbing needed. The crucial invariant
      // is that per-task variability lives in `messages` (user content),
      // NOT in `subAgentSystem` or `subTools`. shared_context is glued
      // into the first user message earlier in the dispatcher, which
      // preserves this — keep it that way when refactoring.
      const response = await provider.sendMessage({
        system: subAgentSystem,
        messages,
        tools: subTools,
      });

      const usage = (response as any).usage;
      if (usage) {
        subagentTokens.prompt += usage.promptTokens || 0;
        subagentTokens.completion += usage.completionTokens || 0;
        subagentTokens.total += usage.totalTokens
          || ((usage.promptTokens || 0) + (usage.completionTokens || 0));
        // ALSO roll subagent usage into the parent ctx tagged as 'subagent'
        // — without this the daily token spend invisibly grows because
        // /stats only sees user-turn calls and a parallel fan-out of 4
        // subagents × 20 turns each is completely off the radar.
        try { ctx.addUsage(usage, 'subagent'); } catch (err) { swallow(err); }
      }

      const textBlocks: string[] = [];
      const toolUses: any[] = [];
      for (const block of response.content) {
        if (block.type === 'text' && block.text) textBlocks.push(block.text);
        else if (block.type === 'tool_use') toolUses.push(block);
      }

      if (textBlocks.length > 0) {
        finalText += textBlocks.join('');
        // Live commentary from the subagent — usually its reasoning or a mid-
        // run update. Preview only; full text lands in the final summary.
        dispatchLog(logLabel, preview(textBlocks.join(' ')));
      }

      if (toolUses.length === 0) {
        // Same anti-fabrication suite as handleAIChatStream / handleAIChat.
        // Without this, a coordinator delegating an audit task to a subagent
        // would receive fabricated numbers / skipped tests / phantom shell
        // logs without any guard ever firing — the parent loop only sees the
        // SUMMARY the subagent produces, by which point the lie is baked in.
        const thisText = textBlocks.join('');
        if (thisText) {
          try {
            const { runAntiFabricationGuards } = require('./chat-guards');
            const buildAssistantMsg = (text: string | null) => ({ role: 'assistant', content: text, reasoning_content: '' });
            const fired = await runAntiFabricationGuards({
              ctx,
              accumulatedText: thisText,
              toolUses,
              chatMessages: messages,
              buildAssistantMessage: buildAssistantMsg,
              surfaceInfo: (text: string) => dispatchLog(logLabel, text.slice(0, 160)),
              surfaceWarn: (text: string) => dispatchLog(logLabel, text.slice(0, 160)),
            });
            if (fired) continue;
          } catch (err) { swallow(err); }
        }
        break;
      }

      // Announce the tools this iteration will run. Keep it compact — long
      // arg blobs are cropped so the message list stays skimmable.
      for (const tu of toolUses) {
        const arg = Object.values(tu.input || {}).find((v) => typeof v === 'string') as string | undefined;
        dispatchLog(logLabel, `→ ${tu.name}${arg ? ' ' + preview(arg, 60) : ''}`);
      }

      const toolCalls = toolUses.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
      }));
      messages.push({
        role: 'assistant',
        content: textBlocks.join('') || null,
        tool_calls: toolCalls,
      });

      for (const tool of toolUses) {
        const subInput = { ...(tool.input || {}) };
        if (ctx.activeProject) {
          if (!subInput.projectId) subInput.projectId = ctx.activeProject.id;
          if (!subInput.projectPath && ctx.activeProject.localPath) subInput.projectPath = ctx.activeProject.localPath;
        }

        // ── SAFETY PIPELINE ────────────────────────────────────────────
        //   1. allowedNames filter (hallucinated/disallowed names)
        //   2. safety-classifier for Bash (fail-closed)
        //   3. permission rules (deny/ask → deny inside subagent)
        //   4. PreToolUse hook
        if (!allowedNames.includes(tool.name)) {
          const result = JSON.stringify({ error: `Subagent tool "${tool.name}" not in allowedNames=[${allowedNames.join(',')}]` });
          messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
          continue;
        }
        if (tool.name === 'Bash' || tool.name === 'shell_run') {
          let classifyCommand: any = null;
          try {
            classifyCommand = require('../safety-classifier').classifyCommand;
          } catch (e: any) {
            const result = JSON.stringify({
              error: `Subagent Bash refused: safety classifier unavailable (${e?.message || 'load failed'}). This is a fail-closed guard; restore src/repl/safety-classifier to enable subagent Bash.`,
            });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
            continue;
          }
          if (typeof classifyCommand !== 'function') {
            const result = JSON.stringify({
              error: `Subagent Bash refused: safety classifier malformed (expected function, got ${typeof classifyCommand}).`,
            });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
            continue;
          }
          const classification = classifyCommand(String(subInput.command || ''), { cwd: ctx.activeProject?.localPath || ctx.cwd });
          if (classification.blocked) {
            const result = JSON.stringify({ error: `Subagent Bash blocked by safety classifier: ${classification.reason}` });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
            continue;
          }
          // Subagents have no interactive prompt — `requiresApproval` becomes a
          // hard refusal (the human user is in the parent shell, not here).
          if (classification.requiresApproval) {
            const result = JSON.stringify({ error: `Subagent Bash refused: ${classification.reason} — interactive approval required, but subagents cannot prompt the user. Run this from the parent shell instead.` });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
            continue;
          }
        }
        try {
          const { loadPolicy, evaluateWithMode, extractContextFromToolCall } = require('../permissions');
          const { loadSettings } = require('../settings');
          const policy = loadPolicy(ctx.activeProject?.localPath || ctx.cwd);
          const mode = (loadSettings().permissionMode as any) || 'default';
          const permCtx = extractContextFromToolCall(tool.name, subInput, { cwd: ctx.cwd });
          const action = evaluateWithMode(policy, mode, permCtx);
          try {
            const { recordCtxEvent } = require('../trajectory');
            recordCtxEvent(ctx, 'tool', 'permission_decision', {
              tool: tool.name,
              action,
              mode,
            });
          } catch (err) { swallow(err); }
          if (action === 'deny') {
            const result = JSON.stringify({ error: `Subagent ${tool.name} denied by policy` });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
            continue;
          }
          if (action === 'ask') {
            // Auto-allow when either (a) the tool itself is in the known-safe
            // read-only list, or (b) the whole subagent is read-only by its
            // whitelist (no Write/Edit/Bash etc. declared). Case (b) covers
            // custom agents that declare MCP read tools or any other safe
            // name not hardcoded in SAFE_READ_ONLY_TOOLS — the whitelist IS
            // the permission. Bash/Write/Edit still hit the ask-→-deny below
            // because they take case (a) false + case (b) false.
            const autoAllow = SAFE_READ_ONLY_TOOLS.has(tool.name) || isReadOnlySubagent;
            if (!autoAllow) {
              const result = JSON.stringify({ error: `Subagent ${tool.name} would require user confirmation (not allowed inside subagent — add an allow rule to permissions.json)` });
              messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
              continue;
            }
            // Fall through to PreToolUse hook + executeTool.
          }
        } catch (err) { swallow(err); }
        try {
          const { runHooks } = require('../hooks');
          const hookResult = await runHooks('PreToolUse', {
            toolName: tool.name,
            toolInput: subInput,
            projectPath: ctx.activeProject?.localPath || ctx.cwd,
            currentAbortController: (ctx as any).currentAbortController,
          });
          if (!hookResult.ok && hookResult.blocked) {
            const result = JSON.stringify({ error: `Subagent ${tool.name} blocked by PreToolUse hook: ${hookResult.blocked.reason}` });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: result });
            continue;
          }
        } catch (err) { swallow(err); }

        const subStart = Date.now();
        // Tool proxy: if we're running as a worker spawned by a remote
        // coordinator (server.ts stashed __clusterProxySock on ctx), route
        // filesystem / git / LSP calls back to the origin's ctx. Without
        // this, Read('src/foo.ts') here on the worker machine would fail or
        // return the wrong file — the only FS with the real code is the
        // coordinator's. web_search/web_fetch stay local.
        const proxySock = (ctx as any).__clusterProxySock;
        let result: string;
        if (proxySock) {
          const { shouldProxyToOrigin } = require('../cluster/tool-proxy-policy');
          if (shouldProxyToOrigin(tool.name)) {
            try {
              const { sendToolCallToOrigin } = require('../cluster/proxy-tool-call');
              result = await sendToolCallToOrigin(proxySock, tool.name, subInput);
            } catch (err: any) {
              result = JSON.stringify({ error: `proxy tool-call failed: ${err?.message || err}` });
            }
          } else {
            result = await executeTool(tool.name, subInput, ctx);
          }
        } else {
          result = await executeTool(tool.name, subInput, ctx);
        }
        const subDurationMs = Date.now() - subStart;
        let subOk = true;
        try {
          const parsed = JSON.parse(result);
          if (parsed && typeof parsed === 'object' && 'error' in parsed) subOk = false;
        } catch (err) { swallow(err); }
        try {
          require('../../utils/events').recordEvent('tool_call', {
            tool: tool.name,
            durationMs: subDurationMs,
            ok: subOk,
            source: 'subagent',
            subagent_type: subagentType,
          });
        } catch (err) { swallow(err); }
        messages.push({
          role: 'tool',
          tool_call_id: tool.id,
          content: truncate(result, 100_000),
        });
      }
    }

    foldSubagentTokens(ctx, subagentType, subagentTokens);
    if (sessionId) {
      try {
        const { saveSession } = require('./subagent-pool');
        const finalMessages = [...messages];
        if (finalText.trim()) {
          finalMessages.push({ role: 'assistant', content: finalText });
        }
        saveSession(subagentType, sessionId, finalMessages, {
          tokens: subagentTokens.total,
          description: typeof input.describe === 'string' ? input.describe : undefined,
        });
      } catch (err) { swallow(err); }
    }
    if (soloDispatch) {
      const tokK = subagentTokens.total > 0 ? `, ${(subagentTokens.total / 1000).toFixed(1)}k tok` : '';
      dispatchLog(logLabel, `done${tokK}`);
    }
    recordSubagentSuccess();
    return JSON.stringify({
      subagent_type: subagentType,
      task: input.task,
      summary: finalText.trim() || '(no output — agent exhausted iterations)',
      iterations: Math.min(messages.filter((m) => m.role === 'assistant').length, MAX_ITERS),
      tokens: subagentTokens,
      session_id: sessionId || null,
      session_resumed: sessionResumed,
      model: effectiveProviderName,
    });
  } catch (err: any) {
    // Don't retry 4xx — those are deterministic failures (bad request,
    // auth, schema mismatch). Retrying just burns 30s and tokens. Mark
    // them with a flag so the model can read it and stop trying.
    const status = err?.response?.status ?? err?.status;
    const is4xx = typeof status === 'number' && status >= 400 && status < 500;
    recordSubagentFailure(is4xx ? '4xx' : 'other');
    return JSON.stringify({
      error: err.message?.substring(0, 200) || 'subagent failed',
      status: status ?? null,
      retryable: !is4xx,
      hint: is4xx
        ? 'Backend rejected the request (4xx). Do NOT retry — fix the inputs or the underlying issue.'
        : undefined,
    });
  } finally {
    (ctx as any).__subagentDepth = Math.max(0, ((ctx as any).__subagentDepth || 1) - 1);
    try { clearTimeout(timeoutHandle); } catch (err) { swallow(err); }
    if (parentAbort) {
      try { parentAbort.removeEventListener('abort', onParentAbort); } catch (err) { swallow(err); }
    }
    try {
      const { runHooks: rh } = require('../hooks');
      rh('SubagentStop', { projectPath: ctx.activeProject?.localPath || ctx.cwd, toolName: 'dispatch_agent', toolInput: input }).catch(() => {});
    } catch (err) { swallow(err); }
    // Worktree cleanup — only run when we created one. Default is
    // `discard` (drop branch + worktree); `keepWorktree:true` survives
    // for manual inspection.
    if (worktreeHandle) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { removeSubagentWorktree } = require('./subagent-worktree');
        removeSubagentWorktree(worktreeHandle, worktreeKept);
      } catch (err: any) {
        process.stderr.write(`[subagent-dispatch] worktree cleanup failed: ${err?.message}\n`);
      }
    }
  }
}
