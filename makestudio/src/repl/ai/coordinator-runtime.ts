import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplContext } from '../context';
import { coordinatorLog } from './coordinator-log';
import { buildWorkerSystemPrompt } from './coordinator-worker-prompt';
import { buildSubagentConfig } from './subagent-config';

import { swallow } from '../../utils/log';
const WORKER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LSP', 'web_search', 'web_fetch',
  'list_projects', 'get_project', 'get_tasks', 'get_dum_details',
  'read_execution_state', 'read_attachment', 'find_definition',
  'find_references', 'get_symbols', 'hover', 'read_file', 'list_files',
  'search_code', 'git_status', 'git_log',
]);

interface WorkerConfig {
  task: string;
  mode: 'in_process' | 'subprocess';
  tools?: string[];
  scratchpadKeys?: string[];
  sessionId: string;
  /** Optional dispatch_agent-style subagent type. When set, overrides the
   *  generic worker prompt with the type's system prompt + tool whitelist. */
  subagentType?: string;
  /** Cap on the tool-use loop. Inherited from subagent config when typed. */
  maxIters?: number;
}

interface InProcessWorker {
  type: 'in_process';
  messages: any[];
  system: string;
  tools: string[];
  maxIters: number;
}

interface SubprocessWorker {
  type: 'subprocess';
  process: cp.ChildProcess;
  pendingResolve?: (r: string) => void;
  pendingReject?: (e: Error) => void;
  pendingTimer?: NodeJS.Timeout;
}

type WorkerHandle = InProcessWorker | SubprocessWorker;

// Per-coordinator-session runtime — one instance per ReplContext
const runtimeMap = new WeakMap<ReplContext, WorkerRuntime>();

export function getWorkerRuntime(ctx: ReplContext): WorkerRuntime {
  if (!runtimeMap.has(ctx)) {
    runtimeMap.set(ctx, new WorkerRuntime(ctx));
  }
  return runtimeMap.get(ctx)!;
}

export class WorkerRuntime {
  private workers = new Map<string, WorkerHandle>();
  private ctx: ReplContext;

  constructor(ctx: ReplContext) {
    this.ctx = ctx;
  }

  resolveMode(requested: string, tools?: string[]): 'in_process' | 'subprocess' {
    if (requested === 'in_process') return 'in_process';
    if (requested === 'subprocess') return 'subprocess';
    // auto: any Bash usage → subprocess; read-only only → in_process
    if (!tools || tools.length === 0) return 'in_process';
    if (tools.includes('Bash') || tools.includes('shell_run')) return 'subprocess';
    if (tools.every((t) => READ_ONLY_TOOLS.has(t))) return 'in_process';
    return 'subprocess'; // safe default for ambiguous tool sets
  }

  async spawn(workerId: string, config: WorkerConfig): Promise<string> {
    if (config.mode === 'subprocess') {
      return this.spawnSubprocess(workerId, config);
    }
    return this.spawnInProcess(workerId, config);
  }

  private async spawnInProcess(workerId: string, config: WorkerConfig): Promise<string> {
    const scratchpadPath = path.join(os.homedir(), '.makestudio', 'scratch', config.sessionId);
    // Typed worker → dispatch_agent subagent config (same prompts / whitelists
    // / turn caps as the built-in dispatch_agent tool). Generic worker →
    // existing scratchpad-oriented prompt.
    let system: string;
    let allowedTools: string[];
    let maxIters: number;
    if (config.subagentType) {
      const cfg = buildSubagentConfig(config.subagentType, this.ctx);
      // Augment the typed prompt with the scratchpad hint so typed workers
      // can still participate in the coordinator's shared-state protocol.
      system = `${cfg.system}\n\n## Coordinator scratchpad\n\nShared state for this session lives at: ${scratchpadPath}/\nRead other workers' reports via Read; write yours to \`${workerId}.md\` when done.`;
      allowedTools = cfg.allowedTools;
      maxIters = cfg.maxTurns;
    } else {
      allowedTools = config.tools || defaultReadOnlyTools();
      system = buildWorkerSystemPrompt(workerId, scratchpadPath, allowedTools);
      maxIters = config.maxIters ?? 15;
    }
    const handle: InProcessWorker = {
      type: 'in_process',
      messages: [{ role: 'user', content: config.task }],
      system,
      tools: allowedTools,
      maxIters,
    };
    this.workers.set(workerId, handle);
    return this.runWorkerLoop(workerId, handle);
  }

