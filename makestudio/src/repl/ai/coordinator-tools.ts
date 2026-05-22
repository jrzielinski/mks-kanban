import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplContext } from '../context';
import type { ToolDefinition } from './tools';
import { coordinatorLog } from './coordinator-log';

import { swallow } from '../../utils/log';
export const coordinatorLifecycleToolDefs: ToolDefinition[] = [
  {
    name: 'coordinator_activate',
    description: 'Activate coordinator mode for complex multi-phase tasks. Call this when the task requires parallel research or sequential delegation to isolated workers. Notifies the user and injects coordinator instructions.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One sentence explaining why coordinator mode is appropriate for this task.' },
        monitor: { type: 'string', enum: ['linear', 'dashboard', 'silent'], description: 'Monitoring mode (default: linear).' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'coordinator_deactivate',
    description: 'Deactivate coordinator mode after completing the coordinated task. Cleans up active workers and scratchpad session.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export const coordinatorActiveDefs: ToolDefinition[] = [
  {
    name: 'spawn_worker',
    description: 'Spawn an isolated worker agent with its own system prompt and message history. Use for research (read-only) or implementation (edit) tasks. Workers share state via the scratchpad only. IMPORTANT: pass `peer: "<peerId>"` to run the worker on a REMOTE cluster peer (different machine) — this is the ONLY tool that can delegate to another machine. `dispatch_agent` ALWAYS runs locally. If the user mentions a peer id or "on the other machine" / "na outra máquina", you MUST use spawn_worker with peer — not dispatch_agent.',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Unique name for this worker (e.g. "research-auth", "impl-token-refresh"). Must be unique within the session.' },
        task: { type: 'string', description: 'Complete, self-contained task description. The worker has no memory of the coordinator conversation.' },
        mode: { type: 'string', enum: ['auto', 'in_process', 'subprocess'], description: 'Runtime mode. auto: in_process for read-only tools, subprocess if Bash is needed.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Subset of tools this worker may use. Omit to use default read-only set. Ignored when subagent_type is set.' },
        subagent_type: { type: 'string', description: 'Optional built-in subagent flavor (explore | plan | code-reviewer | verification | general-purpose) or custom-agent name. When set, the worker inherits the dispatch_agent prompt + tool whitelist + turn cap for that type. tools/mode are derived automatically.' },
        peer: { type: 'string', description: 'Optional peer id (from /cluster list) to run the worker remotely. Use the literal string "auto" to let the coordinator pick the least-loaded peer (advertised via load-hint in the discovery beacon). Only read-only subagent types are allowed unless the peer has been explicitly trusted via /cluster trust <peer-id> --allow-bash. Falls back to local spawn if "auto" is requested but no peers are available.' },
        scratchpad_keys: { type: 'array', items: { type: 'string' }, description: 'Scratchpad keys this worker is authorized to read/write.' },
      },
      required: ['worker_id', 'task'],
    },
  },
  {
    name: 'send_message',
    description: "Continue an existing worker with a new message (stateful — keeps the worker's full conversation history). Use to give feedback, request clarification, or ask for a corrected scratchpad entry.",
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: "ID of an existing worker (must have been spawned in this session)." },
        message: { type: 'string', description: 'Message to send to the worker.' },
      },
      required: ['worker_id', 'message'],
    },
  },
  {
    name: 'read_scratchpad',
    description: 'Read a file from the coordinator scratchpad directory (~/.makestudio/scratch/<session-id>/<key>).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Filename within the scratchpad directory (e.g. "research-auth.md", "done-impl.md").' },
      },
      required: ['key'],
    },
  },
  {
    name: 'write_scratchpad',
    description: 'Write a file to the coordinator scratchpad directory.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Filename within the scratchpad directory.' },
        content: { type: 'string', description: 'Content to write.' },
      },
      required: ['key', 'content'],
    },
  },
  {
    name: 'coordinator_status',
    description: 'List all workers in this coordinator session with their status, elapsed time, and a summary of scratchpad keys.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export function isCoordinatorToolName(name: string, ctx?: ReplContext): boolean {
  const defs = ctx
    ? [...coordinatorLifecycleToolDefs, ...(ctx.coordinatorActive ? coordinatorActiveDefs : [])]
    : [...coordinatorLifecycleToolDefs, ...coordinatorActiveDefs];
  return defs.some((t) => t.name === name);
}

