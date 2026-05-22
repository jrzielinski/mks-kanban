import { swallow } from '../utils/log';
/**
 * headless-worker.ts — subprocess worker mode.
 *
 * When the coordinator spawns a subprocess worker it runs:
 *   node <entrypoint> --worker <id> --session <sessionId>
 *
 * Protocol (JSON-lines on stdin/stdout):
 *   IN  { type: 'run',     task, tools, scratchpadKeys }  → starts the worker loop
 *   IN  { type: 'message', text }                         → continues the loop
 *   IN  { type: 'ping' }                                  → health check
 *   OUT { type: 'done',    result }                       → loop finished
 *   OUT { type: 'error',   error }                        → loop failed
 *   OUT { type: 'pong' }                                  → ping response
 *
 * The worker creates a minimal ReplContext (no auth, no network) so that
 * executeTool can run read-only or Bash tools in isolation.
 */

import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { buildWorkerSystemPrompt } from './ai/coordinator-worker-prompt';

function buildMinimalContext(scratchpadPath: string): any {
  // Create a minimal ReplContext-compatible object so executeTool can run.
  // We don't call initialize() — the worker has no auth, no network, no TUI.
  const { ReplContext } = require('./context');
  const ctx = new ReplContext();
  // Mark as headless — no TUI, no prompts
  ctx.autoApprove = true;
  ctx.cwd = process.cwd();
  // Coordinator fields so coordinatorLog works without crashing
  ctx.coordinatorActive = false;
  ctx.coordinatorMonitor = 'silent'; // workers don't log to parent's terminal
  ctx.coordinatorSessionId = '';
  ctx.coordinatorWorkers = new Map();
  return ctx;
}

interface WorkerState {
  messages: any[];
  system: string;
  tools: string[];
  ctx: any;
  maxIters: number;
  model?: string;
  tokens: { prompt: number; completion: number; total: number };
}

async function runWorkerLoop(state: WorkerState): Promise<{ text: string; tokens: WorkerState['tokens'] }> {
  const { getProvider } = require('./ai/providers');
  const { executeTool, toolDefinitions } = require('./ai/tools');

  const provider = getProvider(state.model || state.ctx.provider || 'claude');
  const allowedNames = state.tools;
  const subTools = (toolDefinitions as any[]).filter((t: any) => allowedNames.includes(t.name));

  let finalText = '';
  const MAX_ITERS = state.maxIters;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let response: any;
    try {
      response = await provider.sendMessage({
        system: state.system,
        messages: state.messages,
        tools: subTools,
      });
    } catch (e: any) {
      throw new Error(`Provider error on iter ${iter}: ${e.message || String(e)}`);
    }

    // Accumulate token usage (same shape as dispatch_agent's counter).
    const usage = response?.usage;
    if (usage) {
      state.tokens.prompt += usage.promptTokens || 0;
      state.tokens.completion += usage.completionTokens || 0;
      state.tokens.total += usage.totalTokens
        || ((usage.promptTokens || 0) + (usage.completionTokens || 0));
    }

    const textBlocks: string[] = [];
    const toolUses: any[] = [];
    for (const block of response.content) {
      if (block.type === 'text' && block.text) textBlocks.push(block.text);
      else if (block.type === 'tool_use') toolUses.push(block);
    }

    if (textBlocks.length > 0) {
      finalText = textBlocks.join('');
      // Emit progress to stderr for the coordinator to see (if not silent)
      const preview = finalText.length > 120 ? finalText.slice(0, 120) + '...' : finalText;
      process.stderr.write(`[worker] ${preview}\n`);
    }

    if (toolUses.length === 0) break;

    state.messages.push({
      role: 'assistant',
      content: textBlocks.join('') || null,
      tool_calls: toolUses.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
      })),
    });

    for (const tool of toolUses) {
      if (!allowedNames.includes(tool.name)) {
        state.messages.push({
          role: 'tool',
          tool_call_id: tool.id,
          content: JSON.stringify({ error: `Tool "${tool.name}" not in worker's allowed list.` }),
        });
        continue;
      }
      let result: string;
      try {
        result = await executeTool(tool.name, tool.input || {}, state.ctx);
      } catch (e: any) {
        result = JSON.stringify({ error: `Tool execution failed: ${e.message || String(e)}` });
      }
      state.messages.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: result.length > 50_000 ? result.slice(0, 50_000) + '\n[truncated]' : result,
      });
    }
  }

  state.messages.push({ role: 'assistant', content: finalText || '(done)' });
  return { text: finalText || '(no output)', tokens: state.tokens };
}

export async function runHeadlessWorker(workerId: string, sessionId: string): Promise<void> {
  const scratchpadPath = path.join(os.homedir(), '.makestudio', 'scratch', sessionId);

  // Ensure scratchpad directory exists
  try { fs.mkdirSync(scratchpadPath, { recursive: true }); } catch (err) { swallow(err); }

  const ctx = buildMinimalContext(scratchpadPath);

  // Worker state — initialised on 'init', reused on 'message'
  let state: WorkerState | null = null;

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore malformed lines
    }

    if (msg.type === 'ping') {
      process.stdout.write(JSON.stringify({ type: 'pong' }) + '\n');
      return;
    }

    if (msg.type === 'run') {
      // First message — create state and run the loop.
      // Parent may pass `system` (dispatch_agent subprocess mode, already has
      // a subagent-config prompt) or omit it (coordinator worker → generic
      // scratchpad prompt). Same with maxIters and model.
      const tools: string[] = msg.tools || [
        'Read', 'Glob', 'Grep', 'LSP', 'web_search', 'web_fetch',
        'list_projects', 'get_project', 'get_tasks', 'read_execution_state',
        'find_definition', 'find_references', 'get_symbols', 'git_status', 'git_log',
      ];
      const system: string = typeof msg.system === 'string' && msg.system.trim()
        ? msg.system
        : buildWorkerSystemPrompt(workerId, scratchpadPath, tools);
      const maxIters: number = typeof msg.maxIters === 'number' && msg.maxIters > 0 ? msg.maxIters : 15;
      const model: string | undefined = typeof msg.model === 'string' ? msg.model : undefined;
      state = {
        messages: [{ role: 'user', content: msg.task || '' }],
        system,
        tools,
        ctx,
        maxIters,
        model,
        tokens: { prompt: 0, completion: 0, total: 0 },
      };
      try {
        const { text, tokens } = await runWorkerLoop(state);
        process.stdout.write(JSON.stringify({ type: 'done', result: text, tokens }) + '\n');
      } catch (e: any) {
        process.stdout.write(JSON.stringify({ type: 'error', error: e.message || String(e) }) + '\n');
      }
      return;
    }

    if (msg.type === 'message') {
      // Continuation message from the coordinator
      if (!state) {
        process.stdout.write(JSON.stringify({ type: 'error', error: 'Worker not initialised — send run first.' }) + '\n');
        return;
      }
      state.messages.push({ role: 'user', content: msg.text || '' });
      try {
        const { text } = await runWorkerLoop(state);
        // Use 'message' response type so the coordinator's pendingResolve fires correctly.
        // Only the initial 'run' response uses 'done'. Tokens for continuation
        // calls accumulate in state.tokens and surface at shutdown if needed.
        process.stdout.write(JSON.stringify({ type: 'message', text }) + '\n');
      } catch (e: any) {
        process.stdout.write(JSON.stringify({ type: 'error', error: e.message || String(e) }) + '\n');
      }
      return;
    }

    // Unknown message type — ignore silently
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