  private async spawnSubprocess(workerId: string, config: WorkerConfig): Promise<string> {
    const nodeExec = process.execPath;
    const entrypoint = require.main?.filename || path.join(__dirname, '../../index.js');

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const w = this.workers.get(workerId);
        if (w?.type === 'subprocess') {
          try { w.process.kill('SIGTERM'); } catch (err) { swallow(err); }
        }
        reject(new Error(`Worker "${workerId}" timed out after ${WORKER_TIMEOUT_MS / 1000}s`));
      }, WORKER_TIMEOUT_MS);
      timeout.unref?.();

      const child = cp.spawn(nodeExec, [entrypoint, '--worker', workerId, '--session', config.sessionId], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MAKESTUDIO_PLAIN: '1' },
      });

      // Route worker stderr through bridge so direct writes never corrupt Ink's layout.
      child.stderr!.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const { getTuiBridge } = require('../tui/bridge');
            const bridge = getTuiBridge?.();
            if (bridge) { bridge.addMessage({ role: 'info', text: line }); continue; }
          } catch (err) { swallow(err); }
          process.stderr.write(line + '\n');
        }
      });

      const handle: SubprocessWorker = { type: 'subprocess', process: child };
      this.workers.set(workerId, handle);

      // Send initial task as JSON-line
      child.stdin!.write(
        JSON.stringify({
          type: 'run',
          task: config.task,
          tools: config.tools || defaultReadOnlyTools(),
          scratchpadKeys: config.scratchpadKeys,
        }) + '\n',
      );

      let outputBuffer = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        outputBuffer += chunk.toString();
        const lines = outputBuffer.split('\n');
        outputBuffer = lines.pop()!; // keep incomplete trailing fragment
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'done') {
              clearTimeout(timeout);
              try { child.stdin!.end(); } catch (err) { swallow(err); }
              resolve(msg.result || '');
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(msg.error || 'Worker reported error'));
            } else if (msg.type === 'message' && handle.pendingResolve) {
              const res = handle.pendingResolve;
              clearTimeout(handle.pendingTimer);
              handle.pendingTimer = undefined;
              handle.pendingResolve = undefined;
              handle.pendingReject = undefined;
              res(msg.text || '');
            }
          } catch (err) { swallow(err); }
        }
      });

      child.on('error', (err) => { clearTimeout(timeout); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timeout);
        // If sendMessage is waiting, notify it about the crash
        const pendingRej = handle.pendingReject;
        if (pendingRej) {
          clearTimeout(handle.pendingTimer);
          handle.pendingTimer = undefined;
          handle.pendingResolve = undefined;
          handle.pendingReject = undefined;
          pendingRej(new Error(`Worker subprocess closed unexpectedly (code ${code})`));
        }
        if (code !== 0) {
          reject(new Error(`Worker subprocess exited with code ${code}`));
        } else {
          resolve(outputBuffer.trim());
        }
      });
    });
  }

  async sendMessage(workerId: string, message: string): Promise<string> {
    const handle = this.workers.get(workerId);
    if (!handle) throw new Error(`Worker "${workerId}" not found`);

    if (handle.type === 'in_process') {
      handle.messages.push({ role: 'user', content: message });
      return this.runWorkerLoop(workerId, handle);
    }

    // subprocess: send message via stdin, wait for reply
    return new Promise<string>((resolve, reject) => {
      const subHandle = handle as SubprocessWorker;
      subHandle.pendingResolve = resolve;
      subHandle.pendingReject = reject;
      const timer = setTimeout(() => {
        subHandle.pendingTimer = undefined;
        subHandle.pendingResolve = undefined;
        subHandle.pendingReject = undefined;
        reject(new Error('send_message timeout (60s)'));
      }, 60_000);
      timer.unref?.();
      subHandle.pendingTimer = timer;
      try {
        subHandle.process.stdin!.write(JSON.stringify({ type: 'message', text: message }) + '\n');
      } catch (err: any) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private async runWorkerLoop(workerId: string, handle: InProcessWorker): Promise<string> {
    const { getProvider } = require('./providers');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // eval('require') hides this back-edge from rollup's static cycle
    // detector (see file-tools.ts:249 for the same convention).
    const { executeTool, toolDefinitions } = eval('require')('./tools');

    const provider = getProvider(this.ctx.provider);
    const allowedNames = handle.tools;
    const subTools = (toolDefinitions as any[]).filter((t: any) => allowedNames.includes(t.name));

    let finalText = '';
    const MAX_ITERS = handle.maxIters;

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const response = await provider.sendMessage({
        system: handle.system,
        messages: handle.messages,
        tools: subTools,
      });

      // Per-worker token accounting. Providers return usage under
      // response.usage (promptTokens / completionTokens / totalTokens).
      // Accumulate into the ctx.coordinatorWorkers registry so
      // coordinator_status + StatusLine can surface it.
      try {
        const usage = (response as any).usage;
        if (usage) {
          const w = this.ctx.coordinatorWorkers.get(workerId) as any;
          if (w) {
            w.tokens = w.tokens || { prompt: 0, completion: 0, total: 0 };
            w.tokens.prompt += usage.promptTokens || 0;
            w.tokens.completion += usage.completionTokens || 0;
            w.tokens.total += usage.totalTokens || ((usage.promptTokens || 0) + (usage.completionTokens || 0));
          }
        }
      } catch (err) { swallow(err); }

      const textBlocks: string[] = [];
      const toolUses: any[] = [];
      for (const block of response.content) {
        if (block.type === 'text' && block.text) textBlocks.push(block.text);
        else if (block.type === 'tool_use') toolUses.push(block);
      }

      if (textBlocks.length > 0) {
        finalText = textBlocks.join('');
        const preview = finalText.length > 120 ? finalText.slice(0, 120) + '...' : finalText;
        coordinatorLog(this.ctx, workerId, preview);
      }

      if (toolUses.length === 0) break;

      handle.messages.push({
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
          handle.messages.push({
            role: 'tool',
            tool_call_id: tool.id,
            content: JSON.stringify({ error: `Tool "${tool.name}" not in worker's allowed list.` }),
          });
          continue;
        }
        const result = await executeTool(tool.name, tool.input || {}, this.ctx);
        handle.messages.push({
          role: 'tool',
          tool_call_id: tool.id,
          content: result.length > 50_000 ? result.slice(0, 50_000) + '\n[truncated]' : result,
        });
      }
    }

    handle.messages.push({ role: 'assistant', content: finalText || '(done)' });
    return finalText || '(no output)';
  }

  stopAll(): void {
    for (const [, handle] of this.workers.entries()) {
      if (handle.type === 'subprocess') {
        try { handle.process.kill('SIGTERM'); } catch (err) { swallow(err); }
      }
    }
    this.workers.clear();
  }
}

function defaultReadOnlyTools(): string[] {
  return [
    'Read', 'Glob', 'Grep', 'LSP', 'web_search', 'web_fetch',
    'list_projects', 'get_project', 'get_tasks', 'read_execution_state',
    'find_definition', 'find_references', 'get_symbols', 'git_status', 'git_log',
  ];
}

