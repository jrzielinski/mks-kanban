// src/kanban/kanban-slack-powerup.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { KanbanPowerUpEntity, KanbanSlackConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanBoardEntity } from './entities/kanban-board.entity';

@Injectable()
export class KanbanSlackPowerUpService {
  private readonly logger = new Logger(KanbanSlackPowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanBoardEntity) private boardRepo: Repository<KanbanBoardEntity>,
  ) {}

  // ── HELPERS ─────────────────────────────────────────────────────────────

  private async getSlackPowerUps(boardId: string, tenantId: string): Promise<{ cfg: KanbanSlackConfig }[]> {
    const pups = await this.powerUpRepo.find({ where: { boardId, tenantId, type: 'slack', enabled: true } });
    return pups.map(pu => ({ cfg: pu.config as KanbanSlackConfig })).filter(p => p.cfg.webhookUrl);
  }

  private async sendSlack(webhookUrl: string, payload: Record<string, any>): Promise<void> {
    try {
      validateWebhookUrl(webhookUrl);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.logger.warn(`Slack webhook failed: ${err}`);
    }
  }

  private buildMessage(text: string, cardTitle: string, boardTitle: string, channel?: string): Record<string, any> {
    const payload: Record<string, any> = {
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `*Board:* ${boardTitle} · *Card:* ${cardTitle}` },
          ],
        },
      ],
    };
    if (channel) payload.channel = channel;
    return payload;
  }

  private async getBoardTitle(boardId: string): Promise<string> {
    const board = await this.boardRepo.findOne({ where: { id: boardId } });
    return board?.title || 'Board';
  }

  // ── EVENT LISTENERS ────────────────────────────────────────────────────

  @OnEvent('kanban.card.created')
  async onCardCreated(payload: { cardId: string; boardId: string; tenantId: string }): Promise<void> {
    const { cardId, boardId, tenantId } = payload;
    const slackPups = await this.getSlackPowerUps(boardId, tenantId);
    if (slackPups.length === 0) return;

    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const boardTitle = await this.getBoardTitle(boardId);

    for (const { cfg } of slackPups) {
      if (cfg.notifyOnCreate === false) continue;
      const msg = this.buildMessage(
        `:new: Card *${card.title}* foi criado`,
        card.title,
        boardTitle,
        cfg.channel,
      );
      this.sendSlack(cfg.webhookUrl, msg);
    }
  }

  @OnEvent('kanban.card.moved')
  async onCardMoved(payload: { cardId: string; fromListId: string; toListId: string; toListTitle: string; tenantId: string }): Promise<void> {
    const { cardId, toListTitle, tenantId } = payload;
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const slackPups = await this.getSlackPowerUps(card.boardId, tenantId);
    if (slackPups.length === 0) return;

    const boardTitle = await this.getBoardTitle(card.boardId);

    for (const { cfg } of slackPups) {
      if (cfg.notifyOnMove === false) continue;
      const msg = this.buildMessage(
        `:arrow_right: Card *${card.title}* movido para *${toListTitle}*`,
        card.title,
        boardTitle,
        cfg.channel,
      );
      this.sendSlack(cfg.webhookUrl, msg);
    }
  }

  @OnEvent('kanban.card.commented')
  async onCardCommented(payload: { cardId: string; boardId: string; tenantId: string; text: string; userName: string }): Promise<void> {
    const { cardId, boardId, tenantId, text, userName } = payload;
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const slackPups = await this.getSlackPowerUps(boardId, tenantId);
    if (slackPups.length === 0) return;

    const boardTitle = await this.getBoardTitle(boardId);

    for (const { cfg } of slackPups) {
      if (cfg.notifyOnComment === false) continue;
      const msg = this.buildMessage(
        `:speech_balloon: *${userName}* comentou em *${card.title}*:\n>${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`,
        card.title,
        boardTitle,
        cfg.channel,
      );
      this.sendSlack(cfg.webhookUrl, msg);
    }
  }

  @OnEvent('kanban.card.archived')
  async onCardArchived(payload: { cardId: string; boardId: string; tenantId: string }): Promise<void> {
    const { cardId, boardId, tenantId } = payload;
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const slackPups = await this.getSlackPowerUps(boardId, tenantId);
    if (slackPups.length === 0) return;

    const boardTitle = await this.getBoardTitle(boardId);

    for (const { cfg } of slackPups) {
      if (cfg.notifyOnArchive === false) continue;
      const msg = this.buildMessage(
        `:file_folder: Card *${card.title}* foi arquivado`,
        card.title,
        boardTitle,
        cfg.channel,
      );
      this.sendSlack(cfg.webhookUrl, msg);
    }
  }
}

export function validateWebhookUrl(url: string): void {
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
