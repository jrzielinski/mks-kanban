import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ApprovalsCronService } from './approvals-cron.service';
import { ApprovalEntity } from './entities/approval.entity';
import { ApprovalHistoryEntity } from './entities/approval-history.entity';
import { ApprovalReminderEntity } from './entities/approval-reminder.entity';
import { ApprovalVotesEntity } from './entities/approval-votes.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      ApprovalEntity,
      ApprovalHistoryEntity,
      ApprovalReminderEntity,
      ApprovalVotesEntity,
    ]),
  ],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalsCronService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
