// src/kanban/agent/kanban-agent.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KanbanBoardRepoEntity } from './entities/kanban-board-repo.entity';
import { KanbanListAgentConfigEntity } from './entities/kanban-list-agent-config.entity';
import { KanbanAgentExecutionEntity } from './entities/kanban-agent-execution.entity';
import { KanbanAgentService } from './kanban-agent.service';
import { KanbanAgentController } from './kanban-agent.controller';
import { AgentCoreModule } from '../../agent-core/agent-core.module';
import { CredentialsModule } from '../../credentials/credentials.module';
import { KanbanCardEntity } from '../entities/kanban-card.entity';
import { KanbanModule } from '../kanban.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      KanbanBoardRepoEntity,
      KanbanListAgentConfigEntity,
      KanbanAgentExecutionEntity,
      KanbanCardEntity,
    ]),
    AgentCoreModule,
    CredentialsModule,
    forwardRef(() => KanbanModule),
  ],
  controllers: [KanbanAgentController],
  providers: [KanbanAgentService],
  exports: [KanbanAgentService],
})
export class KanbanAgentModule {}
