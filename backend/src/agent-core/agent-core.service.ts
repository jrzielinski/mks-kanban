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

  async dispatchTask(task: unknown): Promise<{ jobId: string }> {
    this.logger.warn('AgentCoreService.dispatchTask: stub — agent-core not available');
    return { jobId: 'stub-' + Date.now() };
  }
}
