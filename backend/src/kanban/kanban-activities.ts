/**
 * activities — extracted from KanbanService.
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

export async function addActivity_helper(service: KanbanService, 
  tenantId: string,
  cardId: string,
  userId: string,
  // @ts-ignore
  dto: CreateActivityDto,
): Promise<KanbanCardActivityEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  const activity = (service as any).activityRepo.create({
    cardId,
    boardId: card.boardId,
    tenantId,
    userId: userId || null,
    userName: dto.userName ?? null,
    type: (dto.type ?? 'comment') as ActivityType,
    text: dto.text,
  });

  const saved = await (service as any).activityRepo.save(activity);

  if (saved.type === 'comment') {
    (service as any).eventEmitter.emit('kanban.card.commented', (service as any).buildCardPayload(
      'card.commented', card, userId || '', dto.userName ?? '',
    ));
  }

  // Create mention notifications
  if (saved.type === 'comment') {
    const mentions = dto.text.match(/@(\w[\w\s]{0,20})/g);
    if (mentions) {
      const board = await (service as any).boardRepo.findOne({ where: { id: card.boardId, tenantId } });
      if (board?.members) {
        const mentionedNames = mentions.map((m) => m.slice(1).trim().toLowerCase());
        const mentionedMembers = board.members.filter((m) =>
          mentionedNames.some((mn) => m.name.toLowerCase().startsWith(mn)),
        );
        for (const member of mentionedMembers) {
          if (member.id !== userId) {
            (service as any).notifRepo.save(
              (service as any).notifRepo.create({
                tenantId,
                userId: member.id,
                boardId: card.boardId,
                cardId: card.id,
                cardTitle: card.title,
                type: 'mention',
                text: `${dto.userName ?? 'Alguém'} mencionou você em "${card.title}": ${dto.text.slice(0, 80)}`,
              }),
            ).catch(() => {});
            // Send email if member has an email address stored
            if ((member as any).email) {
              (service as any).kanbanMailService.sendMentionEmail({
                recipient: { name: member.name, email: (member as any).email },
                mentionedBy: dto.userName ?? 'Alguém',
                cardTitle: card.title,
                boardTitle: board!.title,
                commentText: dto.text,
              }).catch(() => {});
            }
          }
        }
      }
    }
  }

  // Notify card watchers of new comment
  if (saved.type === 'comment' && card.watchedBy?.length) {
    const board = await (service as any).boardRepo.findOne({ where: { id: card.boardId, tenantId } });
    for (const watcherId of card.watchedBy) {
      if (watcherId !== userId) {
        (service as any).notifRepo.save((service as any).notifRepo.create({
          tenantId,
          userId: watcherId,
          boardId: card.boardId,
          cardId: card.id,
          cardTitle: card.title,
          type: 'watch',
          text: `${dto.userName ?? 'Alguém'} comentou em "${card.title}": ${dto.text.slice(0, 80)}`,
        })).catch(() => {});
        // Email watcher
        const watcherMember = board?.members?.find(m => m.id === watcherId);
        if (watcherMember && (watcherMember as any).email) {
          (service as any).kanbanMailService.sendWatcherCommentEmail({
            recipient: { name: watcherMember.name, email: (watcherMember as any).email },
            commentBy: dto.userName ?? 'Alguém',
            cardTitle: card.title,
            boardTitle: board!.title,
            commentText: dto.text,
          }).catch(() => {});
        }
      }
    }
  }

  // Slack notification for comments
  if (saved.type === 'comment') {
    // Slack notification handled by KanbanSlackPowerUpService via kanban.card.commented event
    // Emit event for Jira sync
    (service as any).eventEmitter.emit('kanban.card.commented', {
      cardId, boardId: card.boardId, tenantId, text: dto.text, userName: dto.userName ?? 'Usuário',
    });
  }

  (service as any).gateway.emit(tenantId, saved.boardId, 'activity:added', { cardId: saved.cardId, activity: saved });
  return saved;
}

export async function listActivities_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanCardActivityEntity[]> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  return (service as any).activityRepo.find({
    where: { cardId, tenantId },
    order: { createdAt: 'ASC' },
  });
}

// @ts-ignore
export async function updateActivity_helper(service: KanbanService, tenantId: string, activityId: string, userId: string, dto: UpdateActivityDto): Promise<KanbanCardActivityEntity> {
  const activity = await (service as any).activityRepo.findOne({ where: { id: activityId, tenantId } });
  if (!activity) throw new NotFoundException('Activity not found');
  if (activity.type !== 'comment') throw new ForbiddenException('Only comments can be edited');
  if (activity.userId && activity.userId !== userId) throw new ForbiddenException('Cannot edit another user comment');
  activity.text = dto.text;
  return (service as any).activityRepo.save(activity);
}

export async function deleteActivity_helper(service: KanbanService, tenantId: string, activityId: string, userId: string): Promise<void> {
  const activity = await (service as any).activityRepo.findOne({ where: { id: activityId, tenantId } });
  if (!activity) throw new NotFoundException('Activity not found');
  if (activity.type !== 'comment') throw new ForbiddenException('Only comments can be deleted');
  if (activity.userId && activity.userId !== userId) throw new ForbiddenException('Cannot delete another user comment');
  await (service as any).activityRepo.remove(activity);
}

export async function logEvent_helper(service: KanbanService, tenantId: string, cardId: string, boardId: string, text: string): Promise<void> {
  const activity = (service as any).activityRepo.create({ cardId, boardId, tenantId, userId: null, userName: null, type: 'event', text });
  await (service as any).activityRepo.save(activity);
}

export async function getCardHistory_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanCardHistoryEntity[]> {
  return (service as any).cardHistoryRepo.find({
    where: { cardId, tenantId },
    order: { movedAt: 'DESC' },
  });
}
