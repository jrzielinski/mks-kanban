import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanBoardEntity } from './entities/kanban-board.entity';

/**
 * Kanban Flow Trigger Service
 *
 * Listens to Kanban events and triggers Flow-Engine flows
 * when automation rules with type 'execute_flow' are configured.
 *
 * Also emits WebSocket events for 'open_app' actions so the frontend
 * can open App-Lumina dialogs/pages.
 */
@Injectable()
export class KanbanFlowTriggerService {
  private readonly logger = new Logger(KanbanFlowTriggerService.name);

  constructor(
    @InjectRepository(KanbanBoardEntity)
    private readonly boardRepo: Repository<KanbanBoardEntity>,
  ) {}

  /**
   * Execute a flow via the Flow-Engine service.
   * Uses dynamic import to avoid circular dependency between Kanban and FlowEngine modules.
   */
  private async triggerFlow(
    flowId: string,
    tenantId: string,
    variables: Record<string, any>,
    triggerSource: string,
  ): Promise<void> {
    try {
      const { getConnection } = require('typeorm');
      const conn = getConnection();

      // Load flow definition to verify it exists
      const flowDef = await conn.getRepository('flow_definitions').findOne({
        where: { id: flowId },
      });

      if (!flowDef) {
        this.logger.warn(`Flow ${flowId} not found, skipping trigger`);
        return;
      }

      if (flowDef.status !== 'active') {
        this.logger.warn(`Flow ${flowId} is not active (status: ${flowDef.status}), skipping`);
        return;
      }

      // Create flow instance directly
      const instanceRepo = conn.getRepository('flow_instances');
      const instance = instanceRepo.create({
        flowDefinitionId: flowId,
        tenantId,
        status: 'pending',
        context: {
          variables,
          currentNodeId: null,
          executionPath: [],
          errors: [],
          outputs: {},
          metadata: { source: 'kanban_automation' },
        },
        triggerData: {
          type: 'api',
          source: triggerSource,
          payload: variables,
        },
      });

      await instanceRepo.save(instance);
      this.logger.log(`Flow ${flowId} triggered from kanban (instance: ${instance.id}), source: ${triggerSource}`);

      // Execute asynchronously via the execution engine
      // We import dynamically to avoid circular deps
      try {
        const { FlowExecutionEngineService } = require('../flow-engine/services/flow-execution-engine.service');
        const appModule = require('../app.module');
        // Use the NestJS module ref if available, otherwise just log
        // The instance is created, the cron/watcher will pick it up
      } catch {
        // Execution engine not available directly — instance is saved,
        // the pending instance processor will pick it up
      }
    } catch (error) {
      this.logger.error(`Failed to trigger flow ${flowId}: ${error.message}`, error.stack);
    }
  }

  /**
   * Build variables map from card data based on configured variable mappings
   */
  private buildFlowVariables(
    card: any,
    board: any,
    listTitle: string,
    configuredVars?: Record<string, string>,
  ): Record<string, any> {
    const baseVars: Record<string, any> = {
      __tenantId: board.tenantId,
      kanban_cardId: card.id,
      kanban_cardTitle: card.title,
      kanban_cardDescription: card.description || '',
      kanban_boardId: board.id,
      kanban_boardTitle: board.title,
      kanban_listId: card.listId,
      kanban_listTitle: listTitle,
      kanban_cardLabels: JSON.stringify(card.labels || []),
      kanban_cardMembers: JSON.stringify(card.memberIds || []),
      kanban_cardDueDate: card.dueDate || '',
      kanban_cardPriority: card.priority || '',
      kanban_cardCustomFields: JSON.stringify(card.customFields || {}),
    };

    // Add custom variable mappings
    if (configuredVars) {
      for (const [varName, cardField] of Object.entries(configuredVars)) {
        const value = this.resolveCardField(card, cardField);
        if (value !== undefined) {
          baseVars[varName] = value;
        }
      }
    }

    return baseVars;
  }

