/**
 * cards — extracted from KanbanService.
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

import { AdvancedSearchDto, CreateCardDto, MoveCardDto, MoveCardToBoardDto, UpdateCardDto } from './dto/kanban.dto';
import { validateWebhookUrl } from './kanban-slack-powerup.service';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
export async function createCard_helper(service: KanbanService, tenantId: string, listId: string, dto: CreateCardDto): Promise<KanbanCardEntity> {
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('List not found');
  const maxPos = await (service as any).cardRepo.maximum('position', { listId, tenantId }) ?? -1;
  const card = (service as any).cardRepo.create({
    ...dto,
    listId,
    boardId: list.boardId,
    tenantId,
    position: dto.position ?? maxPos + 1,
    dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
  });
  const saved = await (service as any).cardRepo.save(card);
  (service as any).logEvent(tenantId, saved.id, saved.boardId, `Card criado na lista "${list.title}"`).catch(() => {});

  // Fire card_created automation rules
  const board = await (service as any).boardRepo.findOne({ where: { id: saved.boardId, tenantId } });
  if (board?.automationRules?.length) {
    const rules = board.automationRules.filter((r) => r.enabled && r.trigger.type === 'card_created');
    const firedRules: typeof rules = [];
    for (const rule of rules) {
      if (rule.action.type === 'assign_member' && rule.action.memberId && !saved.memberIds.includes(rule.action.memberId)) {
        saved.memberIds = [...saved.memberIds, rule.action.memberId];
        firedRules.push(rule);
      } else if (rule.action.type === 'add_label' && rule.action.labelColor) {
        if (!saved.labels.some((l) => l.color === rule.action.labelColor)) {
          saved.labels = [...saved.labels, { text: rule.action.labelText || '', color: rule.action.labelColor }];
          firedRules.push(rule);
        }
      } else if (rule.action.type === 'remove_label' && rule.action.labelColor) {
        const before = saved.labels.length;
        saved.labels = saved.labels.filter((l) => l.color !== rule.action.labelColor);
        if (saved.labels.length !== before) firedRules.push(rule);
      } else if (rule.action.type === 'set_due_offset' && rule.action.daysOffset !== undefined) {
        const due = new Date();
        due.setDate(due.getDate() + rule.action.daysOffset);
        saved.dueDate = due;
        firedRules.push(rule);
      } else if (rule.action.type === 'archive_card') {
        saved.isArchived = true;
        firedRules.push(rule);
      } else if (rule.action.type === 'move_card' && rule.action.targetListId) {
        saved.listId = rule.action.targetListId;
        firedRules.push(rule);
      } else if (rule.action.type === 'send_webhook' && rule.action.webhookUrl) {
        try {
          validateWebhookUrl(rule.action.webhookUrl);
          fetch(rule.action.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'card_created', cardId: saved.id, cardTitle: saved.title, boardId: saved.boardId, rule: rule.description }),
          }).catch(() => {});
          firedRules.push(rule);
        } catch (urlErr: any) {
          (service as any).logger.warn(`[Kanban] Webhook URL blocked (SSRF protection): ${urlErr.message}`);
        }
      } else if (rule.action.type === 'execute_flow' || rule.action.type === 'open_app') {
        // Handled by KanbanFlowTriggerService via EventEmitter (kanban.card.created)
      }
    }
    if (firedRules.length > 0) {
      await (service as any).cardRepo.save(saved);
      for (const firedRule of firedRules) {
        (service as any).activityRepo.save((service as any).activityRepo.create({
          tenantId,
          cardId: saved.id,
          boardId: saved.boardId,
          userId: null,
          userName: null,
          type: 'event' as const,
          text: `🤖 Automação "${firedRule.description || firedRule.action.type}" executada [ruleId:${firedRule.id}][action:${firedRule.action.type}][status:success]`,
        })).catch(() => {});
      }
    }
  }

  (service as any).gateway.emit(saved.tenantId, saved.boardId, 'card:created', saved);
  (service as any).eventEmitter.emit('kanban.card.created', (service as any).buildCardPayload(
    'card.created', saved, '', '', undefined,
  ));
  // Emit event for Jira sync
  (service as any).eventEmitter.emit('kanban.card.created', { cardId: saved.id, boardId: saved.boardId, tenantId });
  return saved;
}

export async function updateCard_helper(service: KanbanService, tenantId: string, cardId: string, dto: UpdateCardDto): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');

  const events: string[] = [];

  // Track changes for automation triggers
  const prevMemberIds = new Set(card.memberIds || []);
  const prevLabelColors = new Set((card.labels || []).map((l) => l.color));
  const prevChecklists = card.checklists ? JSON.parse(JSON.stringify(card.checklists)) : [];

  let addedMemberIds: string[] = [];

  if (dto.memberIds !== undefined) {
    const board = await (service as any).boardRepo.findOne({ where: { id: card.boardId, tenantId } });
    const validMemberIds = new Set((board?.members || []).map((member) => member.id));
    dto.memberIds = (dto.memberIds || []).filter((memberId) => validMemberIds.has(memberId));
    addedMemberIds = dto.memberIds.filter((id) => !prevMemberIds.has(id));
    const removed = (card.memberIds || []).filter((id) => !dto.memberIds!.includes(id));
    const boardMembers = board?.members || [];
    addedMemberIds.forEach((id) => {
      const member = boardMembers.find((m) => m.id === id);
      const name = member?.name ?? id;
      events.push(`Membro ${name} adicionado`);
      // Send assignment email
      if (member && (member as any).email) {
        (service as any).kanbanMailService.sendAssignedEmail({
          recipient: { name: member.name, email: (member as any).email },
          assignedBy: 'Sistema',
          cardTitle: card.title,
          boardTitle: board?.title ?? '',
        }).catch(() => {});
      }
    });
    removed.forEach((id) => {
      const name = boardMembers.find((m) => m.id === id)?.name ?? id;
      events.push(`Membro ${name} removido`);
    });
  }

  if (dto.dueDate !== undefined && dto.dueDate !== (card.dueDate?.toISOString().slice(0, 10) ?? null)) {
    events.push(dto.dueDate ? `Prazo definido para ${new Date(dto.dueDate).toLocaleDateString('pt-BR')}` : 'Prazo removido');
  }

  if (dto.title !== undefined && dto.title !== card.title) {
    events.push(`Título alterado para "${dto.title}"`);
  }

  if (dto.description !== undefined && dto.description !== card.description) {
    events.push(`Descrição alterada`);
  }

  if (dto.isArchived === true && !card.isArchived) {
    events.push('Card arquivado');
    // C4: archiving resolves this card as a blocker for others
    (service as any).checkAndEmitUnblockedCards(tenantId, cardId, card.boardId).catch(() => {});
  }

  Object.assign(card, dto);
  if (dto.dueDate !== undefined) {
    card.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
  }
  if (dto.startDate !== undefined) {
    card.startDate = dto.startDate ? new Date(dto.startDate) : null;
  }
  const saved = await (service as any).cardRepo.save(card);

  // Emit power-up events for detected changes
  if (dto.title !== undefined || dto.description !== undefined) {
    (service as any).eventEmitter.emit('kanban.card.edited', (service as any).buildCardPayload('card.edited', saved, '', ''));
  }
  if (dto.memberIds !== undefined) {
    (service as any).eventEmitter.emit('kanban.card.assigned', (service as any).buildCardPayload('card.assigned', saved, '', ''));
  }
  if (dto.dueDate !== undefined) {
    (service as any).eventEmitter.emit('kanban.card.due_changed', (service as any).buildCardPayload('card.due_changed', saved, '', ''));
  }

  // ── Automation triggers: checklist_completed, label_added, member_assigned ──
  (service as any).fireUpdateCardAutomations(tenantId, saved, {
    prevMemberIds,
    prevLabelColors,
    prevChecklists,
    addedMemberIds,
    dtoLabels: dto.labels,
    dtoChecklists: dto.checklists,
  }).catch(() => {});

  // Log events asynchronously (non-blocking)
  for (const text of events) {
    (service as any).logEvent(tenantId, cardId, card.boardId, text).catch(() => {});
  }

  (service as any).gateway.emit(saved.tenantId, saved.boardId, 'card:updated', saved);
  return saved;
}

export async function moveCard_helper(service: KanbanService, tenantId: string, cardId: string, dto: MoveCardDto): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  const targetList = await (service as any).listRepo.findOne({ where: { id: dto.targetListId, tenantId } });
  if (!targetList) throw new NotFoundException('Target list not found');

  const previousListId = card.listId;
  const previousList = await (service as any).listRepo.findOne({ where: { id: previousListId, tenantId } });

  await (service as any).dataSource.transaction(async (em) => {
    await em.query(
      `UPDATE kanban_cards SET position = position + 1
       WHERE list_id = $1 AND tenant_id = $2 AND position >= $3 AND id != $4`,
      [dto.targetListId, tenantId, dto.position, cardId],
    );
    card.listId = dto.targetListId;
    card.boardId = targetList.boardId;
    card.position = dto.position;
    await em.save(KanbanCardEntity, card);
  });

  // Reload card after transaction
  const movedCard = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } }) as KanbanCardEntity;

  // Log move event if list changed
  if (previousListId !== dto.targetListId) {
    const fromTitle = previousList?.title ?? previousListId;
    const toTitle = targetList.title;
    (service as any).logEvent(tenantId, cardId, movedCard.boardId, `Card movido de "${fromTitle}" para "${toTitle}"`).catch(() => {});
    // C2: Record movement history
    (service as any).cardHistoryRepo.save((service as any).cardHistoryRepo.create({
      cardId,
      boardId: movedCard.boardId,
      tenantId,
      fromListId: previousListId,
      fromListTitle: fromTitle,
      toListId: dto.targetListId,
      toListTitle: toTitle,
    })).catch(() => {});
    (service as any).eventEmitter.emit('kanban.card.moved', (service as any).buildCardPayload(
      'card.moved', movedCard, '', '',
      { fromListId: previousListId, toListId: dto.targetListId, toListTitle: targetList.title },
    ));
  }

  // Apply automation rules if list changed
  if (previousListId !== dto.targetListId) {
    const board = await (service as any).boardRepo.findOne({ where: { id: movedCard.boardId, tenantId } });
    if (board?.automationRules?.length) {
      const rules = board.automationRules.filter(
        (r) => r.enabled && r.trigger.type === 'card_moved_to_list' && r.trigger.listId === dto.targetListId,
      );
      const firedRules: typeof rules = [];
      for (const rule of rules) {
        if (rule.action.type === 'add_label' && rule.action.labelColor) {
          const labels = movedCard.labels || [];
          if (!labels.some((l) => l.color === rule.action.labelColor)) {
            movedCard.labels = [...labels, { text: rule.action.labelText || '', color: rule.action.labelColor }];
            firedRules.push(rule);
          }
        } else if (rule.action.type === 'remove_label' && rule.action.labelColor) {
          const before = movedCard.labels.length;
          movedCard.labels = movedCard.labels.filter((l) => l.color !== rule.action.labelColor);
          if (movedCard.labels.length !== before) firedRules.push(rule);
        } else if (rule.action.type === 'assign_member' && rule.action.memberId) {
          const ids = movedCard.memberIds || [];
          if (!ids.includes(rule.action.memberId)) {
            movedCard.memberIds = [...ids, rule.action.memberId];
            firedRules.push(rule);
          }
        } else if (rule.action.type === 'set_due_offset' && rule.action.daysOffset !== undefined) {
          const due = new Date();
          due.setDate(due.getDate() + rule.action.daysOffset);
          movedCard.dueDate = due;
          firedRules.push(rule);
        } else if (rule.action.type === 'move_card' && rule.action.targetListId) {
          movedCard.listId = rule.action.targetListId;
          firedRules.push(rule);
        } else if (rule.action.type === 'archive_card') {
          movedCard.isArchived = true;
          firedRules.push(rule);
        } else if (rule.action.type === 'send_webhook' && rule.action.webhookUrl) {
          try {
            validateWebhookUrl(rule.action.webhookUrl);
            fetch(rule.action.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cardId: movedCard.id, cardTitle: movedCard.title, listId: dto.targetListId }),
            }).catch(() => {});
          } catch (urlErr: any) {
            (service as any).logger.warn(`[Kanban] Webhook URL blocked (SSRF protection): ${urlErr.message}`);
          }
        } else if (rule.action.type === 'execute_flow' || rule.action.type === 'open_app') {
          // Handled by KanbanFlowTriggerService via EventEmitter (kanban.card.moved)
        }
      }
      if (firedRules.length > 0) {
        await (service as any).cardRepo.save(movedCard);
        for (const firedRule of firedRules) {
          (service as any).activityRepo.save((service as any).activityRepo.create({
            tenantId,
            cardId: movedCard.id,
            boardId: movedCard.boardId,
            userId: null,
            userName: null,
            type: 'event' as const,
            text: `🤖 Automação "${firedRule.description || firedRule.action.type}" executada [ruleId:${firedRule.id}][action:${firedRule.action.type}][status:success]`,
          })).catch(() => {});
        }
      }
    }

    // Notify watchers
    const reloaded = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (reloaded?.watchedBy?.length) {
      const boardForWatch = await (service as any).boardRepo.findOne({ where: { id: reloaded.boardId, tenantId } });
      for (const watcherId of reloaded.watchedBy) {
        if (watcherId !== tenantId) {
          (service as any).notifRepo.save((service as any).notifRepo.create({
            tenantId,
            userId: watcherId,
            boardId: reloaded.boardId,
            cardId: reloaded.id,
            cardTitle: reloaded.title,
            type: 'watch',
            text: `Card "${reloaded.title}" foi movido para "${targetList.title}"`,
          })).catch(() => {});
        }
      }
      // Slack notification
      if (boardForWatch) {
        // Slack notification handled by KanbanSlackPowerUpService via kanban.card.moved event
      }
    }
  }

  const finalCard = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } }) as KanbanCardEntity;
  (service as any).gateway.emit(tenantId, finalCard.boardId, 'card:moved', {
    cardId: finalCard.id,
    fromListId: previousListId,
    toListId: dto.targetListId,
    position: dto.position ?? 0,
  });

  // C4: Check if this card was blocking others — if so, see if they're now unblocked
  if (previousListId !== dto.targetListId) {
    (service as any).checkAndEmitUnblockedCards(tenantId, cardId, finalCard.boardId).catch(() => {});
  }

  return finalCard;
}

export async function moveCardToBoard_helper(service: KanbanService, tenantId: string, cardId: string, dto: MoveCardToBoardDto): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  const targetBoard = await (service as any).boardRepo.findOne({ where: { id: dto.targetBoardId, tenantId } });
  if (!targetBoard) throw new NotFoundException('Target board not found');
  const targetList = await (service as any).listRepo.findOne({ where: { id: dto.targetListId, tenantId, boardId: dto.targetBoardId } });
  if (!targetList) throw new NotFoundException('Target list not found');

  const fromBoardId = card.boardId;
  const fromListId = card.listId;
  const prevList = await (service as any).listRepo.findOne({ where: { id: fromListId, tenantId } });

  card.boardId = dto.targetBoardId;
  card.listId = dto.targetListId;
  card.position = dto.position;
  const saved = await (service as any).cardRepo.save(card);

  (service as any).logEvent(tenantId, cardId, fromBoardId, `Card movido para o board "${targetBoard.title}"`).catch(() => {});
  (service as any).logEvent(tenantId, cardId, dto.targetBoardId, `Card recebido de "${prevList?.title ?? 'outro board'}"`).catch(() => {});

  return saved;
}

export async function duplicateCard_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');

  const maxPos = await (service as any).cardRepo.maximum('position', { listId: card.listId, tenantId }) ?? card.position;
  const newCard = (service as any).cardRepo.create({
    title: `${card.title} (cópia)`,
    description: card.description,
    labels: card.labels,
    checklists: card.checklists,
    memberIds: card.memberIds,
    dueDate: card.dueDate,
    startDate: card.startDate,
    coverColor: card.coverColor,
    position: maxPos + 1,
    listId: card.listId,
    boardId: card.boardId,
    tenantId,
  });
  const saved = await (service as any).cardRepo.save(newCard);
  (service as any).logEvent(tenantId, saved.id, saved.boardId, `Card duplicado de "${card.title}"`).catch(() => {});
  return saved;
}

export async function deleteCard_helper(service: KanbanService, tenantId: string, cardId: string): Promise<void> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  (service as any).gateway.emit(tenantId, card.boardId, 'card:deleted', { cardId: card.id, listId: card.listId });
  await (service as any).cardRepo.remove(card);
}

export async function restoreCard_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  card.isArchived = false;
  const saved = await (service as any).cardRepo.save(card);
  (service as any).logEvent(tenantId, cardId, card.boardId, 'Card restaurado do arquivo').catch(() => {});
  return saved;
}

export async function linkCards_helper(service: KanbanService, tenantId: string, cardId: string, targetCardId: string): Promise<void> {
  const [card, target] = await Promise.all([
    (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } }),
    (service as any).cardRepo.findOne({ where: { id: targetCardId, tenantId } }),
  ]);
  if (!card || !target) throw new NotFoundException('Card not found');
  if (!card.linkedCardIds.includes(targetCardId)) {
    card.linkedCardIds = [...card.linkedCardIds, targetCardId];
    await (service as any).cardRepo.save(card);
  }
  if (!target.linkedCardIds.includes(cardId)) {
    target.linkedCardIds = [...target.linkedCardIds, cardId];
    await (service as any).cardRepo.save(target);
  }
}

export async function unlinkCard_helper(service: KanbanService, tenantId: string, cardId: string, targetCardId: string): Promise<void> {
  const [card, target] = await Promise.all([
    (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } }),
    (service as any).cardRepo.findOne({ where: { id: targetCardId, tenantId } }),
  ]);
  if (card) { card.linkedCardIds = card.linkedCardIds.filter(id => id !== targetCardId); await (service as any).cardRepo.save(card); }
  if (target) { target.linkedCardIds = target.linkedCardIds.filter(id => id !== cardId); await (service as any).cardRepo.save(target); }
}

export async function getBatchCards_helper(service: KanbanService, tenantId: string, ids: string[]): Promise<{ id: string; title: string; listTitle: string; boardTitle: string }[]> {
  const validIds = ids.filter(id => id);
  if (!validIds.length) return [];
  const cards = await (service as any).cardRepo.find({ where: { id: In(validIds), tenantId } });
  if (!cards.length) return [];
  const listIds = [...new Set(cards.map(c => c.listId))];
  const boardIds = [...new Set(cards.map(c => c.boardId))];
  const [lists, boards] = await Promise.all([
    (service as any).listRepo.find({ where: { id: In(listIds), tenantId } }),
    (service as any).boardRepo.find({ where: { id: In(boardIds), tenantId } }),
  ]);
  const listMap = new Map(lists.map(l => [l.id, l.title]));
  const boardMap = new Map(boards.map(b => [b.id, b.title]));
  return cards.map(c => ({ id: c.id, title: c.title, listTitle: listMap.get(c.listId) ?? '', boardTitle: boardMap.get(c.boardId) ?? '' }));
}

export async function addBlocker_helper(service: KanbanService, tenantId: string, cardId: string, blockerCardId: string): Promise<KanbanCardEntity> {
  const [card, blocker] = await Promise.all([
    (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } }),
    (service as any).cardRepo.findOne({ where: { id: blockerCardId, tenantId } }),
  ]);
  if (!card || !blocker) throw new NotFoundException('Card not found');
  if (!card.blockedBy.includes(blockerCardId)) {
    card.blockedBy = [...card.blockedBy, blockerCardId];
    await (service as any).cardRepo.save(card);
    (service as any).logEvent(tenantId, cardId, card.boardId, `🔒 Bloqueador adicionado: "${blocker.title}"`).catch(() => {});
    (service as any).gateway.emit(tenantId, card.boardId, 'card:updated', card);
  }
  return card;
}

export async function removeBlocker_helper(service: KanbanService, tenantId: string, cardId: string, blockerCardId: string): Promise<void> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  if (card.blockedBy.includes(blockerCardId)) {
    card.blockedBy = card.blockedBy.filter(id => id !== blockerCardId);
    await (service as any).cardRepo.save(card);
    (service as any).logEvent(tenantId, cardId, card.boardId, `🔓 Bloqueador removido`).catch(() => {});
    (service as any).gateway.emit(tenantId, card.boardId, 'card:updated', card);
  }
}

export async function convertChecklistItemToCard_helper(service: KanbanService, 
  tenantId: string,
  cardId: string,
  groupId: string,
  itemId: string,
  targetListId?: string,
): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');

  const group = card.checklists?.find(g => g.id === groupId);
  if (!group) throw new NotFoundException('Checklist group not found');
  const item = group.items.find(i => i.id === itemId);
  if (!item) throw new NotFoundException('Checklist item not found');

  const listId = targetListId ?? card.listId;
  const list = await (service as any).listRepo.findOne({ where: { id: listId, tenantId } });
  if (!list) throw new NotFoundException('Target list not found');

  const existingCards = await (service as any).cardRepo.find({ where: { listId, tenantId }, order: { position: 'DESC' }, take: 1 });
  const position = (existingCards[0]?.position ?? -1) + 1;

  const newCard = (service as any).cardRepo.create({
    listId,
    boardId: card.boardId,
    tenantId,
    title: item.text,
    description: null,
    position,
    labels: [],
    checklist: [],
    checklists: [],
    attachments: [],
    memberIds: [],
    votes: [],
    stickers: [],
    customFields: {},
    recurrence: null,
    coverColor: '#ffffff',
    coverImageUrl: null,
    coverAttachmentId: null,
    isArchived: false,
    watchedBy: [],
    location: null,
  });
  const savedCard = await (service as any).cardRepo.save(newCard);

  // Remove item from checklist
  card.checklists = card.checklists.map(g =>
    g.id === groupId ? { ...g, items: g.items.filter(i => i.id !== itemId) } : g,
  );
  await (service as any).cardRepo.save(card);

  return savedCard;
}

export async function searchCards_helper(service: KanbanService, tenantId: string, query: string): Promise<(KanbanCardEntity & { boardTitle: string; listTitle: string })[]> {
  if (!query?.trim()) return [];

  const cards = await (service as any).cardRepo.find({
    where: [
      { tenantId, isArchived: false, title: ILike(`%${query}%`) },
      { tenantId, isArchived: false, description: ILike(`%${query}%`) },
    ],
    order: { updatedAt: 'DESC' },
    take: 50,
  });

  if (!cards.length) return [];

  const boardIds = [...new Set(cards.map((c) => c.boardId))];
  const listIds = [...new Set(cards.map((c) => c.listId))];

  const [boards, lists] = await Promise.all([
    (service as any).boardRepo.find({ where: { id: In(boardIds), tenantId } }),
    (service as any).listRepo.find({ where: { id: In(listIds), tenantId } }),
  ]);

  const boardMap = new Map(boards.map((b) => [b.id, b.title]));
  const listMap = new Map(lists.map((l) => [l.id, l.title]));

  return cards.map((c) => ({
    ...c,
    boardTitle: boardMap.get(c.boardId) ?? '',
    listTitle: listMap.get(c.listId) ?? '',
  })) as any;
}

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

export async function snoozeCard_helper(service: KanbanService, tenantId: string, cardId: string, until: string): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  const untilDate = new Date(until);
  if (isNaN(untilDate.getTime())) throw new Error('Invalid snooze date');
  card.customFields = {
    ...(card.customFields || {}),
    __snoozedUntil: untilDate.toISOString(),
    __snoozedAt: new Date().toISOString(),
  };
  return (service as any).cardRepo.save(card);
}

export async function unsnoozeCard_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanCardEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  const { __snoozedUntil, __snoozedAt, ...rest } = card.customFields || {};
  card.customFields = rest;
  return (service as any).cardRepo.save(card);
}

export async function voiceFormat_helper(service: KanbanService, tenantId: string, text: string): Promise<{ markdown: string }> {
  if (!text?.trim()) throw new BadRequestException('Texto vazio');

  const apiConfig = await (service as any).apiConfigService.findActive(tenantId).catch(() => {
    throw new NotFoundException('Nenhuma configuração de IA ativa encontrada.');
  });

  const systemPrompt = `You are a text formatting assistant. Format the user's raw text into clean, well-structured markdown.
Always respond in the language the user is currently using (pt-BR, en, or es).
- Fix obvious typos and grammar
- Break long paragraphs into readable sections
- Use bullet lists where appropriate
- Preserve all original information, URLs, and numbers
- Return ONLY the formatted markdown, no extra commentary or code fences`;

  const response = await (service as any).multiProviderAiService.chat(apiConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
  ]);

  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Resposta vazia da LLM');

  return { markdown: content };
}

export async function formatDescription_helper(service: KanbanService, tenantId: string, cardId: string): Promise<{ markdown: string }> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');
  if (!card.description?.trim()) throw new BadRequestException('Card has no description');

  const apiConfig = await (service as any).apiConfigService.findActive(tenantId).catch(() => {
    throw new NotFoundException('Nenhuma configuração de IA ativa encontrada.');
  });

  const systemPrompt = `You are a text formatting assistant. Format the card description into clean, well-structured markdown.
Always respond in the language the user is currently using (pt-BR, en, or es).
- Fix typos and grammar
- Break long paragraphs into readable sections
- Use headings (##, ###) for logical sections
- Use bullet lists where appropriate
- Preserve all original information, URLs, code blocks, and numbers
- Return ONLY the formatted markdown, no extra commentary or code fences`;

  const response = await (service as any).multiProviderAiService.chat(apiConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Format this card description:\n\n${card.description}` },
  ]);

  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Resposta vazia da LLM');

  await (service as any).cardRepo.update({ id: cardId, tenantId }, { description: content });

  return { markdown: content };
}

export async function decomposeCard_helper(service: KanbanService, 
  tenantId: string,
  cardId: string,
): Promise<KanbanCardEntity[]> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card not found');

  const board = await (service as any).boardRepo.findOne({ where: { id: card.boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');

  const lists = await (service as any).listRepo.find({ where: { boardId: card.boardId, tenantId, isArchived: false }, order: { position: 'ASC' } });
  const listsContext = lists.map(l => `- "${l.title}" (id: ${l.id})`).join('\n');
  const labelsContext = (board.boardLabels || []).map(l => `- "${l.text}" (cor: ${l.color})`).join('\n');
  const customFieldsContext = (board.customFieldDefs || []).map(cf => `- "${cf.name}" (tipo: ${cf.type}, id: ${cf.id})`).join('\n');

  const checklistsText = (card.checklists || []).map(g =>
    `Checklist "${g.title}": ${g.items.map(i => `[${i.done ? 'x' : ' '}] ${i.text}`).join(', ')}`,
  ).join('\n');

  const systemPrompt = `You are a project management assistant. The user wants to decompose a complex task into smaller, actionable sub-tasks.

Always respond in the language the user is currently using (pt-BR, en, or es).

## Board context

Available lists:
${listsContext || '(no lists)'}

Available labels:
${labelsContext || '(no labels)'}

Available custom fields:
${customFieldsContext || '(none)'}

## Original card
- Title: ${card.title}
- Description: ${card.description || '(no description)'}
- Current labels: ${card.labels?.map(l => l.text || l.color).join(', ') || '(none)'}
${checklistsText ? `- Checklists:\n${checklistsText}` : ''}

## Instructions
Decompose this card into smaller sub-tasks (between 3 and 8 sub-cards). Each sub-card should be:
- Specific and actionable (one person can execute it without ambiguity)
- Estimable (clear scope)
- Independent when possible

Return ONLY raw JSON (no markdown, no \`\`\`):
{
"cards": [
  {
    "title": "Clear sub-task title",
    "description": "Brief description of what needs to be done",
    "labels": [{ "text": "name", "color": "#hex" }],
    "targetListId": "id of the suggested list (or null to keep in same list)"
  }
],
"summary": "Brief explanation of the decomposition"
}

Use existing board labels when relevant. If no suitable labels exist, you may suggest new ones.
targetListId must be the id of an existing list, or null to create in the same list as the original card.`;

  let apiConfig;
  try {
    apiConfig = await (service as any).apiConfigService.findActive(tenantId);
  } catch {
    throw new NotFoundException('Nenhuma configuração de IA ativa encontrada. Configure uma API key em Configurações.');
  }

  const response = await (service as any).multiProviderAiService.chat(apiConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Decomponha o card: "${card.title}"` },
  ]);

  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Resposta vazia da LLM');

  let jsonStr = content;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  const parsed = JSON.parse(jsonStr);
  if (!parsed.cards?.length) {
    throw new Error('A decomposição não retornou nenhum sub-card');
  }

  // Obter a posição base para os novos cards
  const lastCard = await (service as any).cardRepo
    .createQueryBuilder('card')
    .where('card.list_id = :listId', { listId: card.listId })
    .orderBy('card.position', 'DESC')
    .getOne();
  let nextPosition = (lastCard?.position ?? 0) + 1;

  const createdCards: KanbanCardEntity[] = [];
  for (const subCard of parsed.cards) {
    const targetListId = subCard.targetListId && lists.some(l => l.id === subCard.targetListId)
      ? subCard.targetListId
      : card.listId;

    const newCard = (service as any).cardRepo.create({
      listId: targetListId,
      boardId: card.boardId,
      tenantId,
      title: subCard.title,
      description: subCard.description || null,
      position: nextPosition++,
      labels: Array.isArray(subCard.labels) ? subCard.labels : [],
      linkedCardIds: [card.id], // linkar ao card original
    });
    const saved = await (service as any).cardRepo.save(newCard);
    createdCards.push(saved);

    (service as any).eventEmitter.emit('kanban.card.created', {
      cardId: saved.id,
      boardId: saved.boardId,
      tenantId,
    });
  }

  // Linkar o card original aos sub-cards
  card.linkedCardIds = [
    ...(card.linkedCardIds || []),
    ...createdCards.map(c => c.id),
  ];
  await (service as any).cardRepo.save(card);

  // Adicionar atividade no card original
  await (service as any).activityRepo.save(
    (service as any).activityRepo.create({
      cardId: card.id,
      boardId: card.boardId,
      tenantId,
      type: 'event',
      text: `Card decomposto em ${createdCards.length} sub-tasks: ${createdCards.map(c => c.title).join(', ')}`,
      userName: 'Sistema',
    }),
  );

  return createdCards;
}
