import { Injectable, Logger } from '@nestjs/common';

// Stub — the full agent-core module (WebSocket REPL) lives in the MakeStudio
// monolith. Kanban uses it only to dispatch background AI tasks; in standalone
// mode those features gracefully degrade to no-ops.
@Injectable()
export class AgentCoreService {
  private readonly logger = new Logger(AgentCoreService.name);

  getConnectedAgentsCount(_tenantId: string): number {
    return 0;
  }

  /**
   * In the monolith this dispatches an AI coding task and waits for the
   * worker to report back with content, cost, and git activity. In the
   * standalone build it's a no-op — accept the same call shape and return
   * an empty result so callers (e.g. KanbanAgentService) compile and
   * degrade gracefully.
   */
  async dispatchTask(..._args: unknown[]): Promise<AgentDispatchResult> {
    this.logger.warn('AgentCoreService.dispatchTask: stub — agent-core not available');
    return { jobId: 'stub-' + Date.now() };
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
