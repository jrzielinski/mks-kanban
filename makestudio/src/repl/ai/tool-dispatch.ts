import { ReplContext } from '../context';
import { buildDenialCorrection, buildThrownToolCorrection } from './tool-corrections';
import { toolFailed } from './chat-utils';
import { executeTool } from './tools';

import { swallow } from '../../utils/log';
export interface StreamingDispatchArgs {
  tool: any;
  ctx: ReplContext;
  chatMessages: any[];
  bridge: { addMessage: (m: any) => any; updateMessage: (id: string, patch: any) => void };
}

export type DispatchOutcome = 'ok' | 'circuit_breaker';

const MAX_CONSECUTIVE_TOOL_FAILURES = 5;
const INTERACTIVE_DENIAL_THRESHOLD = 3;

/**
 * Dispatch a single streaming-path tool_use:
 *   1. Pre-flight param validation (cheap shape check)
 *   2. Safety classifier (Bash blocking)
 *   3. Permission policy (deny / ask) + denial tracking + interactive prompt
 *   4. PreToolUse hook
 *   5. Tool execute (or denial-correction injection)
 *   6. Circuit-breaker counter
 *   7. PostToolUse hook
 *   8. Post-edit compile-gate
 *   9. Bridge update + tool_result push
 *
 * Returns 'circuit_breaker' to instruct the caller to return from the
 * outer turn loop. Otherwise 'ok' — the caller continues to the next
 * tool_use in the batch.
 */
