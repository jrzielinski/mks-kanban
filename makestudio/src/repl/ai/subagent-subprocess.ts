import { swallow } from '../../utils/log';
/**
 * subagent-subprocess.ts — spawn dispatch_agent in an isolated Node
 * subprocess. Reuses the coordinator's headless-worker entrypoint
 * (--worker <id> --session <id>), passing the subagent-config's system
 * prompt / tools / maxIters / model through the extended 'run' protocol.
 *
 * Use this when you want true OS-level isolation for a subagent run —
 * e.g. verification that runs a long test suite, or a plan that wants
 * to spawn many subshells without risking stale state in the parent.
 *
 * In-process mode stays the default; subprocess is opt-in via
 * dispatch_agent's `mode: 'subprocess'` param.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface RunOptions {
  workerId: string;
  system: string;
  task: string;
  tools: string[];
  maxIters: number;
  model?: string;
  /** Timeout in ms. Defaults to 30min — matches coordinator's worker cap. */
  timeoutMs?: number;
}

interface RunResult {
  result: string;
  tokens: { prompt: number; completion: number; total: number };
  sessionId: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function runDispatchSubprocess(opts: RunOptions): Promise<RunResult> {
  const sessionId = `dispatch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const scratchpadPath = path.join(os.homedir(), '.makestudio', 'scratch', sessionId);
  try { fs.mkdirSync(scratchpadPath, { recursive: true }); } catch (err) { swallow(err); }

  const nodeExec = process.execPath;
  const entrypoint = require.main?.filename || path.join(__dirname, '../../index.js');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin!.end(); } catch (err) { swallow(err); }
      try { child.kill(); } catch (err) { swallow(err); }
      if (err) reject(err);
      else resolve(value!);
    };

    const child = cp.spawn(
      nodeExec,
      [entrypoint, '--worker', opts.workerId, '--session', sessionId],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAKESTUDIO_PLAIN: '1' } },
    );

    // Route worker stderr through the TUI bridge so progress/error lines
    // don't corrupt Ink's output. Falls back to parent stderr when no TUI.
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

    const timer = setTimeout(
      () => finish(new Error(`dispatch_agent subprocess timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    timer.unref?.();

    // Kick off the run with the full subagent-config payload.
    try {
      child.stdin!.write(JSON.stringify({
        type: 'run',
        task: opts.task,
        system: opts.system,
        tools: opts.tools,
        maxIters: opts.maxIters,
        model: opts.model,
      }) + '\n');
    } catch (err: any) {
      finish(err);
      return;
    }

    let outputBuffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      outputBuffer += chunk.toString();
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'done') {
            finish(null, {
              result: msg.result || '',
              tokens: msg.tokens || { prompt: 0, completion: 0, total: 0 },
              sessionId,
            });
          } else if (msg.type === 'error') {
            finish(new Error(msg.error || 'subprocess reported error'));
          }
        } catch (err) { swallow(err); }
      }
    });

    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (!settled) {
        finish(new Error(`dispatch_agent subprocess exited with code ${code}`));
      }
    });
  });
}
