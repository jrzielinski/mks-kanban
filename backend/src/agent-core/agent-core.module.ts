import { Module } from '@nestjs/common';
import { AgentCoreService } from './agent-core.service';

@Module({
  providers: [AgentCoreService],
  exports: [AgentCoreService],
})
export class AgentCoreModule {}
