import chalk from 'chalk';
import { ReplContext } from '../context';
import { toolFailed } from './chat-utils';
import { executeTool } from './tools';

import { swallow } from '../../utils/log';
const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const blue = chalk.hex('#60A5FA');
const red = chalk.hex('#EF4444');

export interface CliDispatchArgs {
  tool: any;
  ctx: ReplContext;
  chatMessages: any[];
}

/**
 * Non-streaming (CLI) tool dispatch. Same shape as the streaming
 * variant but uses console.log for UI feedback instead of the TUI
 * bridge. Used by handleAIChat (no Ink available).
 */
export async function dispatchCliTool(args: CliDispatchArgs): Promise<void> {
  const { tool, ctx, chatMessages } = args;
  const input = { ...(tool.input || {}) };

  // Auto-inject context that the tool needs
  if (ctx.activeProject) {
    if (input.projectId === undefined || input.projectId === null || input.projectId === '') {
      input.projectId = ctx.activeProject.id;
    }
    if (input.projectPath === undefined && ctx.activeProject.localPath) {
      input.projectPath = ctx.activeProject.localPath;
    }
  }

  // Relativize cwd-prefixed paths so the tool line reads
  // `file_path=app/lib/services/auth_service.dart` instead of the
  // full absolute path 80-char screen-wrecker. Matches Claude Code's
  // compact tool header style.
  const cwd = ctx.cwd || process.cwd();
  const relPath = (abs: string): string => {
    if (typeof abs !== 'string') return abs;
    if (!abs.startsWith('/')) return abs;
    const prefix = cwd.endsWith('/') ? cwd : cwd + '/';
    if (abs === cwd) return '.';
    if (abs.startsWith(prefix)) return abs.slice(prefix.length);
    return abs;
  };
  const rawKeys = Object.keys(tool.input || {});
  const fmtVal = (v: any, key?: string): string => {
    if (v === undefined || v === null || v === '') return '<empty>';
    if (typeof v === 'string') {
      if (key && /path|file|dir/i.test(key)) {
        const rel = relPath(v);
        return rel.length > 60 ? '...' + rel.slice(-57) : rel;
      }
      return v.length > 40 ? v.slice(0, 40) + '...' : v;
    }
    if (Array.isArray(v)) {
      const s = JSON.stringify(v);
      return s.length > 50 ? s.slice(0, 50) + '...]' : s;
    }
    if (typeof v === 'object') {
      const s = JSON.stringify(v);
      return s.length > 50 ? s.slice(0, 50) + '...}' : s;
    }
    return String(v);
  };
  const rawSummary = rawKeys.length > 0
    ? rawKeys.map((k) => `${k}=${fmtVal((tool.input as any)[k], k)}`).join(', ')
    : '<no args>';
  console.log(`  ${dim('[')}${cyan('tool')}${dim(']')} ${blue(tool.name)} ${dim(`(${rawSummary})`)}`);

  // Safety classifier — runs BEFORE autoApprove.
  if (tool.name === 'Bash') {
    const { classifyCommand } = require('../safety-classifier');
    const verdict = classifyCommand(String(input.command || ''), { cwd: ctx.activeProject?.localPath || ctx.cwd });
    if (verdict.blocked) {
      const toolStart = Date.now();
      const result = JSON.stringify({ error: `Tool ${tool.name} blocked by safety classifier: ${verdict.reason}` });
      ctx.lastToolCall = { name: tool.name, input, output: result, durationMs: Date.now() - toolStart, timestamp: new Date().toISOString() };
      ctx.toolCallHistory.push({ name: tool.name, input, output: result, durationMs: Date.now() - toolStart, timestamp: ctx.lastToolCall.timestamp, ok: false });
      chatMessages.push({ role: 'tool', tool_call_id: tool.id, content: result });
      console.log(`  ${red('✗')} ${tool.name} ${dim('blocked by safety-classifier: ' + verdict.reason)}`);
      return;
    }
  }

  // Permission check — rule-based, with auto-approve override.
  // Uses evaluateWithMode so plan/acceptEdits/bypassPermissions/dontAsk
  // modes apply in this non-streaming path as well (stress test #7).
  if (!ctx.autoApprove && !ctx.approvedTools.has(tool.name)) {
    const { loadPolicy, evaluateWithMode, extractContextFromToolCall } = require('../permissions');
    const { loadSettings } = require('../settings');
    const policy = loadPolicy(ctx.activeProject?.localPath || ctx.cwd);
    const permCtx = extractContextFromToolCall(tool.name, input, { cwd: ctx.cwd });
    const mode = (loadSettings().permissionMode as any) || 'default';
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
      const toolStart = Date.now();
      const result = JSON.stringify({ error: `Tool ${tool.name} denied by policy`, ctx: permCtx });
      ctx.lastToolCall = { name: tool.name, input, output: result, durationMs: Date.now() - toolStart, timestamp: new Date().toISOString() };
      ctx.toolCallHistory.push({ name: tool.name, input, output: result, durationMs: Date.now() - toolStart, timestamp: ctx.lastToolCall.timestamp, ok: false });
      chatMessages.push({ role: 'tool', tool_call_id: tool.id, content: result });
      console.log(`  ${red('✗')} ${tool.name} bloqueado pela policy`);
      return;
    }

    if (action === 'ask') {
      // Plan-mode bypass: Bash commands that semantically match an
      // allowedPrompt approved via ExitPlanMode skip the dialog.
      let ans: string;
      let planMatched: any = null;
      if (tool.name === 'Bash') {
        const { getAllowedBashPrompts, matchAllowedBashPrompt } = require('./advanced-tools');
        planMatched = matchAllowedBashPrompt(String(input.command || ''), getAllowedBashPrompts(ctx));
      }
      if (planMatched) {
        console.log(`  ${green('✓')} ${tool.name} ${dim(`auto-approved via plan allowedPrompt: "${planMatched.prompt}"`)}`);
        ans = 's';
      } else if (process.env.MAKESTUDIO_HEADLESS === '1') {
        // In headless mode there's no TTY to read the answer from.
        // Silently denying traps the model in a retry loop; instead,
        // write the prompt to stderr so the user sees what would have
        // been asked, then auto-deny. User re-runs with --yes or with
        // a narrower permissions.json to fix.
        const detail = permCtx.command || permCtx.path || permCtx.url || '';
        process.stderr.write(
          `[headless] ${tool.name} denied — policy=ask, no TTY to prompt.\n` +
          `           target: ${detail}\n` +
          `           re-run with --yes to auto-approve, or add an allow rule in permissions.json.\n`,
        );
        ans = 'n';
      } else {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const detail = permCtx.command || permCtx.path || permCtx.url || '';
        ans = await new Promise<string>((resolve) =>
          rl.question(`  ${yellow('⚠')} IA quer ${cyan(tool.name)}${detail ? dim(` (${detail})`) : ''}. Permitir? [s/N/a=sempre] `, (a: string) => { rl.close(); resolve(a.trim().toLowerCase()); }),
        );
      }
      if (ans === 'a' || ans === 'always') {
        ctx.approvedTools.add(tool.name);
      } else if (ans !== 's' && ans !== 'y' && ans !== 'sim' && ans !== 'yes') {
        const toolStart = Date.now();
        const result = JSON.stringify({ error: 'User denied tool execution', tool: tool.name });
        ctx.lastToolCall = { name: tool.name, input, output: result, durationMs: Date.now() - toolStart, timestamp: new Date().toISOString() };
        ctx.toolCallHistory.push({ name: tool.name, input, output: result, durationMs: Date.now() - toolStart, timestamp: ctx.lastToolCall.timestamp, ok: false });
        chatMessages.push({ role: 'tool', tool_call_id: tool.id, content: result });
        return;
      }
    }
    // action === 'allow' — proceed
  }

  // PreToolUse hook — same semantics as the streaming variant.
  let preHookBlocked: string | null = null;
  try {
    const { runHooks } = require('../hooks');
    const pre = await runHooks('PreToolUse', {
      projectPath: ctx.cwd,
      toolName: tool.name,
      toolInput: input,
      currentAbortController: ctx.currentAbortController,
    });
    if (pre.blocked) preHookBlocked = pre.blocked.reason;
    else if (pre.failures.length > 0) {
      const { tuiLog } = require('../tui/bridge');
      for (const f of pre.failures) tuiLog(f, 'warn');
    }
  } catch (err) { swallow(err); }

  // Pre-execution notice for file-mutation tools (same as streaming path).
  if (!preHookBlocked && ['Edit', 'Write', 'MultiEdit'].includes(tool.name)) {
    const { tuiToolCall } = require('../tui/bridge');
    tuiToolCall(tool.name, input);
  }
  const toolStart = Date.now();
  let result: string;
  if (preHookBlocked) {
    result = JSON.stringify({ error: `Blocked by PreToolUse hook: ${preHookBlocked}` });
  } else {
    try {
      if (tool.name.includes('.')) {
        // MCP tool (serverName.toolName)
        const { callMcpTool } = require('../mcp');
        result = await callMcpTool(tool.name, input);
      } else {
        result = await executeTool(tool.name, input, ctx);
      }
    } catch (e: any) {
      result = JSON.stringify({ error: e?.message || String(e) });
    }
  }
  const toolDuration = Date.now() - toolStart;
  ctx.recordToolCall(!toolFailed(result), toolDuration);
  try {
    (ctx as any).__turnToolCount = ((ctx as any).__turnToolCount || 0) + 1;
    require('../../utils/events').recordEvent('tool_call', {
      tool: tool.name, durationMs: toolDuration, ok: !toolFailed(result),
      blocked: !!preHookBlocked,
      turnSeq: (ctx as any).__turnSeq || 0,
      turnPrompt: (ctx as any).__turnPromptSnippet || '',
    });
  } catch (err) { swallow(err); }
  try {
    const { runHooks } = require('../hooks');
    const post = await runHooks('PostToolUse', {
      projectPath: ctx.cwd,
      toolName: tool.name,
      toolInput: input,
      currentAbortController: ctx.currentAbortController,
    });
    if (post.failures.length > 0) {
      const { tuiLog } = require('../tui/bridge');
      for (const f of post.failures) tuiLog(f, 'warn');
    }
  } catch (err) { swallow(err); }
  ctx.lastToolCall = {
    name: tool.name,
    input,
    output: result,
    durationMs: toolDuration,
    timestamp: new Date().toISOString(),
  };
  ctx.toolCallHistory.push({ name: tool.name, input, output: result, durationMs: toolDuration, timestamp: ctx.lastToolCall.timestamp, ok: !toolFailed(result) });
  if (ctx.toolCallHistory.length > 500) ctx.toolCallHistory.splice(0, ctx.toolCallHistory.length - 500);
  const resultPreview = result.length > 200 ? result.slice(0, 200) + '...' : result;
  console.log(`  ${dim('└→')} ${dim(resultPreview.replace(/\n/g, ' '))}`);

  // Add each tool result as its own message (OpenAI format)
  chatMessages.push({
    role: 'tool',
    tool_call_id: tool.id,
    content: require('./tool-limits').clipToolResult(result),
  });
}
