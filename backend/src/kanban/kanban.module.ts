// src/kanban/kanban.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KanbanBoardEntity } from './entities/kanban-board.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanCardActivityEntity } from './entities/kanban-card-activity.entity';
import { KanbanNotificationEntity } from './entities/kanban-notification.entity';
import { KanbanWorkspaceEntity } from './entities/kanban-workspace.entity';
import { KanbanBoardStarEntity } from './entities/kanban-board-star.entity';
import { KanbanPowerUpEntity } from './entities/kanban-power-up.entity';
import { KanbanPowerUpTemplateEntity } from './power-ups/kanban-power-up-template.entity';
import { KanbanPowerUpLogEntity } from './power-ups/kanban-power-up-log.entity';
import { KanbanTimeLogEntity } from './entities/kanban-time-log.entity';
import { KanbanHourRequestEntity } from './entities/kanban-hour-request.entity';
import { KanbanCardHistoryEntity } from './entities/kanban-card-history.entity';
import { KanbanService } from './kanban.service';
import { KanbanGateway } from './kanban.gateway';
import { KanbanController } from './kanban.controller';
import { KanbanMailService } from './kanban-mail.service';
import { KanbanRecurrenceService } from './kanban-recurrence.service';
import { KanbanDueNotificationService } from './kanban-due-notification.service';
import { MailerModule } from '../mailer/mailer.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ApprovalEntity } from '../approvals/entities/approval.entity';
import { ApprovalHistoryEntity } from '../approvals/entities/approval-history.entity';
import { KanbanAgentModule } from './agent/kanban-agent.module';
import { KanbanPowerUpTemplateService } from './power-ups/kanban-power-up-template.service';
import { KanbanPowerUpExecutorService } from './power-ups/kanban-power-up-executor.service';
import { KanbanPowerUpController } from './power-ups/kanban-power-up.controller';
import { ApiConfigModule } from '../api-config/api-config.module';
import { KanbanJiraPowerUpService } from './kanban-jira-powerup.service';
import { KanbanGoogleDrivePowerUpService } from './kanban-google-drive-powerup.service';
import { KanbanConfluencePowerUpService } from './kanban-confluence-powerup.service';
import { KanbanGiphyPowerUpService } from './kanban-giphy-powerup.service';
import { KanbanEmailToCardPowerUpService } from './kanban-email-to-card-powerup.service';
import { KanbanBurndownPowerUpService } from './kanban-burndown-powerup.service';
import { KanbanGithubPowerUpService } from './kanban-github-powerup.service';
import { KanbanSlackPowerUpService } from './kanban-slack-powerup.service';
import { KanbanFlowTriggerService } from './kanban-flow-trigger.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      KanbanBoardEntity, KanbanListEntity, KanbanCardEntity,
      KanbanCardActivityEntity, KanbanNotificationEntity,
      KanbanWorkspaceEntity, KanbanBoardStarEntity, KanbanPowerUpEntity,
      KanbanTimeLogEntity, KanbanHourRequestEntity, KanbanCardHistoryEntity,
      ApprovalEntity, ApprovalHistoryEntity,
      KanbanPowerUpTemplateEntity, KanbanPowerUpLogEntity,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        // @ts-ignore
        secret: configService.get('auth.secret', { infer: true }),
      }),
      inject: [ConfigService],
    }),
    MailerModule,
    ScheduleModule.forRoot(),
    ApprovalsModule,
    forwardRef(() => KanbanAgentModule),
    ApiConfigModule,
  ],
  controllers: [KanbanController, KanbanPowerUpController],
  providers: [KanbanService, KanbanGateway, KanbanMailService, KanbanRecurrenceService, KanbanDueNotificationService, KanbanPowerUpTemplateService, KanbanPowerUpExecutorService, KanbanJiraPowerUpService, KanbanGoogleDrivePowerUpService, KanbanConfluencePowerUpService, KanbanGiphyPowerUpService, KanbanEmailToCardPowerUpService, KanbanBurndownPowerUpService, KanbanGithubPowerUpService, KanbanSlackPowerUpService, KanbanFlowTriggerService],
  exports: [KanbanService, KanbanGateway],
})
export class KanbanModule {}