export async function dispatchStreamingTool(args: StreamingDispatchArgs): Promise<DispatchOutcome> {
  const { tool, ctx, chatMessages, bridge } = args;

  const toolInput = { ...(tool.input || {}) };
  if (ctx.activeProject) {
    if (!toolInput.projectId) toolInput.projectId = ctx.activeProject.id;
    if (!toolInput.projectPath && ctx.activeProject.localPath) toolInput.projectPath = ctx.activeProject.localPath;
  }

  // Pre-flight param validation — catches obviously wrong args before the
  // permission prompt so the model gets immediate corrective feedback.
  {
    let preflightError: string | null = null;
    if (tool.name === 'Read' || tool.name === 'read_file') {
      const off = toolInput.offset;
      if (off != null && (typeof off !== 'number' || off < 0)) {
        preflightError = `Read: \`offset\` must be a positive integer (1-indexed line to start from). Got ${off}. To read the last N lines use Bash: tail -n N ${toolInput.file_path || ''}`;
      }
      const lim = toolInput.limit;
      if (!preflightError && lim != null && (typeof lim !== 'number' || lim < 1)) {
        preflightError = `Read: \`limit\` must be a positive integer. Got ${lim}.`;
      }
    }
    if (preflightError) {
      chatMessages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ error: preflightError }) });
      return 'ok';
    }
  }

  // Safety classifier — runs BEFORE autoApprove can bypass anything.
  // Blocks catastrophic Bash commands regardless of user configuration.
  // Risky-but-legitimate commands (interpreter inline-code via
  // `requiresApproval`) are NOT force-prompted — bypass/autoApprove
  // mode means the user has explicitly opted out of permission gates,
  // and we honour that just like Claude Code does.
  let allowed = true;
  if (tool.name === 'Bash') {
    const { classifyCommand } = require('../safety-classifier');
    const v = classifyCommand(String(toolInput.command || ''), { cwd: ctx.activeProject?.localPath || ctx.cwd });
    if (v.blocked) {
      bridge.addMessage({ role: 'error', text: `[safety-classifier] ${tool.name} blocked: ${v.reason}` });
      allowed = false;
    }
  }

  try { require('../debug-log').dbgInfo('dispatch_pre_perm', { tool: tool.name, autoApprove: ctx.autoApprove, approved: ctx.approvedTools.has(tool.name) }); } catch (err) { swallow(err); }
  // Permission check (only runs if classifier didn't already block,
  // and only when bypass is OFF).
  if (allowed && !ctx.autoApprove && !ctx.approvedTools.has(tool.name)) {
    const { loadPolicy, evaluateWithMode, extractContextFromToolCall } = require('../permissions');
    const { loadSettings } = require('../settings');
    const policy = loadPolicy(ctx.activeProject?.localPath || ctx.cwd);
    const permCtx = extractContextFromToolCall(tool.name, toolInput, { cwd: ctx.cwd });
    const mode = loadSettings().permissionMode || 'default';
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
      // Even a 'deny' can be overridden by a plan-approved allowedPrompt
      // match — the user explicitly authorised that category.
      if (tool.name === 'Bash') {
        const { getAllowedBashPrompts, matchAllowedBashPrompt } = require('./advanced-tools');
        const matched = matchAllowedBashPrompt(String(toolInput.command || ''), getAllowedBashPrompts(ctx));
        if (matched) {
          bridge.addMessage({ role: 'info', text: `[plan-auto-approved] Bash matched allowedPrompt: "${matched.prompt}"` });
        } else {
          allowed = false;
        }
      } else {
        allowed = false;
      }
    } else if (action === 'ask') {
      // Interactive approval (Fase 3.1). Renders the PermissionPrompt
      // Ink component via bridge, gets y/s/r/n back, and acts:
      //   allow         → one-shot, don't cache
      //   allow-session → add to ctx.approvedTools (in-memory)
      //   allow-rule    → write a permission rule to disk, then allow
      //   deny/null     → reject (LLM gets error in the tool result)
      // PermissionRequest observational hook — lets a hook peek at any
      // tool that's about to be prompted and optionally veto via exit-2.
      try {
        const { runHooks } = require('../hooks');
        const prePerm = await runHooks('PermissionRequest', {
          projectPath: ctx.cwd, toolName: tool.name, toolInput,
          currentAbortController: ctx.currentAbortController,
        });
        if (prePerm.blocked) {
          const msg = `${tool.name} blocked by PermissionRequest hook: ${prePerm.blocked.reason}`;
          const result = JSON.stringify({ error: msg });
          chatMessages.push({ role: 'tool', tool_call_id: tool.id, content: result });
          try { runHooks('PermissionDenied', { projectPath: ctx.cwd, toolName: tool.name, toolInput, currentAbortController: ctx.currentAbortController }).catch(() => {}); } catch (err) { swallow(err); }
          return 'ok';
        }
      } catch (err) { swallow(err); }
      // Denial tracking (port of Claude Code denialTracking.ts).
      // After INTERACTIVE_DENIAL_THRESHOLD consecutive denials for the same
      // tool, skip the prompt and auto-deny — the user clearly doesn't want
      // this tool and re-asking is noise.
      const priorDenials = ctx.interactiveDenials?.get(tool.name) ?? 0;
      if (priorDenials >= INTERACTIVE_DENIAL_THRESHOLD) {
        allowed = false;
        bridge.addMessage({
          role: 'info',
          text: `[auto-denied] ${tool.name} — denied ${priorDenials}x this session. Use /trust on or add a permission rule to re-enable.`,
        });
      } else {
        try {
          const { showPermissionPrompt } = require('../tui/bridge');
          const { buildPermissionPreview } = require('./permission-preview');
          const preview = buildPermissionPreview(tool.name, toolInput);
          try { require('../debug-log').dbgInfo('dispatch_pre_showperm', { tool: tool.name }); } catch (err) { swallow(err); }
          const choice = await showPermissionPrompt({
            toolName: tool.name,
            toolInput,
            reason: 'requires permission',
            preview: preview.summary,
            diff: preview.diff,
            warning: preview.warning,
          });
          try { require('../debug-log').dbgInfo('dispatch_post_showperm', { tool: tool.name, choice: String(choice) }); } catch (err) { swallow(err); }
          if (choice === 'allow') {
            // one-shot — reset denial counter on explicit allow
            ctx.interactiveDenials?.delete(tool.name);
          } else if (choice === 'allow-session') {
            ctx.approvedTools.add(tool.name);
            ctx.interactiveDenials?.delete(tool.name);
          } else if (choice === 'allow-rule') {
            try {
              const { persistAllowRule } = require('./permission-preview');
              persistAllowRule(tool.name, toolInput, ctx);
              // Also approve for the rest of this session so the same call
              // doesn't prompt again before the next policy reload.
              ctx.approvedTools.add(tool.name);
              ctx.interactiveDenials?.delete(tool.name);
            } catch (err: any) {
              bridge.addMessage({ role: 'warn', text: `Couldn't persist rule: ${err.message}` });
            }
          } else {
            allowed = false; // deny or Esc
            // Increment denial counter for this tool
            ctx.interactiveDenials?.set(tool.name, priorDenials + 1);
            try {
              require('../hooks').runHooks('PermissionDenied', {
                projectPath: ctx.cwd, toolName: tool.name, toolInput,
                currentAbortController: ctx.currentAbortController,
              }).catch(() => {});
            } catch (err) { swallow(err); }
          }
        } catch {
          // Bridge not available — fall back to auto-allow so the CLI
          // doesn't freeze out-of-TUI callers.
        }
      }
    }
  }

  // PreToolUse hook — external policy can block via exit code 2.
  let preHookBlocked: string | null = null;
  try {
    const { runHooks } = require('../hooks');
    const pre = await runHooks('PreToolUse', {
      projectPath: ctx.cwd,
      toolName: tool.name,
      toolInput,
      currentAbortController: ctx.currentAbortController,
    });
    if (pre.blocked) preHookBlocked = pre.blocked.reason;
    else if (pre.failures.length > 0) {
      const { tuiLog } = require('../tui/bridge');
      for (const f of pre.failures) tuiLog(f, 'warn');
    }
  } catch (err) { swallow(err); }

  const toolStart = Date.now();
  let result: string = '';
  let preEditMsgId: string | null = null;
  if (preHookBlocked) {
    try { require('../tui/bridge').setCurrentTool(null); } catch (err) { swallow(err); }
    // Port of Claude Code's withMemoryCorrectionHint — when we know WHY
    // something was blocked, append actionable guidance to the error so
    // the model can retry correctly without re-asking the user.
    result = JSON.stringify({
      error: `Blocked by PreToolUse hook: ${preHookBlocked}`,
      correction: `A policy hook rejected this call. Do NOT retry the same call. Either use a different approach, or ask the user (AskUserQuestion tool) to change the policy. Continue the task without the blocked operation.`,
    });
  } else {
    try {
      const dbg = require('../debug-log');
      dbg.dbgToolCall(tool.name, toolInput);
    } catch (err) { swallow(err); }

    // For file-mutation tools, emit a visible notice BEFORE executing so
    // the user always sees what's about to change — even when the tool
    // was session-approved (bypassing the interactive permission prompt).
    // Emit pre-execution notice for file-mutation tools; save ID to PATCH
    // with output after execution (avoids duplicate message).
    if (allowed && ['Edit', 'Write', 'MultiEdit'].includes(tool.name)) {
      const { tuiToolCall } = require('../tui/bridge');
      preEditMsgId = tuiToolCall(tool.name, toolInput);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Update status-line tool indicator (shown even in non-verbose mode).
    try {
      const { setCurrentTool } = require('../tui/bridge');
      const shortArg = (() => {
        if (toolInput.command) return String(toolInput.command).slice(0, 30);
        if (toolInput.file_path || toolInput.filePath) return (toolInput.file_path || toolInput.filePath).split('/').pop();
        if (toolInput.pattern) return String(toolInput.pattern).slice(0, 20);
        return '';
      })();
      setCurrentTool(shortArg ? `${tool.name}(${shortArg})` : tool.name);
    } catch (err) { swallow(err); }
    try {
      // Pre-execution dedup for read-shaped tools: if the same Read /
      // Glob / Grep was issued earlier this turn with identical args
      // (and, for Read, identical mtime), reject with a pointer to the
      // earlier message instead of running it again. The model has
      // been ignoring FILE_UNCHANGED warnings; this turns the warning
      // into a hard error so it stops re-fetching the same data.
      let dedupHit = false;
      if (allowed) {
        try {
          const { checkDuplicate } = require('./tool-dedup');
          const dup = checkDuplicate(ctx, tool.name, toolInput);
          if (dup.duplicate) {
            try { require('../../utils/events').recordEvent('tool_dedup_block', { tool: tool.name }); } catch (err) { swallow(err); }
            result = JSON.stringify({ error: dup.reason });
            dedupHit = true;
          }
        } catch (err) { swallow(err); }
      }

      if (allowed && !dedupHit) {
        // OTel span — wraps the actual tool invocation. Off by default;
        // activated via settings.otelEnabled or env MAKESTUDIO_OTEL=1.
        // Cheap when off (single function-call passthrough).
        const spanAttrs: Record<string, string | number | boolean> = {
          'tool.name': tool.name,
          'tool.kind': tool.name.includes('.') ? 'mcp' : 'builtin',
        };
        if (toolInput?.file_path) spanAttrs['tool.file_path'] = String(toolInput.file_path).slice(0, 200);
        if (toolInput?.command) spanAttrs['tool.command'] = String(toolInput.command).slice(0, 200);
        if (toolInput?.pattern) spanAttrs['tool.pattern'] = String(toolInput.pattern).slice(0, 100);

        // Parallel prefetch path — when chat.ts ran a parallel
        // prefetch over read-only tools earlier in the turn, the
        // result is sitting in ctx.__prefetchCache keyed by tool.id.
        // Use it directly instead of re-executing. This trades the
        // sequential I/O wait for one Promise.all back in chat.ts.
        // Errors are cached too, re-thrown here so the same error
        // path runs (hook denial-correction, etc.).
        let prefetched: any = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { consumePrefetched } = require('./parallel-prefetch');
          prefetched = consumePrefetched(ctx, tool.id);
        } catch (err) { swallow(err); }

        // Resolve withSpan with a passthrough fallback so the tool runs
        // EXACTLY once even when OTel is missing/disabled.
        let withSpanFn: (n: string, o: any, fn: () => Promise<any>) => Promise<any>;
        try {
          withSpanFn = require('../telemetry/otel-tracer').withSpan;
        } catch {
          withSpanFn = async (_n, _o, fn) => fn();
        }
        result = await withSpanFn(`tool.${tool.name}`, { attrs: spanAttrs, kind: 1 }, async () => {
          if (prefetched) {
            if (prefetched.error) throw prefetched.error;
            return prefetched.result;
          }
          return tool.name.includes('.')
            ? await (require('../mcp').callMcpTool)(tool.name, toolInput)
            : await executeTool(tool.name, toolInput, ctx);
        });
        // Record successful execution so the next identical call this
        // turn can be deduplicated.
        try {
          const { recordToolCall } = require('./tool-dedup');
          recordToolCall(ctx, tool.name, toolInput, chatMessages.length);
        } catch (err) { swallow(err); }
      } else if (!allowed) {
        try { require('../../utils/events').recordEvent('denial', { tool: tool.name, reason: 'policy' }); } catch (err) { swallow(err); }
        // Build a targeted correction based on the tool. The model keeps
        // calling the same tool with minor variations otherwise (we saw
        // this in logs). Explicit "do X instead" guidance cuts that.
        const correction = buildDenialCorrection(tool.name, toolInput);
        result = JSON.stringify({
          error: `Tool ${tool.name} denied by policy`,
          correction,
        });
      }
    } catch (e: any) {
      // Tool threw — surface the raw error + pattern-match common
      // failures to inject focused guidance.
      const errMsg = e?.message || String(e);
      const correction = buildThrownToolCorrection(tool.name, errMsg);
      result = JSON.stringify({ error: errMsg, ...(correction ? { correction } : {}) });
    }
  }
  try { require('../tui/bridge').setCurrentTool(null); } catch (err) { swallow(err); }
  const durationMs = Date.now() - toolStart;
  try {
    const dbg = require('../debug-log');
    dbg.dbgToolResult(tool.name, typeof result === 'string' ? result : JSON.stringify(result), durationMs);
    // Memory snapshot after every tool call. Cheap (process.memoryUsage()
    // + a few Map.size reads). Auto-snapshot fires a v8 heap dump the
    // first time RSS crosses 4GB / 8GB / 12GB so the leak's growth can
    // be diff'd between thresholds.
    const seq = (ctx as any).__toolCallSeq = ((ctx as any).__toolCallSeq || 0) + 1;
    dbg.dbgMemSnapshot({ ctx, trigger: `tool_end:${tool.name}`, seq });
    dbg.dbgMaybeAutoSnapshot({ ctx, seq });
  } catch (err) { swallow(err); }
  const okThisCall = !toolFailed(result);
  ctx.recordToolCall(okThisCall, durationMs);
  // Circuit breaker — if tool calls keep failing consecutively, stop
  // the turn before the model burns the context on a runaway. Claude
  // Code has no equivalent; our /stats logs showed models doing 10+
  // identical retries when a tool's schema was wrong. 5 in a row is
  // almost always "the model is stuck", not "the user needs more work".
  const prevFailures = (ctx as any).__consecutiveToolFailures || 0;
  (ctx as any).__consecutiveToolFailures = okThisCall ? 0 : prevFailures + 1;
  if ((ctx as any).__consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
    try { require('../../utils/events').recordEvent('tool_circuit_breaker', { tool: tool.name, consecutive: (ctx as any).__consecutiveToolFailures }); } catch (err) { swallow(err); }
    // SAME ORDERING CONSTRAINT as the zero-result breaker below: we
    // can't bail mid-batch without leaving an assistant.tool_calls[]
    // message with no matching tool_result for the remaining ids.
    // Defer the break to chat.ts, after the current tool_result has
    // been pushed and after the rest of the batch (if any) is
    // dispatched. The batch's remaining tools execute as normal —
    // costs at most a few extra calls but keeps the protocol intact.
    (ctx as any).__pendingHardStop = {
      kind: 'consecutive_failures',
      message: '',
      bridgeText: `Circuit breaker: ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive tool failures. Last was ${tool.name}. Stopping after this batch — check the tool errors above and either rephrase the request or fix the underlying issue.`,
    };
    (ctx as any).__consecutiveToolFailures = 0;
  }

  // Zero-result breaker — separate from the failure breaker. Search
  // tools (Read/Glob/Grep/WebFetch/lsp_*) returning empty results
  // back-to-back signal a fishing expedition. Counter resets on any
  // productive result so legitimate refinement loops survive.
  //
  // CRITICAL ORDERING NOTE: we MUST NOT push a `user` message into
  // chatMessages here, and we MUST NOT return 'circuit_breaker'
  // before pushing this tool's tool_result. Both would break the
  // OpenAI/DeepSeek protocol contract: every tool_call_id from the
  // assistant message must be followed by a contiguous tool message,
  // with NO other roles interleaved. Instead, we stash the hint /
  // hardStop signal on the ctx and let chat.ts surface them AFTER
  // the whole batch of tool_results is in place.
  try {
    const { noteToolOutcome, buildHardStopMessage } = require('./zero-result-breaker');
    const outcome = noteToolOutcome(ctx, tool.name, result, okThisCall);
    if (outcome.softHint) {
      (ctx as any).__pendingSoftHint = outcome.softHint;
    }
    if (outcome.hardStop) {
      try { require('../../utils/events').recordEvent('zero_result_breaker', { tool: tool.name, streak: outcome.streak }); } catch (err) { swallow(err); }
      (ctx as any).__pendingHardStop = {
        kind: 'zero_result',
        message: buildHardStopMessage(outcome.streak),
        bridgeText: `Zero-result breaker: ${outcome.streak} consecutive search tools returned nothing useful. Stopping after this batch — reply with what you couldn't find or ask for clarification.`,
      };
      (ctx as any).__zeroResultStreak = 0;
      (ctx as any).__zeroResultSoftFired = false;
    }
  } catch (err) { swallow(err); }

  // Diagnostic-vs-progress streak — fires a soft reminder when the
  // model has run 5+ diagnostic tools (Read/Grep/find) without a
  // single progress tool (Edit/Write/build). Stashed on
  // __pendingSoftHint so it lands AFTER all tool_results in this
  // batch (same protocol guard as zero-result-breaker).
  try {
    const { noteToolForStreak } = require('./diagnostic-streak');
    const so = noteToolForStreak(ctx, tool.name, toolInput);
    if (so.softHint && !(ctx as any).__pendingSoftHint) {
      (ctx as any).__pendingSoftHint = so.softHint;
    }
  } catch (err) { swallow(err); }

  try {
    (ctx as any).__turnToolCount = ((ctx as any).__turnToolCount || 0) + 1;
    require('../../utils/events').recordEvent('tool_call', {
      tool: tool.name, durationMs, ok: okThisCall,
      blocked: !!preHookBlocked,
      // Aggregate-by-turn metadata so /stats can highlight which prompts
      // caused tool fanout. Sequence resets per-process, prompt is the
      // first 80 chars of the user input that started this turn.
      turnSeq: (ctx as any).__turnSeq || 0,
      turnPrompt: (ctx as any).__turnPromptSnippet || '',
    });
  } catch (err) { swallow(err); }

  try { require('../debug-log').dbgInfo('dispatch_pre_posthook', { tool: tool.name }); } catch (err) { swallow(err); }
  // PostToolUse hook — runs even when the tool was blocked (so telemetry
  // /log hooks can record the attempt). Filter via `if` if you only want
  // success cases. If the PostToolUse path itself errors OR one of the
  // registered handlers reports a failure, the PostToolUseFailure event
  // fires so plugins can surface/retry without racing the main loop.
  try {
    const { runHooks } = require('../hooks');
    const post = await runHooks('PostToolUse', {
      projectPath: ctx.cwd,
      toolName: tool.name,
      toolInput,
      currentAbortController: ctx.currentAbortController,
    });
    if (post.failures.length > 0) {
      const { tuiLog } = require('../tui/bridge');
      for (const f of post.failures) tuiLog(f, 'warn');
      runHooks('PostToolUseFailure', {
        projectPath: ctx.cwd,
        toolName: tool.name,
        toolInput,
        failures: post.failures,
        currentAbortController: ctx.currentAbortController,
      } as any).catch(() => { /* observational */ });
    }
  } catch (err: any) {
    try {
      require('../hooks').runHooks('PostToolUseFailure', {
        projectPath: ctx.cwd,
        toolName: tool.name,
        toolInput,
        error: err?.message || String(err),
        currentAbortController: ctx.currentAbortController,
      }).catch(() => {});
    } catch (err) { swallow(err); }
  }

  // Post-edit compile-gate: after a successful Edit/Write/MultiEdit,
  // syntax-check the file and append the error to the tool result. The
  // model sees both the diff AND the breakage in the same turn, so it
  // can fix instead of claiming success and moving on. Mirrors Claude
  // Code's PostToolUse hook (hooksConfigManager.ts:38-46).
  if (['Edit', 'Write', 'MultiEdit'].includes(tool.name) && !toolFailed(result)) {
    try {
      const { runPostEditCheck, trackEdit } = require('./post-edit-hooks');
      if (toolInput?.file_path) trackEdit(ctx, toolInput.file_path);
      const check = runPostEditCheck(tool.name, toolInput, ctx);
      if (!check.ok && check.message) {
        result += `\n\n[compile-check] ✗ ${check.message}\n` +
          `Your edit introduced a syntax/type error. Read the file and fix it before moving on.`;
      }
    } catch (err) { swallow(err); }
  }

  try { require('../debug-log').dbgInfo('dispatch_post_posthook', { tool: tool.name }); } catch (err) { swallow(err); }
  ctx.lastToolCall = {
    name: tool.name,
    input: toolInput,
    output: result,
    durationMs,
    timestamp: new Date().toISOString(),
  };
  ctx.toolCallHistory.push({
    name: tool.name,
    input: toolInput,
    output: result,
    durationMs,
    timestamp: ctx.lastToolCall.timestamp,
    ok: okThisCall,
  });
  if (ctx.toolCallHistory.length > 500) {
    ctx.toolCallHistory.splice(0, ctx.toolCallHistory.length - 500);
  }
  // Disk persistence — opt-in. Writes a JSONL line for every tool call
  // so long sessions can replay full history even after the in-memory
  // cap of 500 has rotated.
  try {
    const { persistToolCall } = require('./tool-result-persist');
    persistToolCall(ctx, tool.name, toolInput, result, okThisCall, durationMs);
  } catch (err) { swallow(err); }
  try { require('../debug-log').dbgInfo('dispatch_pre_addmessage', { tool: tool.name, resultLen: typeof result === 'string' ? result.length : -1 }); } catch (err) { swallow(err); }

  if (preEditMsgId) {
    // Patch the pre-execution placeholder with output + duration.
    bridge.updateMessage(preEditMsgId, { toolOutput: result, toolDurationMs: durationMs });
  } else if (tool.name === 'Bash' || tool.name === 'shell_run') {
    // Bash / shell_run manage their own TUI card lifecycle inside
    // file-tools.ts: tuiStartStreamingTool creates the live card on start,
    // tuiUpdateMessage finalises it (streaming:false + toolDurationMs) on
    // exit. Adding another addMessage here would produce a duplicate card
    // with the same command but a different duration — exactly the
    // "bash shown twice" bug from 2026-04-23. Skip.
  } else {
    bridge.addMessage({
      role: 'tool',
      text: '',
      toolName: tool.name,
      toolInput,
      toolOutput: result,
      toolDurationMs: durationMs,
    });
  }
  try { require('../debug-log').dbgInfo('dispatch_post_addmessage', { tool: tool.name }); } catch (err) { swallow(err); }
  // Yield so Ink flushes the ⎿ line before the next tool starts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  try { require('../debug-log').dbgInfo('dispatch_post_yield', { tool: tool.name }); } catch (err) { swallow(err); }

  // PII redaction — opt-in (off by default). Only the *chat-bound* copy
  // gets redacted; the local TUI / lastToolCall / toolCallHistory keep
  // raw data so the user still sees what actually happened. The model
  // sees the redacted view, so it never reasons over (and never
  // accidentally re-emits) bearer tokens, credit cards, etc.
  let chatBound = require('./tool-limits').clipToolResult(result);
  try {
    const { redactString, getPiiMode } = require('./pii-redactor');
    if (getPiiMode() !== 'off') {
      chatBound = redactString(chatBound);
    }
  } catch (err) { swallow(err); }
  chatMessages.push({
    role: 'tool',
    tool_call_id: tool.id,
    content: chatBound,
  });
  try { require('../debug-log').dbgInfo('dispatch_done', { tool: tool.name, chatBoundLen: chatBound.length }); } catch (err) { swallow(err); }
  return 'ok';
}