function scratchpadDir(sessionId: string): string {
  return path.join(os.homedir(), '.makestudio', 'scratch', sessionId);
}

function ensureScratchpad(sessionId: string): string {
  const dir = scratchpadDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeScratchpadKey(sessionId: string, key: string): string {
  const dir = scratchpadDir(sessionId);
  const resolved = path.resolve(dir, key);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new Error(`Path traversal blocked: key "${key}"`);
  }
  return resolved;
}

export async function executeCoordinatorTool(
  name: string,
  input: any,
  ctx: ReplContext,
): Promise<string> {
  switch (name) {
    case 'coordinator_activate': {
      if (ctx.coordinatorActive) {
        return JSON.stringify({ ok: false, message: 'Coordinator mode is already active.' });
      }
      const sessionId = `coord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      ctx.coordinatorActive = true;
      ctx.coordinatorSessionId = sessionId;
      const validMonitors: Array<'linear' | 'dashboard' | 'silent'> = ['linear', 'dashboard', 'silent'];
      ctx.coordinatorMonitor = validMonitors.includes(input.monitor) ? input.monitor : 'linear';
      ctx.coordinatorWorkers = new Map();
      ensureScratchpad(sessionId);
      coordinatorLog(ctx, 'coordinator', `coordinator mode activated (session: ${sessionId})`);
      return JSON.stringify({
        ok: true,
        sessionId,
        scratchpad: scratchpadDir(sessionId),
        monitor: ctx.coordinatorMonitor,
        message: `Coordinator mode activated. Scratchpad: ~/.makestudio/scratch/${sessionId}/`,
      });
    }

    case 'coordinator_deactivate': {
      if (!ctx.coordinatorActive) {
        return JSON.stringify({ ok: false, message: 'Coordinator mode is not active.' });
      }
      try {
        const { getWorkerRuntime } = require('./coordinator-runtime');
        getWorkerRuntime(ctx)?.stopAll();
      } catch (err) { swallow(err); }
      const sessionId = ctx.coordinatorSessionId;
      ctx.coordinatorActive = false;
      ctx.coordinatorSessionId = '';
      ctx.coordinatorWorkers = new Map();
      coordinatorLog(ctx, 'coordinator', 'coordinator mode deactivated');
      return JSON.stringify({ ok: true, sessionId, message: 'Coordinator mode deactivated.' });
    }

    case 'spawn_worker': {
      if (!ctx.coordinatorActive) {
        return JSON.stringify({ error: 'coordinator_activate must be called first.' });
      }
      const { worker_id, task, mode = 'auto', tools: workerTools, subagent_type, scratchpad_keys, peer: remotePeerId } = input;
      if (!worker_id || !task) return JSON.stringify({ error: 'worker_id and task are required.' });
      if (ctx.coordinatorWorkers.has(worker_id)) {
        return JSON.stringify({ error: `Worker "${worker_id}" already exists. Use send_message to continue it.` });
      }

      // Remote peer spawn — off-load to the cluster client. The worker still
      // registers in ctx.coordinatorWorkers so /cluster and coordinator_status
      // see it, but its lifecycle is driven by the remote peer.
      let resolvedPeerId: string | undefined = remotePeerId;
      if (remotePeerId === 'auto') {
        try {
          const { pickBestPeer } = require('../cluster/discovery');
          const best = pickBestPeer?.();
          if (best) resolvedPeerId = best.peerId;
          else resolvedPeerId = undefined; // no peers — fall through to local
        } catch { resolvedPeerId = undefined; }
      }
      if (resolvedPeerId) {
        const { spawnWorkerOnPeer } = require('../cluster/client');
        ctx.coordinatorWorkers.set(worker_id, {
          id: worker_id,
          status: 'running',
          startedAt: Date.now(),
          mode: 'subprocess', // remote runs in a separate process — closest existing enum
          subagentType: subagent_type,
        });
        coordinatorLog(ctx, worker_id, `spawned on peer ${resolvedPeerId} (${subagent_type || 'general-purpose'})`);
        // Subagent types that need Bash to do their job (run tests, git diff, etc.).
        // The remote peer still enforces trust — without /cluster trust --allow-bash
        // the peer returns an error; we just declare intent here so the remote gate
        // has enough info to decide. Previously hardcoded false, which silently
        // broke code-reviewer and verification on remote peers even when trusted.
        const bashy = new Set(['code-reviewer', 'verification']);
        const wantsBash = subagent_type ? bashy.has(subagent_type) : false;
        spawnWorkerOnPeer(resolvedPeerId, {
          task,
          subagentType: subagent_type,
          wantsBash,
          // Hand the coordinator's ctx to the cluster client so the remote
          // worker can route tool-calls back here and Read/Grep/etc runs
          // against our real filesystem + project.
          originCtx: ctx,
        }).then((res: any) => {
          const w = ctx.coordinatorWorkers.get(worker_id);
          if (w) {
            w.status = res.ok ? 'done' : 'failed';
            if (res.tokens) {
              w.tokens = w.tokens || { prompt: 0, completion: 0, total: 0 };
              w.tokens.prompt += res.tokens.prompt || 0;
              w.tokens.completion += res.tokens.completion || 0;
              w.tokens.total += res.tokens.total || 0;
            }
          }
          coordinatorLog(ctx, worker_id, res.ok
            ? `done (remote ${resolvedPeerId})`
            : `failed on ${resolvedPeerId}: ${res.error || 'unknown'}`);
          try {
            const dir = ensureScratchpad(ctx.coordinatorSessionId);
            fs.writeFileSync(
              path.join(dir, `${worker_id}.md`),
              `## Remote worker result (peer ${resolvedPeerId})\n\n${res.result || res.error || '(no output)'}\n`,
            );
          } catch (err) { swallow(err); }
        }).catch((err: any) => {
          const w = ctx.coordinatorWorkers.get(worker_id);
          if (w) w.status = 'failed';
          coordinatorLog(ctx, worker_id, `remote dispatch error on ${resolvedPeerId}: ${err.message || String(err)}`);
        });
        return JSON.stringify({
          ok: true,
          worker_id,
          mode: 'remote',
          peer: resolvedPeerId,
          subagent_type: subagent_type || null,
          message: `Worker "${worker_id}" dispatched to peer ${resolvedPeerId}. Use coordinator_status to monitor, read_scratchpad ${worker_id}.md for the result.`,
        });
      }

      const { getWorkerRuntime } = require('./coordinator-runtime');
      const runtime = getWorkerRuntime(ctx);

      // When subagent_type is provided, derive tools + mode from that type's
      // dispatch_agent whitelist (so code-reviewer/verification get Bash,
      // explore/plan stay read-only, etc.). Explicit `tools` is ignored in
      // this branch — typed workers follow the built-in contract.
      let effectiveTools = workerTools;
      if (subagent_type) {
        try {
          const { buildSubagentConfig } = require('./subagent-config');
          const cfg = buildSubagentConfig(subagent_type, ctx);
          effectiveTools = cfg.allowedTools;
        } catch (err: any) {
          return JSON.stringify({ error: `Subagent type "${subagent_type}" unresolved: ${err.message || err}` });
        }
      }
      const resolvedMode = runtime.resolveMode(mode, effectiveTools);

      ctx.coordinatorWorkers.set(worker_id, {
        id: worker_id,
        status: 'running',
        startedAt: Date.now(),
        mode: resolvedMode,
        subagentType: subagent_type,
      });

      coordinatorLog(ctx, worker_id, `spawned (${resolvedMode}${subagent_type ? ', ' + subagent_type : ''}) — starting task...`);

      // Non-blocking: fire and let the worker run asynchronously
      runtime.spawn(worker_id, {
        task,
        mode: resolvedMode,
        tools: effectiveTools,
        subagentType: subagent_type,
        scratchpadKeys: scratchpad_keys,
        sessionId: ctx.coordinatorSessionId,
      }).then(() => {
        const w = ctx.coordinatorWorkers.get(worker_id);
        if (w) w.status = 'done';
        coordinatorLog(ctx, worker_id, 'done');
      }).catch((err: any) => {
        const w = ctx.coordinatorWorkers.get(worker_id);
        if (w) w.status = 'failed';
        coordinatorLog(ctx, worker_id, `failed: ${err.message || String(err)}`);
        try {
          const dir = ensureScratchpad(ctx.coordinatorSessionId);
          fs.writeFileSync(
            path.join(dir, `error-${worker_id}.md`),
            `## Status: failed\n\n${err.message || String(err)}\n`,
          );
        } catch (err) { swallow(err); }
      });

      return JSON.stringify({
        ok: true,
        worker_id,
        mode: resolvedMode,
        subagent_type: subagent_type || null,
        message: `Worker "${worker_id}" spawned in ${resolvedMode} mode${subagent_type ? ' as ' + subagent_type : ''}. Use coordinator_status to monitor, read_scratchpad to read results.`,
      });
    }

    case 'send_message': {
      const { worker_id, message } = input;
      if (!ctx.coordinatorActive) return JSON.stringify({ error: 'Coordinator mode not active.' });
      if (!ctx.coordinatorWorkers.has(worker_id)) {
        return JSON.stringify({ error: `Worker "${worker_id}" not found. Spawn it first with spawn_worker.` });
      }
      const { getWorkerRuntime } = require('./coordinator-runtime');
      const runtime = getWorkerRuntime(ctx);
      const response = await runtime.sendMessage(worker_id, message);
      const preview = response.length > 100 ? response.slice(0, 100) + '...' : response;
      coordinatorLog(ctx, worker_id, `replied: ${preview}`);
      return JSON.stringify({ ok: true, worker_id, response });
    }

    case 'read_scratchpad': {
      if (!ctx.coordinatorActive) return JSON.stringify({ error: 'Coordinator mode not active.' });
      const file = safeScratchpadKey(ctx.coordinatorSessionId, input.key);
      if (!fs.existsSync(file)) return JSON.stringify({ ok: false, key: input.key, content: '' });
      return JSON.stringify({ ok: true, key: input.key, content: fs.readFileSync(file, 'utf8') });
    }

    case 'write_scratchpad': {
      if (!ctx.coordinatorActive) return JSON.stringify({ error: 'Coordinator mode not active.' });
      ensureScratchpad(ctx.coordinatorSessionId);
      const file = safeScratchpadKey(ctx.coordinatorSessionId, input.key);
      fs.writeFileSync(file, input.content, 'utf8');
      return JSON.stringify({ ok: true, key: input.key, bytes: Buffer.byteLength(input.content) });
    }

    case 'coordinator_status': {
      if (!ctx.coordinatorActive) return JSON.stringify({ error: 'Coordinator mode not active.' });
      const workers = Array.from(ctx.coordinatorWorkers.entries()).map(([id, w]) => ({
        id,
        status: w.status,
        mode: w.mode,
        subagentType: w.subagentType || null,
        elapsedSec: Math.round((Date.now() - w.startedAt) / 1000),
        tokens: w.tokens || { prompt: 0, completion: 0, total: 0 },
      }));
      const totalTokens = workers.reduce((sum, w) => sum + (w.tokens.total || 0), 0);
      let scratchpadKeys: string[] = [];
      let scratchpadBytes = 0;
      try {
        const dir = scratchpadDir(ctx.coordinatorSessionId);
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          scratchpadKeys = files;
          scratchpadBytes = files.reduce((sum, f) => {
            try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
          }, 0);
        }
      } catch (err) { swallow(err); }
      return JSON.stringify({
        sessionId: ctx.coordinatorSessionId,
        monitor: ctx.coordinatorMonitor,
        workers,
        totalTokens,
        scratchpad: { keys: scratchpadKeys, totalBytes: scratchpadBytes },
      }, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown coordinator tool: ${name}` });
  }
}

export { coordinatorLog } from './coordinator-log';
