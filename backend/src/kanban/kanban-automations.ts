/**
 * automations — extracted from KanbanService.
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

import { validateWebhookUrl } from './kanban-slack-powerup.service';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
export async function fireUpdateCardAutomations_helper(service: KanbanService, 
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
  const board = await (service as any).boardRepo.findOne({ where: { id: card.boardId, tenantId } });
  if (!board?.automationRules?.length) return;

  // Determine which trigger types are potentially active
  const triggers = new Set(board.automationRules.filter(r => r.enabled).map(r => r.trigger.type));

  // ── checklist_completed ──────────────────────────────────────────────────
  if (triggers.has('checklist_completed') && context.dtoChecklists !== undefined) {
    const newChecklists: any[] = context.dtoChecklists || [];
    for (const group of newChecklists) {
      const items: any[] = group.items || [];
      if (items.length === 0) continue;
      const allDone = items.every((i: any) => i.done);
      const prevGroup = (context.prevChecklists as any[]).find((g: any) => g.id === group.id);
      const wasPreviouslyComplete = prevGroup
        ? (prevGroup.items || []).length > 0 && (prevGroup.items || []).every((i: any) => i.done)
        : false;
      if (allDone && !wasPreviouslyComplete) {
        await (service as any).executeAutomationRules(tenantId, card, board, 'checklist_completed', {
          checklistId: group.id,
          checklistTitle: group.title || '',
        });
      }
    }
  }

  // ── label_added ─────────────────────────────────────────────────────────
  if (triggers.has('label_added') && context.dtoLabels !== undefined) {
    const newLabels: any[] = context.dtoLabels || [];
    for (const lbl of newLabels) {
      if (!context.prevLabelColors.has(lbl.color)) {
        await (service as any).executeAutomationRules(tenantId, card, board, 'label_added', {
          labelColor: lbl.color,
          labelText: lbl.text || '',
        });
      }
    }
  }

  // ── member_assigned ──────────────────────────────────────────────────────
  if (triggers.has('member_assigned') && context.addedMemberIds.length > 0) {
    for (const memberId of context.addedMemberIds) {
      await (service as any).executeAutomationRules(tenantId, card, board, 'member_assigned', { memberId });
    }
  }
}

export async function executeAutomationRules_helper(service: KanbanService, 
  tenantId: string,
  card: KanbanCardEntity,
  board: KanbanBoardEntity,
  triggerType: string,
  triggerContext: Record<string, any> = {},
): Promise<void> {
  const rules = board.automationRules.filter((r) => {
    if (!r.enabled || r.trigger.type !== triggerType) return false;
    // For label_added, optionally match specific label color
    if (triggerType === 'label_added' && r.trigger.labelColor && r.trigger.labelColor !== triggerContext.labelColor) return false;
    // For member_assigned, optionally match specific member
    if (triggerType === 'member_assigned' && r.trigger.memberId && r.trigger.memberId !== triggerContext.memberId) return false;
    return true;
  });

  if (!rules.length) return;

  let needsSave = false;
  const firedRules: typeof rules = [];

  for (const rule of rules) {
    try {
      if (rule.action.type === 'add_label' && rule.action.labelColor) {
        const labels = card.labels || [];
        if (!labels.some((l) => l.color === rule.action.labelColor)) {
          card.labels = [...labels, { text: rule.action.labelText || '', color: rule.action.labelColor }];
          needsSave = true;
          firedRules.push(rule);
        }
      } else if (rule.action.type === 'remove_label' && rule.action.labelColor) {
        const before = card.labels.length;
        card.labels = card.labels.filter((l) => l.color !== rule.action.labelColor);
        if (card.labels.length !== before) { needsSave = true; firedRules.push(rule); }
      } else if (rule.action.type === 'assign_member' && rule.action.memberId) {
        const ids = card.memberIds || [];
        if (!ids.includes(rule.action.memberId)) {
          card.memberIds = [...ids, rule.action.memberId];
          needsSave = true;
          firedRules.push(rule);
        }
      } else if (rule.action.type === 'set_due_offset' && rule.action.daysOffset !== undefined) {
        const due = new Date();
        due.setDate(due.getDate() + rule.action.daysOffset);
        card.dueDate = due;
        needsSave = true;
        firedRules.push(rule);
      } else if (rule.action.type === 'move_card' && rule.action.targetListId) {
        card.listId = rule.action.targetListId;
        needsSave = true;
        firedRules.push(rule);
      } else if (rule.action.type === 'archive_card') {
        card.isArchived = true;
        needsSave = true;
        firedRules.push(rule);
      } else if (rule.action.type === 'send_webhook' && rule.action.webhookUrl) {
        try {
          validateWebhookUrl(rule.action.webhookUrl);
          fetch(rule.action.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: triggerType, cardId: card.id, cardTitle: card.title, boardId: card.boardId, rule: rule.description, context: triggerContext }),
          }).catch(() => {});
          firedRules.push(rule);
        } catch (urlErr: any) {
          (service as any).logger.warn(`[Kanban] Webhook URL blocked (SSRF protection): ${urlErr.message}`);
          (service as any).activityRepo.save((service as any).activityRepo.create({
            tenantId, cardId: card.id, boardId: card.boardId,
            userId: null, userName: null, type: 'event' as const,
            text: `🤖 Automação "${rule.description || rule.action.type}" falhou: URL bloqueada [ruleId:${rule.id}][action:${rule.action.type}][status:error]`,
          })).catch(() => {});
        }
      } else if (rule.action.type === 'execute_flow' || rule.action.type === 'open_app') {
        // Handled by KanbanFlowTriggerService via EventEmitter (emitted below)
        firedRules.push(rule);
      }
    } catch (err: any) {
      (service as any).logger.error(`[Kanban] Automation rule ${rule.id} failed: ${err.message}`);
      (service as any).activityRepo.save((service as any).activityRepo.create({
        tenantId, cardId: card.id, boardId: card.boardId,
        userId: null, userName: null, type: 'event' as const,
        text: `🤖 Automação "${rule.description || rule.action.type}" falhou: ${err.message} [ruleId:${rule.id}][action:${rule.action.type}][status:error]`,
      })).catch(() => {});
    }
  }

  if (needsSave) {
    await (service as any).cardRepo.save(card);
    (service as any).gateway.emit(tenantId, card.boardId, 'card:updated', card);
  }

  // Emit EventEmitter events so KanbanFlowTriggerService can handle execute_flow/open_app
  const eventKey = `kanban.card.${triggerType}`;
  (service as any).eventEmitter.emit(eventKey, { card, boardId: card.boardId, ...triggerContext });

  for (const firedRule of firedRules) {
    (service as any).activityRepo.save((service as any).activityRepo.create({
      tenantId,
      cardId: card.id,
      boardId: card.boardId,
      userId: null,
      userName: null,
      type: 'event' as const,
      text: `🤖 Automação "${firedRule.description || firedRule.action.type}" executada [ruleId:${firedRule.id}][action:${firedRule.action.type}][status:success]`,
    })).catch(() => {});
  }
}

export async function checkAndEmitUnblockedCards_helper(service: KanbanService, tenantId: string, resolvedCardId: string, boardId: string): Promise<void> {
  // Find all board lists to determine which is the "last" (done) list
  const lists = await (service as any).listRepo.find({ where: { boardId, tenantId }, order: { position: 'ASC' } });
  if (!lists.length) return;
  const lastListId = lists[lists.length - 1].id;

  // Cards that had resolvedCardId as a blocker
  const dependents = await (service as any).cardRepo
    .createQueryBuilder('c')
    .where('c.tenant_id = :tenantId', { tenantId })
    .andWhere('c.board_id = :boardId', { boardId })
    .andWhere(`c.blocked_by @> :ids::jsonb`, { ids: JSON.stringify([resolvedCardId]) })
    .getMany();

  for (const dep of dependents) {
    const allResolved = await (service as any).areAllBlockersResolved(tenantId, dep.blockedBy, lastListId);
    if (allResolved) {
      (service as any).eventEmitter.emit('kanban.card.unblocked', {
        tenantId,
        boardId,
        cardId: dep.id,
        cardTitle: dep.title,
      });
      (service as any).gateway.emit(tenantId, boardId, 'card:unblocked', { cardId: dep.id });
      (service as any).logEvent(tenantId, dep.id, boardId, `🔓 Card desbloqueado — todos os bloqueadores foram concluídos`).catch(() => {});
    }
  }
}

export async function areAllBlockersResolved_helper(service: KanbanService, tenantId: string, blockerIds: string[], lastListId: string): Promise<boolean> {
  if (!blockerIds?.length) return true;
  for (const blockerId of blockerIds) {
    const blocker = await (service as any).cardRepo.findOne({ where: { id: blockerId, tenantId } });
    // Blocker is resolved if: archived, OR in the last list (done), OR not found (deleted)
    if (blocker && !blocker.isArchived && blocker.listId !== lastListId) {
      return false;
    }
  }
  return true;
}

export async function parseButlerRule_helper(service: KanbanService, 
  tenantId: string,
  boardId: string,
  text: string,
): Promise<{
  trigger: Record<string, any>;
  action: Record<string, any>;
  description: string;
}> {
  const board = await (service as any).boardRepo.findOne({ where: { id: boardId, tenantId } });
  if (!board) throw new NotFoundException('Board not found');

  const lists = await (service as any).listRepo.find({ where: { boardId, tenantId, isArchived: false } });
  const members = board.members || [];

  const listsContext = lists.map(l => `- "${l.title}" (id: ${l.id})`).join('\n');
  const membersContext = members.map(m => `- "${m.name}" (id: ${m.id})`).join('\n');

  const systemPrompt = `You are an automation rule parser for a Kanban system.
The user will describe a rule in natural language (Portuguese or English) and you must return ONLY a valid JSON with the rule structure.

Always respond in the language the user is currently using (pt-BR, en, or es).

## Board context

Available lists:
${listsContext || '(no lists)'}

Available members:
${membersContext || '(no members)'}

## Available trigger types:
- "card_moved_to_list" (requires listId and listTitle) — when a card is moved to a list
- "card_created" — when a card is created
- "due_date_approaching" (requires daysBeforeDue: number) — when due date is approaching
- "checklist_completed" — when all checklist items are completed
- "label_added" (optionally requires labelColor) — when a label is added to a card
- "member_assigned" (optionally requires memberId) — when a member is assigned to a card
- "card_archived" — when a card is archived

## Available action types:
- "add_label" (requires labelColor, optionally labelText)
- "remove_label" (requires labelColor)
- "assign_member" (requires memberId)
- "set_due_offset" (requires daysOffset: number) — sets due date N days from now
- "move_card" (requires targetListId)
- "archive_card"
- "send_webhook" (requires webhookUrl)
- "execute_flow" (requires flowId)

## Label colors:
green=#4bce97, yellow=#f5cd47, orange=#fea362, red=#f87168, purple=#9f8fef, blue=#579dff, cyan=#6cc3e0, lime=#94c748, pink=#e774bb, gray=#8590a2

## Response format
Return ONLY raw JSON (no markdown, no \`\`\`):
{
"trigger": { "type": "...", ...other fields },
"action": { "type": "...", ...other fields },
"description": "short human-readable description of the rule"
}

If you cannot interpret the rule, respond:
{ "error": "message explaining what was not understood" }`;

  // Get active API config
  let apiConfig;
  try {
    apiConfig = await (service as any).apiConfigService.findActive(tenantId);
  } catch {
    throw new NotFoundException('Nenhuma configuração de IA ativa encontrada. Configure uma API key em Configurações.');
  }

  const response = await (service as any).multiProviderAiService.chat(apiConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
  ]);

  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Resposta vazia da LLM');

  // Parse JSON from response (handle possible markdown wrapping)
  let jsonStr = content;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  const parsed = JSON.parse(jsonStr);
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (!parsed.trigger?.type || !parsed.action?.type) {
    throw new Error('Regra incompleta: trigger e action são obrigatórios');
  }

  return {
    trigger: parsed.trigger,
    action: parsed.action,
    description: parsed.description || text,
  };
}
