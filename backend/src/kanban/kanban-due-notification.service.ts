// src/kanban/kanban-due-notification.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, IsNull, Not, LessThan } from 'typeorm';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanBoardEntity } from './entities/kanban-board.entity';
import { KanbanNotificationEntity } from './entities/kanban-notification.entity';
import { KanbanCardActivityEntity } from './entities/kanban-card-activity.entity';
import { KanbanMailService } from './kanban-mail.service';

@Injectable()
export class KanbanDueNotificationService {
  private readonly logger = new Logger(KanbanDueNotificationService.name);

  constructor(
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanBoardEntity) private boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanNotificationEntity) private notifRepo: Repository<KanbanNotificationEntity>,
    @InjectRepository(KanbanCardActivityEntity) private activityRepo: Repository<KanbanCardActivityEntity>,
    private readonly mailService: KanbanMailService,
  ) {}

  /** Runs daily at 08:00 to notify members about cards due in the next 24h */
  @Cron('0 8 * * *')
  async processDueSoonNotifications(): Promise<void> {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999);

    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);

    try {
      const cards = await this.cardRepo.find({
        where: {
          tenantId: Not(IsNull()),
          isArchived: false,
          dueDate: Between(windowStart, tomorrow) as any,
        },
      });

      for (const card of cards) {
        if (!card.dueDate) continue;

        // Skip if already notified today
        if (card.lastDueNotifiedAt) {
          const notifiedDay = new Date(card.lastDueNotifiedAt);
          notifiedDay.setHours(0, 0, 0, 0);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          if (notifiedDay.getTime() === today.getTime()) continue;
        }

        if (!card.memberIds?.length) continue;

        const board = await this.boardRepo.findOne({ where: { id: card.boardId, tenantId: card.tenantId } });
        if (!board) continue;

        for (const memberId of card.memberIds) {
          const member = board.members?.find((m) => m.id === memberId);
          if (!member) continue;

          // In-app notification
          this.notifRepo.save(
            this.notifRepo.create({
              tenantId: card.tenantId,
              userId: memberId,
              boardId: card.boardId,
              cardId: card.id,
              cardTitle: card.title,
              type: 'due_soon',
              text: `Card "${card.title}" vence em breve: ${card.dueDate.toLocaleDateString('pt-BR')}`,
            }),
          ).catch(() => {});

          // Email notification
          if (member.email) {
            this.mailService.sendDueSoonEmail({
              recipient: { name: member.name, email: member.email },
              cardTitle: card.title,
              boardTitle: board.title,
              dueDate: card.dueDate,
            }).catch(() => {});
          }
        }

        // Fire due_date_approaching automation rules
        await this.fireDueDateApproachingRules(card, board, now).catch(() => {});

        // Mark as notified
        await this.cardRepo.update({ id: card.id, tenantId: card.tenantId }, { lastDueNotifiedAt: now });
        this.logger.log(`Due-soon notifications sent for card "${card.title}" (${card.id})`);
      }
    } catch (err) {
      this.logger.error(`Due notification job failed: ${err}`);
    }
  }

  /** Execute automation rules with trigger due_date_approaching for a card */
  private async fireDueDateApproachingRules(
    card: KanbanCardEntity,
    board: KanbanBoardEntity,
    now: Date,
  ): Promise<void> {
    if (!board.automationRules?.length) return;
    const dueDate = card.dueDate!;
    const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const matchingRules = board.automationRules.filter((r) => {
      if (!r.enabled || r.trigger.type !== 'due_date_approaching') return false;
      // Match if daysBeforeDue is configured and card is within that window
      if (r.trigger.daysBeforeDue !== undefined) {
        return daysUntilDue <= r.trigger.daysBeforeDue && daysUntilDue >= 0;
      }
      // Default: match if within 1 day
      return daysUntilDue <= 1 && daysUntilDue >= 0;
    });

    if (!matchingRules.length) return;

    let needsSave = false;
    const firedRules: typeof matchingRules = [];

    for (const rule of matchingRules) {
      if (rule.action.type === 'add_label' && rule.action.labelColor) {
        const labels = card.labels || [];
        if (!labels.some((l: any) => l.color === rule.action.labelColor)) {
          card.labels = [...labels, { text: rule.action.labelText || '', color: rule.action.labelColor }];
          needsSave = true;
          firedRules.push(rule);
        }
      } else if (rule.action.type === 'remove_label' && rule.action.labelColor) {
        const before = card.labels.length;
        card.labels = card.labels.filter((l: any) => l.color !== rule.action.labelColor);
        if (card.labels.length !== before) { needsSave = true; firedRules.push(rule); }
      } else if (rule.action.type === 'assign_member' && rule.action.memberId) {
        const ids = card.memberIds || [];
        if (!ids.includes(rule.action.memberId)) {
          card.memberIds = [...ids, rule.action.memberId];
          needsSave = true;
          firedRules.push(rule);
        }
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
          this.validateWebhookUrl(rule.action.webhookUrl);
          fetch(rule.action.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'due_date_approaching', cardId: card.id, cardTitle: card.title, boardId: card.boardId, daysUntilDue, rule: rule.description }),
          }).catch(() => {});
          firedRules.push(rule);
        } catch {
          // URL blocked by SSRF protection — skip silently
        }
      }
    }

    if (needsSave) {
      await this.cardRepo.save(card);
    }

    for (const firedRule of firedRules) {
      this.activityRepo.save(this.activityRepo.create({
        tenantId: card.tenantId,
        cardId: card.id,
        boardId: card.boardId,
        userId: null,
        userName: null,
        type: 'event' as const,
        text: `🤖 Automação "${firedRule.description || firedRule.action.type}" executada [ruleId:${firedRule.id}][action:${firedRule.action.type}][status:success]`,
      })).catch(() => {});
    }
  }

  private validateWebhookUrl(url: string): void {
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

  /** Runs daily at 09:00 to notify members about overdue cards */
  @Cron('0 9 * * *')
  async processOverdueNotifications(): Promise<void> {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    try {
      const cards = await this.cardRepo.find({
        where: {
          tenantId: Not(IsNull()),
          isArchived: false,
          dueDate: LessThan(today) as any,
        },
      });

      for (const card of cards) {
        if (!card.dueDate || !card.memberIds?.length) continue;

        // Only send overdue email once per week (check lastDueNotifiedAt)
        if (card.lastDueNotifiedAt) {
          const daysSinceNotif = Math.floor((now.getTime() - new Date(card.lastDueNotifiedAt).getTime()) / 86400000);
          if (daysSinceNotif < 7) continue;
        }

        const board = await this.boardRepo.findOne({ where: { id: card.boardId, tenantId: card.tenantId } });
        if (!board) continue;

        for (const memberId of card.memberIds) {
          const member = board.members?.find((m) => m.id === memberId);
          if (!member) continue;

          // In-app notification
          this.notifRepo.save(
            this.notifRepo.create({
              tenantId: card.tenantId,
              userId: memberId,
              boardId: card.boardId,
              cardId: card.id,
              cardTitle: card.title,
              type: 'overdue',
              text: `Card "${card.title}" está atrasado! Venceu em ${card.dueDate.toLocaleDateString('pt-BR')}`,
            }),
          ).catch(() => {});

          // Email notification
          if ((member as any).email) {
            this.mailService.sendOverdueEmail({
              recipient: { name: member.name, email: (member as any).email },
              cardTitle: card.title,
              boardTitle: board.title,
              dueDate: card.dueDate,
            }).catch(() => {});
          }
        }

        await this.cardRepo.update({ id: card.id, tenantId: card.tenantId }, { lastDueNotifiedAt: now });
      }
    } catch (err) {
      this.logger.error(`Overdue notification job failed: ${err}`);
    }
  }

  /** Runs every 15 minutes to unsnooze cards whose snooze time has passed */
  @Cron('*/15 * * * *')
  async processSnoozeWakeUp(): Promise<void> {
    const now = new Date();
    try {
      // Find all non-archived cards that have a __snoozedUntil custom field
      const cards = await this.cardRepo
        .createQueryBuilder('card')
        .where('card.is_archived = false')
        .andWhere('card.tenant_id IS NOT NULL')
        .andWhere("card.custom_fields->>'__snoozedUntil' IS NOT NULL")
        .getMany();

      let woken = 0;
      for (const card of cards) {
        const snoozedUntil = card.customFields?.['__snoozedUntil'];
        if (!snoozedUntil) continue;
        const wakeUp = new Date(snoozedUntil as string);
        if (isNaN(wakeUp.getTime()) || wakeUp > now) continue;

        // Wake up: remove snooze fields
        const { __snoozedUntil, __snoozedAt, ...rest } = card.customFields || {};
        card.customFields = rest;
        await this.cardRepo.save(card);
        woken++;

        // Notify assigned members
        if (card.memberIds?.length) {
          const board = await this.boardRepo.findOne({ where: { id: card.boardId, tenantId: card.tenantId } });
          for (const memberId of card.memberIds) {
            this.notifRepo.save(
              this.notifRepo.create({
                tenantId: card.tenantId,
                userId: memberId,
                boardId: card.boardId,
                cardId: card.id,
                cardTitle: card.title,
                type: 'snooze_wakeup',
                text: `Card "${card.title}" voltou do snooze e está ativo novamente!`,
              }),
            ).catch(() => {});
          }
        }
      }

      if (woken > 0) {
        this.logger.log(`Snooze wake-up: ${woken} card(s) unsnoozed`);
      }
    } catch (err) {
      this.logger.error(`Snooze wake-up job failed: ${err}`);
    }
  }
}
