// src/kanban/kanban-jira-powerup.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import axios from 'axios';
import { KanbanPowerUpEntity, KanbanJiraConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';
import { KanbanBoardEntity } from './entities/kanban-board.entity';
import { KanbanCardActivityEntity } from './entities/kanban-card-activity.entity';
import { jsonField } from '../database/json-sql';

/** Internal keys stored in card.customFields for Jira link */
const JIRA_ISSUE_KEY = '__jiraIssueKey';
const JIRA_ISSUE_URL = '__jiraIssueUrl';

@Injectable()
export class KanbanJiraPowerUpService {
  private readonly logger = new Logger(KanbanJiraPowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanListEntity) private listRepo: Repository<KanbanListEntity>,
    @InjectRepository(KanbanBoardEntity) private boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanCardActivityEntity) private activityRepo: Repository<KanbanCardActivityEntity>,
  ) {}

  // ── HELPERS ─────────────────────────────────────────────────────────────

  private getAuth(cfg: KanbanJiraConfig) {
    const token = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
    return { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' };
  }

  private getBaseUrl(cfg: KanbanJiraConfig) {
    return `https://${cfg.domain}.atlassian.net/rest/api/3`;
  }

  private async getJiraPowerUps(boardId: string, tenantId: string): Promise<{ pu: KanbanPowerUpEntity; cfg: KanbanJiraConfig }[]> {
    const pups = await this.powerUpRepo.find({ where: { boardId, tenantId, type: 'jira', enabled: true } });
    return pups.map(pu => ({ pu, cfg: pu.config as KanbanJiraConfig })).filter(p => p.cfg.domain && p.cfg.email && p.cfg.apiToken);
  }

  private getCardJiraKey(card: KanbanCardEntity): string | null {
    return (card.customFields as any)?.[JIRA_ISSUE_KEY] ?? null;
  }

  private async setCardJiraLink(card: KanbanCardEntity, issueKey: string, domain: string): Promise<void> {
    const fields = { ...(card.customFields || {}), [JIRA_ISSUE_KEY]: issueKey, [JIRA_ISSUE_URL]: `https://${domain}.atlassian.net/browse/${issueKey}` };
    await this.cardRepo.update(card.id, { customFields: fields });
  }

  private async logEvent(tenantId: string, cardId: string, boardId: string, text: string): Promise<void> {
    await this.activityRepo.save(this.activityRepo.create({
      tenantId, cardId, boardId, type: 'event', text, userId: 'system', userName: 'Jira Sync',
    })).catch(() => {});
  }

  // ── KANBAN → JIRA ─────────────────────────────────────────────────────

  /** Called when a card is created — creates Jira issue if syncOnCreate is enabled */
  @OnEvent('kanban.card.created')
  async onCardCreated(payload: { cardId: string; boardId: string; tenantId: string }): Promise<void> {
    const { cardId, boardId, tenantId } = payload;
    const jiraPups = await this.getJiraPowerUps(boardId, tenantId);
    if (jiraPups.length === 0) return;

    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card || this.getCardJiraKey(card)) return; // already linked

    for (const { cfg } of jiraPups) {
      if (!cfg.syncOnCreate) continue;
      try {
        const response = await axios.post(`${this.getBaseUrl(cfg)}/issue`, {
          fields: {
            project: { key: cfg.projectKey },
            summary: card.title,
            issuetype: { name: cfg.issueType || 'Task' },
            description: card.description ? {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: card.description }] }],
            } : undefined,
          },
        }, { headers: this.getAuth(cfg) });

        const issueKey = response.data.key;
        await this.setCardJiraLink(card, issueKey, cfg.domain);
        await this.logEvent(tenantId, cardId, boardId, `Issue ${issueKey} criada no Jira`);
        this.logger.log(`Created Jira issue ${issueKey} for card ${cardId}`);
      } catch (err) {
        this.logger.warn(`Failed to create Jira issue for card ${cardId}: ${err.message}`);
      }
    }
  }

  /** Called when a card is moved — transitions Jira issue status */
  @OnEvent('kanban.card.moved')
  async onCardMoved(payload: { cardId: string; fromListId: string; toListId: string; toListTitle: string; tenantId: string }): Promise<void> {
    const { cardId, toListId, tenantId } = payload;
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const jiraKey = this.getCardJiraKey(card);
    if (!jiraKey) return;

    const jiraPups = await this.getJiraPowerUps(card.boardId, tenantId);
    for (const { cfg } of jiraPups) {
      if (!cfg.syncOnMove) continue;

      const mapping = cfg.statusMapping?.find(m => m.listId === toListId);
      if (!mapping) continue;

      try {
        // Get available transitions for this issue
        const transResp = await axios.get(
          `${this.getBaseUrl(cfg)}/issue/${jiraKey}/transitions`,
          { headers: this.getAuth(cfg) },
        );
        const transitions = transResp.data.transitions || [];
        const target = transitions.find((t: any) =>
          t.to?.id === mapping.jiraStatusId || t.to?.name?.toLowerCase() === mapping.jiraStatusName.toLowerCase()
            || t.name?.toLowerCase() === mapping.jiraStatusName.toLowerCase(),
        );

        if (target) {
          await axios.post(
            `${this.getBaseUrl(cfg)}/issue/${jiraKey}/transitions`,
            { transition: { id: target.id } },
            { headers: this.getAuth(cfg) },
          );
          await this.logEvent(tenantId, cardId, card.boardId, `Status no Jira alterado para "${mapping.jiraStatusName}" (${jiraKey})`);
          this.logger.log(`Transitioned Jira issue ${jiraKey} to ${mapping.jiraStatusName}`);
        } else {
          this.logger.warn(`No matching Jira transition found for status "${mapping.jiraStatusName}" on issue ${jiraKey}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to transition Jira issue ${jiraKey}: ${err.message}`);
      }
    }
  }

  /** Called when a comment is added to a card — syncs comment to Jira */
  @OnEvent('kanban.card.commented')
  async onCardCommented(payload: { cardId: string; boardId: string; tenantId: string; text: string; userName: string }): Promise<void> {
    const { cardId, boardId, tenantId, text, userName } = payload;
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const jiraKey = this.getCardJiraKey(card);
    if (!jiraKey) return;

    const jiraPups = await this.getJiraPowerUps(boardId, tenantId);
    for (const { cfg } of jiraPups) {
      if (!cfg.syncOnComment) continue;
      try {
        await axios.post(`${this.getBaseUrl(cfg)}/issue/${jiraKey}/comment`, {
          body: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `[${userName}] ${text}` }] }],
          },
        }, { headers: this.getAuth(cfg) });
      } catch (err) {
        this.logger.warn(`Failed to sync comment to Jira ${jiraKey}: ${err.message}`);
      }
    }
  }

  // ── JIRA → KANBAN (Webhook receiver) ──────────────────────────────────

  async handleJiraWebhook(boardId: string, tenantId: string, body: any): Promise<{ ok: boolean; message: string }> {
    const jiraPups = await this.getJiraPowerUps(boardId, tenantId);
    if (jiraPups.length === 0) return { ok: false, message: 'No active Jira power-up for this board' };

    const eventType = body.webhookEvent || body.issue_event_type_name;
    const issue = body.issue;
    if (!issue?.key) return { ok: false, message: 'No issue key in webhook payload' };

    const issueKey = issue.key;

    // Find the card linked to this Jira issue
    const cards = await this.cardRepo
      .createQueryBuilder('c')
      .where('c.tenant_id = :tenantId', { tenantId })
      .andWhere('c.board_id = :boardId', { boardId })
      .andWhere(`${jsonField('c.custom_fields', JIRA_ISSUE_KEY)} = :issueKey`, { issueKey })
      .getMany();

    const card = cards[0];

    // ── Issue status changed → move card to mapped list
    if (eventType?.includes('issue_updated') || eventType === 'jira:issue_updated') {
      const changelog = body.changelog;
      const statusChange = changelog?.items?.find((i: any) => i.field === 'status');
      if (statusChange && card) {
        const newStatusName = statusChange.toString?.toLowerCase() || '';
        const newStatusId = statusChange.to;

        for (const { cfg } of jiraPups) {
          const mapping = cfg.statusMapping?.find(m =>
            m.jiraStatusId === newStatusId || m.jiraStatusName.toLowerCase() === newStatusName,
          );
          if (mapping && card.listId !== mapping.listId) {
            // Move card to the mapped list
            const targetList = await this.listRepo.findOne({ where: { id: mapping.listId, tenantId } });
            if (targetList) {
              await this.cardRepo.update(card.id, { listId: mapping.listId, position: 0 });
              await this.logEvent(tenantId, card.id, boardId, `Card movido para "${targetList.title}" via Jira (${issueKey} → ${statusChange.toString})`);
              this.logger.log(`Moved card ${card.id} to list ${mapping.listId} via Jira webhook`);
            }
          }
        }
        return { ok: true, message: `Status change processed for ${issueKey}` };
      }
    }

    // ── Comment added in Jira → add comment to card
    if ((eventType?.includes('comment_created') || eventType === 'comment_created') && card) {
      const comment = body.comment;
      const commentBody = comment?.body?.content?.[0]?.content?.[0]?.text || comment?.body || '';
      const authorName = comment?.author?.displayName || 'Jira';

      if (commentBody) {
        for (const { cfg } of jiraPups) {
          if (!cfg.syncOnComment) continue;
          await this.activityRepo.save(this.activityRepo.create({
            tenantId,
            cardId: card.id,
            boardId,
            type: 'comment',
            text: `[Jira · ${authorName}] ${commentBody}`,
            userId: 'jira-sync',
            userName: `Jira · ${authorName}`,
          }));
        }
        return { ok: true, message: `Comment synced for ${issueKey}` };
      }
    }

    // ── Issue created in Jira → create card (if no linked card exists)
    if ((eventType?.includes('issue_created') || eventType === 'jira:issue_created') && !card) {
      for (const { cfg } of jiraPups) {
        if (!cfg.syncOnCreate) continue;

        // Find the list that maps to the issue's current status
        const currentStatus = issue.fields?.status?.name;
        const currentStatusId = issue.fields?.status?.id;
        const mapping = cfg.statusMapping?.find(m =>
          m.jiraStatusId === currentStatusId || m.jiraStatusName.toLowerCase() === currentStatus?.toLowerCase(),
        );
        const targetListId = mapping?.listId || (await this.listRepo.findOne({ where: { boardId, tenantId, isArchived: false }, order: { position: 'ASC' } }))?.id;

        if (!targetListId) continue;

        const newCard = this.cardRepo.create({
          tenantId,
          boardId,
          listId: targetListId,
          title: issue.fields?.summary || issueKey,
          description: issue.fields?.description?.content?.[0]?.content?.[0]?.text || '',
          position: 0,
          customFields: {
            [JIRA_ISSUE_KEY]: issueKey,
            [JIRA_ISSUE_URL]: `https://${cfg.domain}.atlassian.net/browse/${issueKey}`,
          },
        });
        const saved = await this.cardRepo.save(newCard);
        await this.logEvent(tenantId, saved.id, boardId, `Card criado a partir do Jira (${issueKey})`);
        this.logger.log(`Created card ${saved.id} from Jira issue ${issueKey}`);
        return { ok: true, message: `Card created from ${issueKey}` };
      }
    }

    return { ok: true, message: `Event ${eventType} processed` };
  }

  // ── UTILITY: Link existing card to Jira issue ─────────────────────────

  async linkCardToJira(tenantId: string, cardId: string, issueKey: string): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const jiraPups = await this.getJiraPowerUps(card.boardId, tenantId);
    if (jiraPups.length === 0) throw new NotFoundException('No active Jira power-up on this board');

    const { cfg } = jiraPups[0];

    // Verify issue exists
    try {
      await axios.get(`${this.getBaseUrl(cfg)}/issue/${issueKey}`, { headers: this.getAuth(cfg) });
    } catch {
      throw new NotFoundException(`Jira issue ${issueKey} not found`);
    }

    await this.setCardJiraLink(card, issueKey, cfg.domain);
    await this.logEvent(tenantId, cardId, card.boardId, `Card vinculado ao Jira issue ${issueKey}`);
  }

  // ── UTILITY: Fetch Jira project statuses for mapping UI ───────────────

  async getJiraStatuses(tenantId: string, boardId: string): Promise<{ id: string; name: string; category: string }[]> {
    const jiraPups = await this.getJiraPowerUps(boardId, tenantId);
    if (jiraPups.length === 0) throw new NotFoundException('No active Jira power-up');

    const { cfg } = jiraPups[0];
    try {
      const resp = await axios.get(
        `${this.getBaseUrl(cfg)}/project/${cfg.projectKey}/statuses`,
        { headers: this.getAuth(cfg) },
      );
      const allStatuses: { id: string; name: string; category: string }[] = [];
      const seen = new Set<string>();
      for (const issueType of resp.data || []) {
        for (const status of issueType.statuses || []) {
          if (!seen.has(status.id)) {
            seen.add(status.id);
            allStatuses.push({ id: status.id, name: status.name, category: status.statusCategory?.name || '' });
          }
        }
      }
      return allStatuses;
    } catch (err) {
      this.logger.warn(`Failed to fetch Jira statuses: ${err.message}`);
      throw new NotFoundException('Failed to fetch Jira statuses. Check your credentials and project key.');
    }
  }
}
