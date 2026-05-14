/**
 * boards — extracted from KanbanService.
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

export async function listBoards_helper(service: KanbanService, tenantId: string, userId?: string): Promise<(KanbanBoardEntity & { isStarred: boolean })[]> {
  const boards = await (service as any).boardRepo.find({
    where: { tenantId, isArchived: false, isTemplate: false },
    order: { createdAt: 'DESC' },
  });
  if (!userId) return boards.map((b) => ({ ...b, isStarred: false }));
  const stars = await (service as any).starRepo.find({ where: { userId, tenantId } });
  const starredIds = new Set(stars.map((s) => s.boardId));
  return boards.map((b) => ({ ...b, isStarred: starredIds.has(b.id) }));
}

export async function listTemplates_helper(service: KanbanService, tenantId: string): Promise<KanbanBoardEntity[]> {
  return (service as any).boardRepo.find({ where: { tenantId, isTemplate: true, isArchived: false }, order: { createdAt: 'DESC' } });
}

// @ts-ignore
export async function createBoard_helper(service: KanbanService, tenantId: string, ownerId: string, dto: CreateBoardDto): Promise<KanbanBoardEntity & { isStarred: boolean }> {
  const initialMembers: KanbanBoardMember[] = ownerId
    ? [{ id: ownerId, name: 'Você', avatarColor: '#579dff' }]
    : [];
  // If creating from template, duplicate it
  if (dto.templateId) {
    const tmpl = await (service as any).boardRepo.findOne({ where: { id: dto.templateId, tenantId, isTemplate: true } });
    if (tmpl) {
      const dup = await (service as any).duplicateBoard(tenantId, tmpl.id, ownerId);
      await (service as any).boardRepo.update({ id: dup.id, tenantId }, { title: dto.title || tmpl.title, isTemplate: false, workspaceId: dto.workspaceId ?? null });
      const updated = await (service as any).boardRepo.findOne({ where: { id: dup.id, tenantId } }) as KanbanBoardEntity;
      return { ...updated, isStarred: false };
    }
  }
  const board = (service as any).boardRepo.create({
    ...dto,
    tenantId,
    ownerId,
    color: dto.color ?? '#3b82f6',
    members: initialMembers,
    workspaceId: dto.workspaceId ?? null,
  });
  const saved = await (service as any).boardRepo.save(board);
  saved.slug = await (service as any).buildUniqueSlug(tenantId, saved.title);
  const final = await (service as any).boardRepo.save(saved);
  return { ...final, isStarred: false };
}

export async function getBoard_helper(service: KanbanService, tenantId: string, boardId: string): Promise<KanbanBoardEntity & { lists: (KanbanListEntity & { cards: (KanbanCardEntity & { commentCount: number })[] })[] }> {
  const where = (service as any).isUUID(boardId)
    ? { id: boardId, tenantId }
    : { slug: boardId, tenantId };
  const board = await (service as any).boardRepo.findOne({ where });
  if (!board) throw new NotFoundException('Board not found');

  const lists = await (service as any).listRepo.find({
    where: { boardId: board.id, tenantId, isArchived: false },
    order: { position: 'ASC' },
  });

  const cards = await (service as any).cardRepo.find({
    where: { boardId: board.id, tenantId, isArchived: false },
    order: { position: 'ASC' },
  });

  // Fetch comment counts for all cards in a single query
  const commentCounts = await (service as any).activityRepo
    .createQueryBuilder('a')
    .select('a.card_id', 'cardId')
    .addSelect('COUNT(a.id)', 'count')
    .where('a.board_id = :boardId', { boardId: board.id })
    .andWhere('a.tenant_id = :tenantId', { tenantId })
    .andWhere("a.type = 'comment'")
    .groupBy('a.card_id')
    .getRawMany();

  const commentCountMap = new Map<string, number>(
    commentCounts.map((r) => [r.cardId, parseInt(r.count) || 0]),
  );

  const listsWithCards = lists.map((list) => ({
    ...list,
    cards: cards
      .filter((c) => c.listId === list.id)
      .map((c) => ({ ...c, commentCount: commentCountMap.get(c.id) ?? 0 })),
  }));

  return { ...board, lists: listsWithCards } as any;
}

// @ts-ignore
export async function updateBoard_helper(service: KanbanService, tenantId: string, boardId: string, dto: UpdateBoardDto): Promise<KanbanBoardEntity> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  Object.assign(board, dto);
  if (dto.title !== undefined) {
    board.slug = await (service as any).buildUniqueSlug(tenantId, board.title, board.id);
  }
  if (dto.members !== undefined) {
    board.members = (dto.members || []).filter((member) => !!member?.id && !!member?.name);
    const validMemberIds = new Set(board.members.map((member) => member.id));
    const cards = await (service as any).cardRepo.find({ where: { boardId: board.id, tenantId } });
    if (cards.length > 0) {
      await (service as any).dataSource.transaction(async (em) => {
        for (const card of cards) {
          card.memberIds = (card.memberIds || []).filter((memberId) => validMemberIds.has(memberId));
          await em.save(KanbanCardEntity, card);
        }
      });
    }
  }
  return (service as any).boardRepo.save(board);
}

export async function deleteBoard_helper(service: KanbanService, tenantId: string, boardId: string): Promise<void> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  await (service as any).cardRepo.delete({ boardId: board.id, tenantId });
  await (service as any).listRepo.delete({ boardId: board.id, tenantId });
  await (service as any).boardRepo.remove(board);
  (service as any).eventEmitter.emit('kanban.board.deleted', { boardId: board.id, tenantId });
}

export async function duplicateBoard_helper(service: KanbanService, tenantId: string, boardId: string, ownerId: string): Promise<KanbanBoardEntity & { lists: (KanbanListEntity & { cards: KanbanCardEntity[] })[] }> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');

  const lists = await (service as any).listRepo.find({
    where: { boardId: board.id, tenantId, isArchived: false },
    order: { position: 'ASC' },
  });

  const newBoard = (service as any).boardRepo.create({
    title: `${board.title} (cópia)`,
    description: board.description,
    color: board.color,
    backgroundColor: board.backgroundColor,
    boardLabels: board.boardLabels,
    automationRules: board.automationRules,
    members: board.members,
    tenantId,
    ownerId,
  });
  const savedBoard = await (service as any).boardRepo.save(newBoard);
  savedBoard.slug = await (service as any).buildUniqueSlug(tenantId, savedBoard.title);
  await (service as any).boardRepo.save(savedBoard);

  const newLists: (KanbanListEntity & { cards: KanbanCardEntity[] })[] = [];
  for (const list of lists) {
    const cards = await (service as any).cardRepo.find({
      where: { listId: list.id, tenantId, isArchived: false },
      order: { position: 'ASC' },
    });

    const newList = (service as any).listRepo.create({
      title: list.title,
      boardId: savedBoard.id,
      color: list.color,
      wipLimit: list.wipLimit,
      tenantId,
      position: list.position,
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
            checklists: card.checklists,
            memberIds: card.memberIds,
            dueDate: card.dueDate,
            startDate: card.startDate,
            coverColor: card.coverColor,
            listId: savedList.id,
            boardId: savedBoard.id,
            tenantId,
          }),
        ),
      ),
    );
    newLists.push({ ...savedList, cards: newCards });
  }

  return { ...savedBoard, lists: newLists } as any;
}

export async function starBoard_helper(service: KanbanService, tenantId: string, boardId: string, userId: string): Promise<void> {
  const board = await (service as any).boardRepo.findOne({ where: { id: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  const existing = await (service as any).starRepo.findOne({ where: { boardId, userId, tenantId } });
  if (!existing) {
    await (service as any).starRepo.save((service as any).starRepo.create({ boardId, userId, tenantId }));
  }
}

export async function unstarBoard_helper(service: KanbanService, tenantId: string, boardId: string, userId: string): Promise<void> {
  await (service as any).starRepo.delete({ boardId, userId, tenantId });
}

export async function generateInviteToken_helper(service: KanbanService, tenantId: string, boardId: string): Promise<{ token: string }> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  const token = randomUUID();
  await (service as any).boardRepo.update({ id: board.id, tenantId }, { inviteToken: token });
  return { token };
}

export async function getBoardByInviteToken_helper(service: KanbanService, token: string): Promise<{ id: string; title: string; color: string; memberCount: number }> {
  const board = await (service as any).boardRepo.findOne({ where: { inviteToken: token } });
  if (!board) throw new NotFoundException('Invite link not found or expired');
  return { id: board.id, title: board.title, color: board.color, memberCount: board.members.length };
}

export async function joinBoardByToken_helper(service: KanbanService, tenantId: string, token: string, userId: string, userName: string): Promise<KanbanBoardEntity> {
  const board = await (service as any).boardRepo.findOne({ where: { inviteToken: token, tenantId } });
  if (!board) throw new NotFoundException('Invite link not found or expired');
  const alreadyMember = board.members.some((m) => m.id === userId);
  if (!alreadyMember) {
    const colors = ['#579dff', '#f87168', '#4bce97', '#a254f7', '#f5cd47'];
    board.members = [...board.members, { id: userId, name: userName, avatarColor: colors[board.members.length % colors.length] }];
    await (service as any).boardRepo.save(board);
  }
  return board;
}

export async function revokeInviteToken_helper(service: KanbanService, tenantId: string, boardId: string): Promise<void> {
  await (service as any).boardRepo.update({ id: boardId, tenantId }, { inviteToken: null });
}

export async function inviteByEmail_helper(service: KanbanService, tenantId: string, boardId: string, email: string, inviterName: string): Promise<{ sent: boolean }> {
  const board = await (service as any).boardRepo.findOne({ where: { id: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  let token = board.inviteToken;
  if (!token) {
    token = randomUUID();
    await (service as any).boardRepo.update({ id: boardId, tenantId }, { inviteToken: token });
  }
  const inviteLink = `${process.env.FRONTEND_URL ?? 'https://www.zielinski.dev.br'}/kanban/join/${token}`;
  await (service as any).kanbanMailService.sendInviteEmail({
    recipientEmail: email,
    boardTitle: board.title,
    inviteLink,
    inviterName,
  });
  return { sent: true };
}

export async function toggleWatchBoard_helper(service: KanbanService, tenantId: string, boardId: string, userId: string): Promise<{ watching: boolean }> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  const watchers = board.watchedBy || [];
  const idx = watchers.indexOf(userId);
  const watching = idx === -1;
  board.watchedBy = watching ? [...watchers, userId] : watchers.filter((id) => id !== userId);
  await (service as any).boardRepo.save(board);
  return { watching };
}

export async function saveAsTemplate_helper(service: KanbanService, tenantId: string, boardId: string, ownerId: string): Promise<KanbanBoardEntity> {
  const board = await (service as any).boardRepo.findOne({ where: (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');
  const dup = await (service as any).duplicateBoard(tenantId, boardId, ownerId);
  await (service as any).boardRepo.update({ id: dup.id, tenantId }, { title: `[Template] ${board.title}`, isTemplate: true });
  return (service as any).boardRepo.findOne({ where: { id: dup.id, tenantId } }) as Promise<KanbanBoardEntity>;
}

export async function listBoardActivities_helper(service: KanbanService, tenantId: string, boardId: string): Promise<KanbanCardActivityEntity[]> {
  const where = (service as any).isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId };
  const board = await (service as any).boardRepo.findOne({ where });
  if (!board) throw new NotFoundException('Board not found');
  return (service as any).activityRepo.find({
    where: { boardId: board.id, tenantId },
    order: { createdAt: 'DESC' },
    take: 100,
  });
}
