/**
 * lists — extracted from KanbanService.
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

// @ts-ignore
export async function createList_helper(service: KanbanService, tenantId: string, boardId: string, dto: CreateListDto): Promise<KanbanListEntity> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  const resolvedBoardId = board.id;
  const maxPos = await (service as any).listRepo.maximum('position', { boardId: resolvedBoardId, tenantId }) ?? -1;
  const list = (service as any).listRepo.create({ ...dto, boardId: resolvedBoardId, tenantId, position: dto.position ?? maxPos + 1 });
  return (service as any).listRepo.save(list);
}

// @ts-ignore
export async function updateList_helper(service: KanbanService, tenantId: string, listId: string, dto: UpdateListDto): Promise<KanbanListEntity> {
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('List not found');
  Object.assign(list, dto);
  return (service as any).listRepo.save(list);
}

export async function deleteList_helper(service: KanbanService, tenantId: string, listId: string): Promise<void> {
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('List not found');
  await (service as any).cardRepo.delete({ listId, tenantId });
  await (service as any).listRepo.remove(list);
}

// @ts-ignore
export async function reorderLists_helper(service: KanbanService, tenantId: string, boardId: string, dto: ReorderListsDto): Promise<void> {
  // boardId may be a slug — resolve to UUID so WHERE clause matches the stored value
  const resolvedBoardId = (service as any).isUUID(boardId)
    ? boardId
    : (await (service as any).boardRepo.findOne({ where: { slug: boardId, tenantId } }))?.id ?? boardId;
  await (service as any).dataSource.transaction(async (em) => {
    for (let i = 0; i < dto.listIds.length; i++) {
      await em.update(KanbanListEntity, { id: dto.listIds[i], boardId: resolvedBoardId, tenantId }, { position: i });
    }
  });
}

export async function copyList_helper(service: KanbanService, tenantId: string, listId: string): Promise<KanbanListEntity & { cards: KanbanCardEntity[] }> {
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('List not found');
  const cards = await (service as any).cardRepo.find({
    where: { listId, tenantId, isArchived: false },
    order: { position: 'ASC' },
  });

  const maxPos = await (service as any).listRepo.maximum('position', { boardId: list.boardId, tenantId }) ?? -1;
  const newList = (service as any).listRepo.create({
    title: `${list.title} (cópia)`,
    boardId: list.boardId,
    color: list.color,
    wipLimit: list.wipLimit,
    tenantId,
    position: maxPos + 1,
  });
  const savedList = await (service as any).listRepo.save(newList);

  const newCards = await Promise.all(
    cards.map((card, i) =>
      (service as any).cardRepo.save(
        (service as any).cardRepo.create({
          title: card.title,
          description: card.description,
          position: i,
          labels: card.labels,
          checklist: card.checklist,
          checklists: card.checklists,
          attachments: card.attachments,
          memberIds: card.memberIds,
          dueDate: card.dueDate,
          startDate: card.startDate,
          coverColor: card.coverColor,
          coverImageUrl: card.coverImageUrl,
          coverAttachmentId: card.coverAttachmentId,
          listId: savedList.id,
          boardId: savedList.boardId,
          tenantId,
        }),
      ),
    ),
  );

  return { ...savedList, cards: newCards };
}

export async function clearCompleted_helper(service: KanbanService, tenantId: string, listId: string): Promise<void> {
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('List not found');
  const cards = await (service as any).cardRepo.find({ where: { listId, tenantId, isArchived: false } });
  await Promise.all(
    cards
      .filter((card) => card.checklists?.some((g) => g.items.some((i) => i.done)))
      .map((card) => {
        card.checklists = card.checklists.map((g) => ({ ...g, items: g.items.filter((i) => !i.done) }));
        return (service as any).cardRepo.save(card);
      }),
  );
}

export async function restoreList_helper(service: KanbanService, tenantId: string, listId: string): Promise<KanbanListEntity> {
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('List not found');
  list.isArchived = false;
  return (service as any).listRepo.save(list);
}
