/**
 * powerups — extracted from KanbanService.
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

export async function listPowerUps_helper(service: KanbanService, tenantId: string, boardId: string): Promise<KanbanPowerUpEntity[]> {
  return (service as any).powerUpRepo.find({ where: { boardId, tenantId } });
}

// @ts-ignore
export async function createPowerUp_helper(service: KanbanService, tenantId: string, boardId: string, dto: CreatePowerUpDto): Promise<KanbanPowerUpEntity> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  const pu = (service as any).powerUpRepo.create({ boardId, tenantId, type: dto.type, config: dto.config, enabled: true });
  return (service as any).powerUpRepo.save(pu);
}

// @ts-ignore
export async function updatePowerUp_helper(service: KanbanService, tenantId: string, powerUpId: string, dto: UpdatePowerUpDto): Promise<KanbanPowerUpEntity> {
  const pu = await (service as any).powerUpRepo.findOne({ where: { id: powerUpId, tenantId } });
  if (!pu) throw new NotFoundException('Power-up not found');
  Object.assign(pu, dto);
  return (service as any).powerUpRepo.save(pu);
}

export async function deletePowerUp_helper(service: KanbanService, tenantId: string, powerUpId: string): Promise<void> {
  const pu = await (service as any).powerUpRepo.findOne({ where: { id: powerUpId, tenantId } });
  if (!pu) throw new NotFoundException('Power-up not found');
  await (service as any).powerUpRepo.remove(pu);
}

// @ts-ignore
export async function advancedSearch_helper(service: KanbanService, tenantId: string, dto: AdvancedSearchDto): Promise<(KanbanCardEntity & { boardTitle: string; listTitle: string })[]> {
  const qb = (service as any).cardRepo.createQueryBuilder('c')
    .where('c.tenant_id = :tenantId', { tenantId })
    .andWhere('c.is_archived = false');

  if (dto.q?.trim()) {
    qb.andWhere('(c.title ILIKE :q OR c.description ILIKE :q)', { q: `%${dto.q.trim()}%` });
  }
  if (dto.boardId) qb.andWhere('c.board_id = :boardId', { boardId: dto.boardId });
  if (dto.listId) qb.andWhere('c.list_id = :listId', { listId: dto.listId });
  if (dto.memberId) qb.andWhere('c.member_ids @> :mid', { mid: JSON.stringify([dto.memberId]) });
  if (dto.labelColor) qb.andWhere('c.labels @> :lbl', { lbl: JSON.stringify([{ color: dto.labelColor }]) });
  if (dto.dueBefore) qb.andWhere('c.due_date <= :dueBefore', { dueBefore: new Date(dto.dueBefore) });
  if (dto.dueAfter) qb.andWhere('c.due_date >= :dueAfter', { dueAfter: new Date(dto.dueAfter) });
  if (dto.hasAttachment === true) qb.andWhere("jsonb_array_length(c.attachments) > 0");
  if (dto.isOverdue === true) qb.andWhere('c.due_date < NOW()');
  if (dto.workspaceId) {
    const boardsInWs = await (service as any).boardRepo.find({ where: { workspaceId: dto.workspaceId, tenantId }, select: ['id'] });
    const boardIds = boardsInWs.map(b => b.id);
    if (boardIds.length === 0) return [];
    qb.andWhere('c.board_id IN (:...wsBoards)', { wsBoards: boardIds });
  }

  qb.orderBy('c.updated_at', 'DESC').take(100);
  const cards = await qb.getMany();

  if (!cards.length) return [];

  const boardIds = [...new Set(cards.map((c) => c.boardId))];
  const listIds = [...new Set(cards.map((c) => c.listId))];
  const [boards, lists] = await Promise.all([
    (service as any).boardRepo.find({ where: { id: In(boardIds), tenantId } }),
    (service as any).listRepo.find({ where: { id: In(listIds), tenantId } }),
  ]);
  const boardMap = new Map(boards.map((b) => [b.id, b.title]));
  const listMap = new Map(lists.map((l) => [l.id, l.title]));

  return cards.map((c) => ({ ...c, boardTitle: boardMap.get(c.boardId) ?? '', listTitle: listMap.get(c.listId) ?? '' })) as any;
}
