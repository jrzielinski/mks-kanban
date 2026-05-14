/**
 * helpers — extracted from KanbanService.
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

export function slugify_helper(service: KanbanService, title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export async function buildUniqueSlug_helper(service: KanbanService, tenantId: string, title: string, excludeId?: string): Promise<string> {
  const base = (service as any).slugify(title);
  let candidate = base;
  let counter = 2;
  while (true) {
    const existing = await (service as any).boardRepo.findOne({ where: { slug: candidate, tenantId } });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${counter++}`;
  }
}

export function isUUID_helper(service: KanbanService, value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function buildCardPayload_helper(service: KanbanService, 
  eventType: KanbanEventKey,
  card: KanbanCardEntity,
  actorId: string,
  actorName: string,
  extra?: Record<string, unknown>,
): KanbanCardEventPayload {
  return {
    eventType,
    tenantId: card.tenantId,
    boardId: card.boardId,
    cardId: card.id,
    card: {
      id: card.id,
      title: card.title,
      description: card.description ?? null,
      listId: card.listId,
      boardId: card.boardId,
      memberIds: card.memberIds ?? [],
      labels: card.labels ?? [],
      dueDate: card.dueDate ? card.dueDate.toISOString() : null,
      position: card.position,
    },
    actor: { id: actorId, name: actorName },
    timestamp: new Date().toISOString(),
    extra,
  };
}
