// src/kanban/kanban.service.ts
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
import {
  CreateBoardDto, UpdateBoardDto, CreateListDto, UpdateListDto, ReorderListsDto,
  CreateCardDto, UpdateCardDto, MoveCardDto, MoveCardToBoardDto, CreateActivityDto, UpdateActivityDto,
  CreateWorkspaceDto, UpdateWorkspaceDto, CreatePowerUpDto, UpdatePowerUpDto, AdvancedSearchDto,
  CreateTimeLogDto, UpdateTimeLogDto, CreateHourRequestDto,
} from './dto/kanban.dto';
import { KanbanMailService } from './kanban-mail.service';
import { KanbanGateway } from './kanban.gateway';
import { KanbanCardEventPayload, KanbanEventKey } from './power-ups/types';
import { MultiProviderAiService } from '../api-config/services/multi-provider-ai.service';
import { ApiConfigService } from '../api-config/api-config.service';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  listTimeLogs_helper,
  addTimeLog_helper,
  updateTimeLog_helper,
  deleteTimeLog_helper,
  listHourRequests_helper,
  createHourRequest_helper,
  cancelHourRequest_helper,
  handleApprovalKanbanResolved_helper,
} from './kanban-time-logs';

import {
  fireUpdateCardAutomations_helper,
  executeAutomationRules_helper,
  checkAndEmitUnblockedCards_helper,
  areAllBlockersResolved_helper,
  parseButlerRule_helper,
} from './kanban-automations';

import {
  createCard_helper,
  updateCard_helper,
  moveCard_helper,
  moveCardToBoard_helper,
  duplicateCard_helper,
  deleteCard_helper,
  restoreCard_helper,
  linkCards_helper,
  unlinkCard_helper,
  getBatchCards_helper,
  addBlocker_helper,
  removeBlocker_helper,
  convertChecklistItemToCard_helper,
  searchCards_helper,
  advancedSearch_helper,
  snoozeCard_helper,
  unsnoozeCard_helper,
  voiceFormat_helper,
  formatDescription_helper,
  decomposeCard_helper,
} from './kanban-cards';

import {
  slugify_helper,
  buildUniqueSlug_helper,
  isUUID_helper,
  buildCardPayload_helper,
} from './kanban-helpers';


@Injectable()
export class KanbanService {
  private readonly logger = new Logger(KanbanService.name);

