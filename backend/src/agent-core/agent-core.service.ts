import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Two-mode service: bridges through the parent process IPC channel when
 * embedded inside the MakeStudio Electron app (mks-code), or falls back
 * to a quiet stub when running standalone (web server, docker, dev).
 *
 * The embedded mode is auto-detected by the presence of `process.send` —
 * Node only provides it when the current process was spawned via
 * `child_process.fork()` with an `ipc` channel. The MakeStudio main
 * process forks this backend that way and attaches a bridge handler
 * (`mks-code/src/agent-bridge/server.ts`) that translates dispatch
 * requests into `runHeadless()` calls.
 *
 * No env vars, no HTTP, no extra config — works as soon as the parent
 * attaches its IPC listener.
 */
@Injectable()
export class AgentCoreService {
  private readonly logger = new Logger(AgentCoreService.name);
  /** Pending requests keyed by request id; resolved when the parent answers. */
  private readonly pending = new Map<string, {
    resolve: (r: AgentDispatchResult) => void;
    reject: (e: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private ipcReady = false;

  constructor() {
    if (typeof process.send === 'function') {
      this.installIpcHandler();
      this.ipcReady = true;
      this.logger.log('AgentCoreService: IPC bridge to parent process attached');
    }
  }

  private installIpcHandler(): void {
    process.on('message', (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; id?: string; ok?: boolean; result?: AgentDispatchResult; error?: string };
      if (m.type !== 'agent:dispatch:result' || !m.id) return;
      const slot = this.pending.get(m.id);
      if (!slot) return;
      this.pending.delete(m.id);
      clearTimeout(slot.timeout);
      if (m.ok && m.result) slot.resolve(m.result);
      else slot.reject(new Error(m.error || 'agent dispatch failed'));
    });
  }

  getConnectedAgentsCount(_tenantId: string): number {
    return this.ipcReady ? 1 : 0;
  }

  /**
   * Dispatches a coding task. Embedded → routes to MakeStudio's
   * `runHeadless` via parent IPC. Standalone → no-op (jobId only).
   *
   * Signature is positional to match the existing call sites
   * (KanbanAgentService.executeCard); do not rearrange.
   */
  async dispatchTask(
    ...args: unknown[]
  ): Promise<AgentDispatchResult> {
    if (!this.ipcReady || typeof process.send !== 'function') {
      this.logger.warn('AgentCoreService.dispatchTask: no IPC bridge — degraded to stub');
      return { jobId: 'stub-' + Date.now() };
    }
    const id = randomUUID();
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 min cap per task
    return new Promise<AgentDispatchResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent dispatch ${id} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        process.send!({ type: 'agent:dispatch', id, args });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

export interface AgentDispatchResult {
  jobId: string;
  content?: string;
  costUsd?: number;
  gitInfo?: {
    branch?: string;
    commits?: number;
    pushed?: boolean;
  };
}