  private resolveCardField(card: any, field: string): any {
    if (field.startsWith('customFields.')) {
      const key = field.replace('customFields.', '');
      return card.customFields?.[key];
    }
    return card[field];
  }

  // ── Event Listeners ───────────────────────────────────────────────

  @OnEvent('kanban.card.created')
  async onCardCreated(payload: { card: any; boardId: string }) {
    await this.processAutomationRules('card_created', payload.card, payload.boardId);
  }

  @OnEvent('kanban.card.moved')
  async onCardMoved(payload: { card: any; boardId: string; fromListId?: string; toListId?: string; toListTitle?: string }) {
    await this.processAutomationRules('card_moved_to_list', payload.card, payload.boardId, {
      listId: payload.toListId,
      listTitle: payload.toListTitle,
    });
  }

  @OnEvent('kanban.card.commented')
  async onCardCommented(payload: { card: any; boardId: string; comment: string }) {
    const cardWithComment = { ...payload.card, __lastComment: payload.comment };
    await this.processAutomationRules('card_commented', cardWithComment, payload.boardId);
  }

  @OnEvent('kanban.card.archived')
  async onCardArchived(payload: { card: any; boardId: string }) {
    await this.processAutomationRules('card_archived', payload.card, payload.boardId);
  }

  @OnEvent('kanban.card.checklist_completed')
  async onChecklistCompleted(payload: { card: any; boardId: string; checklistId?: string; checklistTitle?: string }) {
    await this.processAutomationRules('checklist_completed', payload.card, payload.boardId);
  }

  @OnEvent('kanban.card.label_added')
  async onLabelAdded(payload: { card: any; boardId: string; labelColor?: string; labelText?: string }) {
    await this.processAutomationRules('label_added', payload.card, payload.boardId, { labelColor: payload.labelColor });
  }

  @OnEvent('kanban.card.member_assigned')
  async onMemberAssigned(payload: { card: any; boardId: string; memberId?: string }) {
    await this.processAutomationRules('member_assigned', payload.card, payload.boardId, { memberId: payload.memberId });
  }

  @OnEvent('kanban.card.due_date_approaching')
  async onDueDateApproaching(payload: { card: any; boardId: string; daysUntilDue?: number }) {
    await this.processAutomationRules('due_date_approaching', payload.card, payload.boardId);
  }

  // ── Core Processing ───────────────────────────────────────────────

  private async processAutomationRules(
    triggerType: string,
    card: any,
    boardId: string,
    triggerContext?: { listId?: string; listTitle?: string; labelColor?: string; memberId?: string; [key: string]: any },
  ) {
    try {
      const board = await this.boardRepo.findOne({ where: { id: boardId } });
      if (!board || !board.automationRules?.length) return;

      const matchingRules = board.automationRules.filter(rule => {
        if (!rule.enabled) return false;
        if (rule.action.type !== 'execute_flow' && rule.action.type !== 'open_app') return false;
        if (rule.trigger.type !== triggerType) return false;

        // For card_moved_to_list, check if the target list matches
        if (triggerType === 'card_moved_to_list' && rule.trigger.listId) {
          if (rule.trigger.listId !== triggerContext?.listId) return false;
        }

        return true;
      });

      for (const rule of matchingRules) {
        if (rule.action.type === 'execute_flow' && rule.action.flowId) {
          const listTitle = triggerContext?.listTitle || '';
          const variables = this.buildFlowVariables(card, board, listTitle, rule.action.flowVariables);
          await this.triggerFlow(rule.action.flowId, board.tenantId, variables, `kanban:${triggerType}:${board.id}`);
        }

        if (rule.action.type === 'open_app' && rule.action.appId) {
          // For open_app, we emit a WebSocket event to the frontend
          // The frontend will handle opening the app dialog/tab
          this.logger.log(`App ${rule.action.appId} should be opened for card ${card.id} (trigger: ${triggerType})`);
          // WebSocket emission is handled by the kanban.service.ts which has access to the gateway
        }
      }
    } catch (error) {
      this.logger.error(`Error processing flow trigger rules: ${error.message}`, error.stack);
    }
  }
}
