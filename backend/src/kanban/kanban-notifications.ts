/**
 * notifications — extracted from KanbanService.
 */
import { KanbanService } from './kanban.service';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, ILike, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { KanbanBoardEntity, KanbanBoardMember } from './entities/kanban-board.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanCardActivityEntity, ActivityType } from './entities/kanban-card-activity.entity';
import { KanbanNotificationEntity } from './entities/kanban-notification.entity';
import { KanbanWorkspaceEntity } from './entities/kanban-workspace.entity';
import { KanbanBoardStarEntity } from './entities/kanban-board-star.entity';
import { KanbanPowerUpEntity } from './entities/kanban-power-up.entity';
import { KanbanTimeLogEntity } from './entities/kanban-time-log.entity';
import { KanbanHourRequestEntity } from './entities/kanban-hour-request.entity';
import { KanbanCardHistoryEntity } from './entities/kanban-card-history.entity';
import { ApprovalEntity } from '../approvals/entities/approval.entity';
import { ApprovalHistoryEntity } from '../approvals/entities/approval-history.entity';
import { KanbanMailService } from './kanban-mail.service';
import { KanbanGateway } from './kanban.gateway';
import { KanbanCardEventPayload, KanbanEventKey } from './power-ups/types';
import { MultiProviderAiService } from '../api-config/services/multi-provider-ai.service';
import { ApiConfigService } from '../api-config/api-config.service';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

export async function listNotifications_helper(service: KanbanService, tenantId: string, userId: string): Promise<KanbanNotificationEntity[]> {
  return (service as any).notifRepo.find({
    where: { tenantId, userId },
    order: { createdAt: 'DESC' },
    take: 50,
  });
}

export async function markNotificationRead_helper(service: KanbanService, tenantId: string, notifId: string, userId: string): Promise<void> {
  await (service as any).notifRepo.update({ id: notifId, tenantId, userId }, { isRead: true });
}

export async function markAllNotificationsRead_helper(service: KanbanService, tenantId: string, userId: string): Promise<void> {
  await (service as any).notifRepo.update({ tenantId, userId, isRead: false }, { isRead: true });
}