  constructor(
    @InjectRepository(KanbanBoardEntity) private boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanListEntity) private listRepo: Repository<KanbanListEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanCardActivityEntity) private activityRepo: Repository<KanbanCardActivityEntity>,
    @InjectRepository(KanbanNotificationEntity) private notifRepo: Repository<KanbanNotificationEntity>,
    @InjectRepository(KanbanWorkspaceEntity) private workspaceRepo: Repository<KanbanWorkspaceEntity>,
    @InjectRepository(KanbanBoardStarEntity) private starRepo: Repository<KanbanBoardStarEntity>,
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanTimeLogEntity) private timeLogRepo: Repository<KanbanTimeLogEntity>,
    @InjectRepository(KanbanHourRequestEntity) private hourRequestRepo: Repository<KanbanHourRequestEntity>,
    @InjectRepository(KanbanCardHistoryEntity) private cardHistoryRepo: Repository<KanbanCardHistoryEntity>,
    @InjectRepository(ApprovalEntity) private approvalRepo: Repository<ApprovalEntity>,
    @InjectRepository(ApprovalHistoryEntity) private approvalHistoryRepo: Repository<ApprovalHistoryEntity>,
    private dataSource: DataSource,
    private kanbanMailService: KanbanMailService,
    private eventEmitter: EventEmitter2,
    private readonly gateway: KanbanGateway,
    private multiProviderAiService: MultiProviderAiService,
    private apiConfigService: ApiConfigService,
  ) {}

  // ── SLUG HELPER ───────────────────────────────────────────────────────────

  private slugify(title: string): string {
    return slugify_helper(this, title);
  }

  private async buildUniqueSlug(tenantId: string, title: string, excludeId?: string): Promise<string> {
    return await buildUniqueSlug_helper(this, tenantId, title, excludeId);
  }

  private isUUID(value: string): boolean {
    return isUUID_helper(this, value);
  }

  private buildCardPayload(
    eventType: KanbanEventKey,
    card: KanbanCardEntity,
    actorId: string,
    actorName: string,
    extra?: Record<string, unknown>,
  ): KanbanCardEventPayload {
    return buildCardPayload_helper(this, eventType, card, actorId, actorName, extra);
  }

  // ── BOARDS ────────────────────────────────────────────────────────────────

  async listBoards(tenantId: string, userId?: string): Promise<(KanbanBoardEntity & { isStarred: boolean })[]> {
    const boards = await this.boardRepo.find({
      where: { tenantId, isArchived: false, isTemplate: false },
      order: { createdAt: 'DESC' },
    });
    if (!userId) return boards.map((b) => ({ ...b, isStarred: false }));
    const stars = await this.starRepo.find({ where: { userId, tenantId } });
    const starredIds = new Set(stars.map((s) => s.boardId));
    return boards.map((b) => ({ ...b, isStarred: starredIds.has(b.id) }));
  }

  async listTemplates(tenantId: string): Promise<KanbanBoardEntity[]> {
    return this.boardRepo.find({ where: { tenantId, isTemplate: true, isArchived: false }, order: { createdAt: 'DESC' } });
  }

  async createBoard(tenantId: string, ownerId: string, dto: CreateBoardDto): Promise<KanbanBoardEntity & { isStarred: boolean }> {
    const initialMembers: KanbanBoardMember[] = ownerId
      ? [{ id: ownerId, name: 'Você', avatarColor: '#579dff' }]
      : [];
    // If creating from template, duplicate it
    if (dto.templateId) {
      const tmpl = await this.boardRepo.findOne({ where: { id: dto.templateId, tenantId, isTemplate: true } });
      if (tmpl) {
        const dup = await this.duplicateBoard(tenantId, tmpl.id, ownerId);
        await this.boardRepo.update({ id: dup.id, tenantId }, { title: dto.title || tmpl.title, isTemplate: false, workspaceId: dto.workspaceId ?? null });
        const updated = await this.boardRepo.findOne({ where: { id: dup.id, tenantId } }) as KanbanBoardEntity;
        return { ...updated, isStarred: false };
      }
    }
    const board = this.boardRepo.create({
      ...dto,
      tenantId,
      ownerId,
      color: dto.color ?? '#3b82f6',
      members: initialMembers,
      workspaceId: dto.workspaceId ?? null,
    });
    const saved = await this.boardRepo.save(board);
    saved.slug = await this.buildUniqueSlug(tenantId, saved.title);
    const final = await this.boardRepo.save(saved);
    return { ...final, isStarred: false };
  }

  async getBoard(tenantId: string, boardId: string): Promise<KanbanBoardEntity & { lists: (KanbanListEntity & { cards: (KanbanCardEntity & { commentCount: number })[] })[] }> {
    const where = this.isUUID(boardId)
      ? { id: boardId, tenantId }
      : { slug: boardId, tenantId };
    const board = await this.boardRepo.findOne({ where });
    if (!board) throw new NotFoundException('Board not found');

    const lists = await this.listRepo.find({
      where: { boardId: board.id, tenantId, isArchived: false },
      order: { position: 'ASC' },
    });

    const cards = await this.cardRepo.find({
      where: { boardId: board.id, tenantId, isArchived: false },
      order: { position: 'ASC' },
    });

    // Fetch comment counts for all cards in a single query
    const commentCounts = await this.activityRepo
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

  async updateBoard(tenantId: string, boardId: string, dto: UpdateBoardDto): Promise<KanbanBoardEntity> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    Object.assign(board, dto);
    if (dto.title !== undefined) {
      board.slug = await this.buildUniqueSlug(tenantId, board.title, board.id);
    }
    if (dto.members !== undefined) {
      board.members = (dto.members || []).filter((member) => !!member?.id && !!member?.name);
      const validMemberIds = new Set(board.members.map((member) => member.id));
      const cards = await this.cardRepo.find({ where: { boardId: board.id, tenantId } });
      if (cards.length > 0) {
        await this.dataSource.transaction(async (em) => {
          for (const card of cards) {
            card.memberIds = (card.memberIds || []).filter((memberId) => validMemberIds.has(memberId));
            await em.save(KanbanCardEntity, card);
          }
        });
      }
    }
    return this.boardRepo.save(board);
  }

  async deleteBoard(tenantId: string, boardId: string): Promise<void> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    await this.cardRepo.delete({ boardId: board.id, tenantId });
    await this.listRepo.delete({ boardId: board.id, tenantId });
    await this.boardRepo.remove(board);
    this.eventEmitter.emit('kanban.board.deleted', { boardId: board.id, tenantId });
  }

  async duplicateBoard(tenantId: string, boardId: string, ownerId: string): Promise<KanbanBoardEntity & { lists: (KanbanListEntity & { cards: KanbanCardEntity[] })[] }> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');

    const lists = await this.listRepo.find({
      where: { boardId: board.id, tenantId, isArchived: false },
      order: { position: 'ASC' },
    });

    const newBoard = this.boardRepo.create({
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
    const savedBoard = await this.boardRepo.save(newBoard);
    savedBoard.slug = await this.buildUniqueSlug(tenantId, savedBoard.title);
    await this.boardRepo.save(savedBoard);

    const newLists: (KanbanListEntity & { cards: KanbanCardEntity[] })[] = [];
    for (const list of lists) {
      const cards = await this.cardRepo.find({
        where: { listId: list.id, tenantId, isArchived: false },
        order: { position: 'ASC' },
      });

      const newList = this.listRepo.create({
        title: list.title,
        boardId: savedBoard.id,
        color: list.color,
        wipLimit: list.wipLimit,
        tenantId,
        position: list.position,
      });
      const savedList = await this.listRepo.save(newList);

      const newCards = await Promise.all(
        cards.map((card, i) =>
          this.cardRepo.save(
            this.cardRepo.create({
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

  // ── LISTS ─────────────────────────────────────────────────────────────────

  async createList(tenantId: string, boardId: string, dto: CreateListDto): Promise<KanbanListEntity> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    const resolvedBoardId = board.id;
    const maxPos = await this.listRepo.maximum('position', { boardId: resolvedBoardId, tenantId }) ?? -1;
    const list = this.listRepo.create({ ...dto, boardId: resolvedBoardId, tenantId, position: dto.position ?? maxPos + 1 });
    return this.listRepo.save(list);
  }

  async updateList(tenantId: string, listId: string, dto: UpdateListDto): Promise<KanbanListEntity> {
    const list = await this.listRepo.findOne({ where: { id: listId, tenantId } });
    if (!list) throw new NotFoundException('List not found');
    Object.assign(list, dto);
    return this.listRepo.save(list);
  }

  async deleteList(tenantId: string, listId: string): Promise<void> {
    const list = await this.listRepo.findOne({ where: { id: listId, tenantId } });
    if (!list) throw new NotFoundException('List not found');
    await this.cardRepo.delete({ listId, tenantId });
    await this.listRepo.remove(list);
  }

  async reorderLists(tenantId: string, boardId: string, dto: ReorderListsDto): Promise<void> {
    // boardId may be a slug — resolve to UUID so WHERE clause matches the stored value
    const resolvedBoardId = this.isUUID(boardId)
      ? boardId
      : (await this.boardRepo.findOne({ where: { slug: boardId, tenantId } }))?.id ?? boardId;
    await this.dataSource.transaction(async (em) => {
      for (let i = 0; i < dto.listIds.length; i++) {
        await em.update(KanbanListEntity, { id: dto.listIds[i], boardId: resolvedBoardId, tenantId }, { position: i });
      }
    });
  }

  // ── CARDS ─────────────────────────────────────────────────────────────────

  async createCard(tenantId: string, listId: string, dto: CreateCardDto): Promise<KanbanCardEntity> {
    return await createCard_helper(this, tenantId, listId, dto);
  }

  async updateCard(tenantId: string, cardId: string, dto: UpdateCardDto): Promise<KanbanCardEntity> {
    return await updateCard_helper(this, tenantId, cardId, dto);
  }

  /** Fire automation rules triggered by updateCard: checklist_completed, label_added, member_assigned */
  private async fireUpdateCardAutomations(
    tenantId: string,
    card: KanbanCardEntity,
    context: {
      prevMemberIds: Set<string>;
      prevLabelColors: Set<string>;
      prevChecklists: any[];
      addedMemberIds: string[];
      dtoLabels?: any[];
      dtoChecklists?: any[];
    },
  ): Promise<void> {
    return await fireUpdateCardAutomations_helper(this, tenantId, card, context);
  }

  /** Core helper: execute automation rules for a given trigger type on a card */
  private async executeAutomationRules(
    tenantId: string,
    card: KanbanCardEntity,
    board: KanbanBoardEntity,
    triggerType: string,
    triggerContext: Record<string, any> = {},
  ): Promise<void> {
    return await executeAutomationRules_helper(this, tenantId, card, board, triggerType, triggerContext);
  }

  async moveCard(tenantId: string, cardId: string, dto: MoveCardDto): Promise<KanbanCardEntity> {
    return await moveCard_helper(this, tenantId, cardId, dto);
  }

  /** C4: After a card is archived or moved, check if other cards that depend on it are now fully unblocked */
  private async checkAndEmitUnblockedCards(tenantId: string, resolvedCardId: string, boardId: string): Promise<void> {
    return await checkAndEmitUnblockedCards_helper(this, tenantId, resolvedCardId, boardId);
  }

  private async areAllBlockersResolved(tenantId: string, blockerIds: string[], lastListId: string): Promise<boolean> {
    return await areAllBlockersResolved_helper(this, tenantId, blockerIds, lastListId);
  }

  async moveCardToBoard(tenantId: string, cardId: string, dto: MoveCardToBoardDto): Promise<KanbanCardEntity> {
    return await moveCardToBoard_helper(this, tenantId, cardId, dto);
  }

  async duplicateCard(tenantId: string, cardId: string): Promise<KanbanCardEntity> {
    return await duplicateCard_helper(this, tenantId, cardId);
  }

  async deleteCard(tenantId: string, cardId: string): Promise<void> {
    return await deleteCard_helper(this, tenantId, cardId);
  }

  // ── ARCHIVED ITEMS ────────────────────────────────────────────────────────

  async getArchivedItems(tenantId: string, boardId: string): Promise<{ cards: KanbanCardEntity[]; lists: KanbanListEntity[] }> {
    const where = this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId };
    const board = await this.boardRepo.findOne({ where });
    if (!board) throw new NotFoundException('Board not found');

    const [cards, lists] = await Promise.all([
      this.cardRepo.find({
        where: { boardId: board.id, tenantId, isArchived: true },
        order: { updatedAt: 'DESC' },
      }),
      this.listRepo.find({
        where: { boardId: board.id, tenantId, isArchived: true },
        order: { updatedAt: 'DESC' },
      }),
    ]);

    return { cards, lists };
  }

  async restoreCard(tenantId: string, cardId: string): Promise<KanbanCardEntity> {
    return await restoreCard_helper(this, tenantId, cardId);
  }

  async restoreList(tenantId: string, listId: string): Promise<KanbanListEntity> {
    const list = await this.listRepo.findOne({ where: { id: listId, tenantId } });
    if (!list) throw new NotFoundException('List not found');
    list.isArchived = false;
    return this.listRepo.save(list);
  }

  // ── ACTIVITIES ────────────────────────────────────────────────────────────

  async addActivity(
    tenantId: string,
    cardId: string,
    userId: string,
    dto: CreateActivityDto,
  ): Promise<KanbanCardActivityEntity> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');
    const activity = this.activityRepo.create({
      cardId,
      boardId: card.boardId,
      tenantId,
      userId: userId || null,
      userName: dto.userName ?? null,
      type: (dto.type ?? 'comment') as ActivityType,
      text: dto.text,
    });

    const saved = await this.activityRepo.save(activity);

    if (saved.type === 'comment') {
      this.eventEmitter.emit('kanban.card.commented', this.buildCardPayload(
        'card.commented', card, userId || '', dto.userName ?? '',
      ));
    }

    // Create mention notifications
    if (saved.type === 'comment') {
      const mentions = dto.text.match(/@(\w[\w\s]{0,20})/g);
      if (mentions) {
        const board = await this.boardRepo.findOne({ where: { id: card.boardId, tenantId } });
        if (board?.members) {
          const mentionedNames = mentions.map((m) => m.slice(1).trim().toLowerCase());
          const mentionedMembers = board.members.filter((m) =>
            mentionedNames.some((mn) => m.name.toLowerCase().startsWith(mn)),
          );
          for (const member of mentionedMembers) {
            if (member.id !== userId) {
              this.notifRepo.save(
                this.notifRepo.create({
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
                this.kanbanMailService.sendMentionEmail({
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
      const board = await this.boardRepo.findOne({ where: { id: card.boardId, tenantId } });
      for (const watcherId of card.watchedBy) {
        if (watcherId !== userId) {
          this.notifRepo.save(this.notifRepo.create({
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
            this.kanbanMailService.sendWatcherCommentEmail({
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
      this.eventEmitter.emit('kanban.card.commented', {
        cardId, boardId: card.boardId, tenantId, text: dto.text, userName: dto.userName ?? 'Usuário',
      });
    }

    this.gateway.emit(tenantId, saved.boardId, 'activity:added', { cardId: saved.cardId, activity: saved });
    return saved;
  }

  async listActivities(tenantId: string, cardId: string): Promise<KanbanCardActivityEntity[]> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');
    return this.activityRepo.find({
      where: { cardId, tenantId },
      order: { createdAt: 'ASC' },
    });
  }

  async updateActivity(tenantId: string, activityId: string, userId: string, dto: UpdateActivityDto): Promise<KanbanCardActivityEntity> {
    const activity = await this.activityRepo.findOne({ where: { id: activityId, tenantId } });
    if (!activity) throw new NotFoundException('Activity not found');
    if (activity.type !== 'comment') throw new ForbiddenException('Only comments can be edited');
    if (activity.userId && activity.userId !== userId) throw new ForbiddenException('Cannot edit another user comment');
    activity.text = dto.text;
    return this.activityRepo.save(activity);
  }

  async deleteActivity(tenantId: string, activityId: string, userId: string): Promise<void> {
    const activity = await this.activityRepo.findOne({ where: { id: activityId, tenantId } });
    if (!activity) throw new NotFoundException('Activity not found');
    if (activity.type !== 'comment') throw new ForbiddenException('Only comments can be deleted');
    if (activity.userId && activity.userId !== userId) throw new ForbiddenException('Cannot delete another user comment');
    await this.activityRepo.remove(activity);
  }

  async listBoardActivities(tenantId: string, boardId: string): Promise<KanbanCardActivityEntity[]> {
    const where = this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId };
    const board = await this.boardRepo.findOne({ where });
    if (!board) throw new NotFoundException('Board not found');
    return this.activityRepo.find({
      where: { boardId: board.id, tenantId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async logEvent(tenantId: string, cardId: string, boardId: string, text: string): Promise<void> {
    const activity = this.activityRepo.create({ cardId, boardId, tenantId, userId: null, userName: null, type: 'event', text });
    await this.activityRepo.save(activity);
  }

  // ── LIST COPY ─────────────────────────────────────────────────────────────

  async copyList(tenantId: string, listId: string): Promise<KanbanListEntity & { cards: KanbanCardEntity[] }> {
    const list = await this.listRepo.findOne({ where: { id: listId, tenantId } });
    if (!list) throw new NotFoundException('List not found');
    const cards = await this.cardRepo.find({
      where: { listId, tenantId, isArchived: false },
      order: { position: 'ASC' },
    });

    const maxPos = await this.listRepo.maximum('position', { boardId: list.boardId, tenantId }) ?? -1;
    const newList = this.listRepo.create({
      title: `${list.title} (cópia)`,
      boardId: list.boardId,
      color: list.color,
      wipLimit: list.wipLimit,
      tenantId,
      position: maxPos + 1,
    });
    const savedList = await this.listRepo.save(newList);

    const newCards = await Promise.all(
      cards.map((card, i) =>
        this.cardRepo.save(
          this.cardRepo.create({
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

  // ── CLEAR COMPLETED ───────────────────────────────────────────────────────

  async clearCompleted(tenantId: string, listId: string): Promise<void> {
    const list = await this.listRepo.findOne({ where: { id: listId, tenantId } });
    if (!list) throw new NotFoundException('List not found');
    const cards = await this.cardRepo.find({ where: { listId, tenantId, isArchived: false } });
    await Promise.all(
      cards
        .filter((card) => card.checklists?.some((g) => g.items.some((i) => i.done)))
        .map((card) => {
          card.checklists = card.checklists.map((g) => ({ ...g, items: g.items.filter((i) => !i.done) }));
          return this.cardRepo.save(card);
        }),
    );
  }

  // ── CARD MOVEMENT HISTORY (C2) ───────────────────────────────────────────

  async getCardHistory(tenantId: string, cardId: string): Promise<KanbanCardHistoryEntity[]> {
    return this.cardHistoryRepo.find({
      where: { cardId, tenantId },
      order: { movedAt: 'DESC' },
    });
  }

  // ── CARD LINKS (C3) ───────────────────────────────────────────────────────

  async linkCards(tenantId: string, cardId: string, targetCardId: string): Promise<void> {
    return await linkCards_helper(this, tenantId, cardId, targetCardId);
  }

  async unlinkCard(tenantId: string, cardId: string, targetCardId: string): Promise<void> {
    return await unlinkCard_helper(this, tenantId, cardId, targetCardId);
  }

  async getBatchCards(tenantId: string, ids: string[]): Promise<{ id: string; title: string; listTitle: string; boardTitle: string }[]> {
    return await getBatchCards_helper(this, tenantId, ids);
  }

  // ── CARD BLOCKING (C4) ───────────────────────────────────────────────────

  async addBlocker(tenantId: string, cardId: string, blockerCardId: string): Promise<KanbanCardEntity> {
    return await addBlocker_helper(this, tenantId, cardId, blockerCardId);
  }

  async removeBlocker(tenantId: string, cardId: string, blockerCardId: string): Promise<void> {
    return await removeBlocker_helper(this, tenantId, cardId, blockerCardId);
  }

  // ── CONVERT CHECKLIST ITEM TO CARD (C1) ──────────────────────────────────

  async convertChecklistItemToCard(
    tenantId: string,
    cardId: string,
    groupId: string,
    itemId: string,
    targetListId?: string,
  ): Promise<KanbanCardEntity> {
    return await convertChecklistItemToCard_helper(this, tenantId, cardId, groupId, itemId, targetListId);
  }

  // ── SEARCH ────────────────────────────────────────────────────────────────

  async searchCards(tenantId: string, query: string): Promise<(KanbanCardEntity & { boardTitle: string; listTitle: string })[]> {
    return await searchCards_helper(this, tenantId, query);
  }

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────

  async listNotifications(tenantId: string, userId: string): Promise<KanbanNotificationEntity[]> {
    return this.notifRepo.find({
      where: { tenantId, userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async markNotificationRead(tenantId: string, notifId: string, userId: string): Promise<void> {
    await this.notifRepo.update({ id: notifId, tenantId, userId }, { isRead: true });
  }

  async markAllNotificationsRead(tenantId: string, userId: string): Promise<void> {
    await this.notifRepo.update({ tenantId, userId, isRead: false }, { isRead: true });
  }

  // ── WORKSPACES (#34) ──────────────────────────────────────────────────────

  async listWorkspaces(tenantId: string): Promise<KanbanWorkspaceEntity[]> {
    return this.workspaceRepo.find({ where: { tenantId }, order: { createdAt: 'ASC' } });
  }

  async createWorkspace(tenantId: string, ownerId: string, dto: CreateWorkspaceDto): Promise<KanbanWorkspaceEntity> {
    const ws = this.workspaceRepo.create({ ...dto, tenantId, ownerId });
    return this.workspaceRepo.save(ws);
  }

  async updateWorkspace(tenantId: string, workspaceId: string, dto: UpdateWorkspaceDto): Promise<KanbanWorkspaceEntity> {
    const ws = await this.workspaceRepo.findOne({ where: { id: workspaceId, tenantId } });
    if (!ws) throw new NotFoundException('Workspace not found');
    Object.assign(ws, dto);
    return this.workspaceRepo.save(ws);
  }

  async deleteWorkspace(tenantId: string, workspaceId: string): Promise<void> {
    const ws = await this.workspaceRepo.findOne({ where: { id: workspaceId, tenantId } });
    if (!ws) throw new NotFoundException('Workspace not found');
    // Detach boards from this workspace
    await this.boardRepo.update({ workspaceId, tenantId }, { workspaceId: null });
    await this.workspaceRepo.remove(ws);
  }

  // ── BOARD STARS (#40) ─────────────────────────────────────────────────────

  async starBoard(tenantId: string, boardId: string, userId: string): Promise<void> {
    const board = await this.boardRepo.findOne({ where: { id: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    const existing = await this.starRepo.findOne({ where: { boardId, userId, tenantId } });
    if (!existing) {
      await this.starRepo.save(this.starRepo.create({ boardId, userId, tenantId }));
    }
  }

  async unstarBoard(tenantId: string, boardId: string, userId: string): Promise<void> {
    await this.starRepo.delete({ boardId, userId, tenantId });
  }

  // ── INVITE TOKEN (#36) ────────────────────────────────────────────────────

  async generateInviteToken(tenantId: string, boardId: string): Promise<{ token: string }> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    const token = randomUUID();
    await this.boardRepo.update({ id: board.id, tenantId }, { inviteToken: token });
    return { token };
  }

  async getBoardByInviteToken(token: string): Promise<{ id: string; title: string; color: string; memberCount: number }> {
    const board = await this.boardRepo.findOne({ where: { inviteToken: token } });
    if (!board) throw new NotFoundException('Invite link not found or expired');
    return { id: board.id, title: board.title, color: board.color, memberCount: board.members.length };
  }

  async joinBoardByToken(tenantId: string, token: string, userId: string, userName: string): Promise<KanbanBoardEntity> {
    const board = await this.boardRepo.findOne({ where: { inviteToken: token, tenantId } });
    if (!board) throw new NotFoundException('Invite link not found or expired');
    const alreadyMember = board.members.some((m) => m.id === userId);
    if (!alreadyMember) {
      const colors = ['#579dff', '#f87168', '#4bce97', '#a254f7', '#f5cd47'];
      board.members = [...board.members, { id: userId, name: userName, avatarColor: colors[board.members.length % colors.length] }];
      await this.boardRepo.save(board);
    }
    return board;
  }

  async revokeInviteToken(tenantId: string, boardId: string): Promise<void> {
    await this.boardRepo.update({ id: boardId, tenantId }, { inviteToken: null });
  }

  async inviteByEmail(tenantId: string, boardId: string, email: string, inviterName: string): Promise<{ sent: boolean }> {
    const board = await this.boardRepo.findOne({ where: { id: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    let token = board.inviteToken;
    if (!token) {
      token = randomUUID();
      await this.boardRepo.update({ id: boardId, tenantId }, { inviteToken: token });
    }
    const inviteLink = `${process.env.FRONTEND_URL ?? 'https://www.zielinski.dev.br'}/kanban/join/${token}`;
    await this.kanbanMailService.sendInviteEmail({
      recipientEmail: email,
      boardTitle: board.title,
      inviteLink,
      inviterName,
    });
    return { sent: true };
  }

  // ── WATCH CARD/BOARD (#37) ────────────────────────────────────────────────

  async toggleWatchBoard(tenantId: string, boardId: string, userId: string): Promise<{ watching: boolean }> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    const watchers = board.watchedBy || [];
    const idx = watchers.indexOf(userId);
    const watching = idx === -1;
    board.watchedBy = watching ? [...watchers, userId] : watchers.filter((id) => id !== userId);
    await this.boardRepo.save(board);
    return { watching };
  }

  async toggleWatchCard(tenantId: string, cardId: string, userId: string): Promise<{ watching: boolean }> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');
    const watchers = card.watchedBy || [];
    const idx = watchers.indexOf(userId);
    const watching = idx === -1;
    card.watchedBy = watching ? [...watchers, userId] : watchers.filter((id) => id !== userId);
    await this.cardRepo.save(card);
    return { watching };
  }

  // ── BOARD TEMPLATES (#39) ─────────────────────────────────────────────────

  async saveAsTemplate(tenantId: string, boardId: string, ownerId: string): Promise<KanbanBoardEntity> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    const dup = await this.duplicateBoard(tenantId, boardId, ownerId);
    await this.boardRepo.update({ id: dup.id, tenantId }, { title: `[Template] ${board.title}`, isTemplate: true });
    return this.boardRepo.findOne({ where: { id: dup.id, tenantId } }) as Promise<KanbanBoardEntity>;
  }

  // ── POWER-UPS (#44) ───────────────────────────────────────────────────────

  async listPowerUps(tenantId: string, boardId: string): Promise<KanbanPowerUpEntity[]> {
    return this.powerUpRepo.find({ where: { boardId, tenantId } });
  }

  async createPowerUp(tenantId: string, boardId: string, dto: CreatePowerUpDto): Promise<KanbanPowerUpEntity> {
    const board = await this.boardRepo.findOne({ where: this.isUUID(boardId) ? { id: boardId, tenantId } : { slug: boardId, tenantId } });
    if (!board) throw new NotFoundException('Board not found');
    const pu = this.powerUpRepo.create({ boardId, tenantId, type: dto.type, config: dto.config, enabled: true });
    return this.powerUpRepo.save(pu);
  }

  async updatePowerUp(tenantId: string, powerUpId: string, dto: UpdatePowerUpDto): Promise<KanbanPowerUpEntity> {
    const pu = await this.powerUpRepo.findOne({ where: { id: powerUpId, tenantId } });
    if (!pu) throw new NotFoundException('Power-up not found');
    Object.assign(pu, dto);
    return this.powerUpRepo.save(pu);
  }

  async deletePowerUp(tenantId: string, powerUpId: string): Promise<void> {
    const pu = await this.powerUpRepo.findOne({ where: { id: powerUpId, tenantId } });
    if (!pu) throw new NotFoundException('Power-up not found');
    await this.powerUpRepo.remove(pu);
  }

  // Slack notifications now handled by KanbanSlackPowerUpService via EventEmitter

  // ── ADVANCED SEARCH (#42) ─────────────────────────────────────────────────

  async advancedSearch(tenantId: string, dto: AdvancedSearchDto): Promise<(KanbanCardEntity & { boardTitle: string; listTitle: string })[]> {
    return await advancedSearch_helper(this, tenantId, dto);
  }

  // ── TIME LOGS ─────────────────────────────────────────────────────────────

  async listTimeLogs(tenantId: string, cardId: string): Promise<KanbanTimeLogEntity[]> {
    return await listTimeLogs_helper(this, tenantId, cardId);
  }

  async addTimeLog(tenantId: string, cardId: string, userId: string, dto: CreateTimeLogDto): Promise<KanbanTimeLogEntity> {
    return await addTimeLog_helper(this, tenantId, cardId, userId, dto);
  }

  async updateTimeLog(tenantId: string, logId: string, userId: string, dto: UpdateTimeLogDto): Promise<KanbanTimeLogEntity> {
    return await updateTimeLog_helper(this, tenantId, logId, userId, dto);
  }

  async deleteTimeLog(tenantId: string, logId: string, userId: string): Promise<void> {
    return await deleteTimeLog_helper(this, tenantId, logId, userId);
  }

  // ── HOUR REQUESTS ─────────────────────────────────────────────────────────

  async listHourRequests(tenantId: string, cardId: string): Promise<KanbanHourRequestEntity[]> {
    return await listHourRequests_helper(this, tenantId, cardId);
  }

  async createHourRequest(
    tenantId: string,
    cardId: string,
    userId: string,
    dto: CreateHourRequestDto,
  ): Promise<KanbanHourRequestEntity> {
    return await createHourRequest_helper(this, tenantId, cardId, userId, dto);
  }

  async cancelHourRequest(tenantId: string, requestId: string, userId: string): Promise<void> {
    return await cancelHourRequest_helper(this, tenantId, requestId, userId);
  }

  @OnEvent('approval.kanban.resolved')
  async handleApprovalKanbanResolved(payload: {
    approvalId: string;
    kanbanHourRequestId: string;
    decision: string;
    comments?: string;
    approvedById?: string;
  }): Promise<void> {
    return await handleApprovalKanbanResolved_helper(this, payload);
  }

  // ── CARD SNOOZE ──────────────────────────────────────────────────────────

  async snoozeCard(tenantId: string, cardId: string, until: string): Promise<KanbanCardEntity> {
    return await snoozeCard_helper(this, tenantId, cardId, until);
  }

  async unsnoozeCard(tenantId: string, cardId: string): Promise<KanbanCardEntity> {
    return await unsnoozeCard_helper(this, tenantId, cardId);
  }

  // ── BUTLER NLP ────────────────────────────────────────────────────────────

  // ── VOICE FORMAT / AI FORMAT ──────────────────────────────────────────

  async voiceFormat(tenantId: string, text: string): Promise<{ markdown: string }> {
    return await voiceFormat_helper(this, tenantId, text);
  }

  async formatDescription(tenantId: string, cardId: string): Promise<{ markdown: string }> {
    return await formatDescription_helper(this, tenantId, cardId);
  }

  // ── CARD DECOMPOSITION (AI) ──────────────────────────────────────────────

  async decomposeCard(
    tenantId: string,
    cardId: string,
  ): Promise<KanbanCardEntity[]> {
    return await decomposeCard_helper(this, tenantId, cardId);
  }

  async parseButlerRule(
    tenantId: string,
    boardId: string,
    text: string,
  ): Promise<{
    trigger: Record<string, any>;
    action: Record<string, any>;
    description: string;
  }> {
    return await parseButlerRule_helper(this, tenantId, boardId, text);
  }
}

function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo não permitido');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') throw new Error('URL interna não permitida');
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      throw new Error('URL interna não permitida');
    }
  }
}
