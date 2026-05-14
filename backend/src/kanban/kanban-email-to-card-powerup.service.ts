// src/kanban/kanban-email-to-card-powerup.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanPowerUpEntity, KanbanEmailToCardConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';
import { KanbanBoardEntity } from './entities/kanban-board.entity';
import { KanbanCardActivityEntity } from './entities/kanban-card-activity.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface IncomingEmail {
  from: string;
  subject: string;
  body: string;         // plain text body
  htmlBody?: string;    // HTML body (optional)
  attachments?: Array<{
    filename: string;
    contentType: string;
    url: string;        // URL or base64
  }>;
}

@Injectable()
export class KanbanEmailToCardPowerUpService {
  private readonly logger = new Logger(KanbanEmailToCardPowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanListEntity) private listRepo: Repository<KanbanListEntity>,
    @InjectRepository(KanbanBoardEntity) private boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanCardActivityEntity) private activityRepo: Repository<KanbanCardActivityEntity>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Gera o endereço de email único para um board.
   * Formato: board-<boardId-short>@kanban.makestudio.app
   */
  generateEmailAddress(boardId: string): string {
    const shortId = boardId.replace(/-/g, '').slice(0, 12);
    return `board-${shortId}@kanban.makestudio.app`;
  }

  /**
   * Recebe um email via webhook (ex: SendGrid Inbound Parse, Mailgun, etc.)
   * e cria um card no board correspondente.
   */
  async processIncomingEmail(
    tenantId: string,
    boardId: string,
    email: IncomingEmail,
  ): Promise<KanbanCardEntity | null> {
    const powerUp = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'email_to_card', enabled: true },
    });
    if (!powerUp) {
      this.logger.warn(`Email-to-Card not enabled for board ${boardId}`);
      return null;
    }

    const config = powerUp.config as KanbanEmailToCardConfig;

    // Verificar remetente permitido
    if (config.allowedSenders?.length) {
      const senderEmail = email.from.toLowerCase().replace(/.*<([^>]+)>.*/, '$1');
      const allowed = config.allowedSenders.some(
        (s) => senderEmail === s.toLowerCase() || senderEmail.endsWith(`@${s.toLowerCase()}`),
      );
      if (!allowed) {
        this.logger.warn(`Email from ${email.from} not in allowed senders for board ${boardId}`);
        return null;
      }
    }

    // Verificar se a lista alvo existe
    const targetList = await this.listRepo.findOne({
      where: { id: config.targetListId, boardId },
    });
    if (!targetList) {
      this.logger.error(`Target list ${config.targetListId} not found for board ${boardId}`);
      return null;
    }

    // Obter a próxima posição
    const lastCard = await this.cardRepo
      .createQueryBuilder('card')
      .where('card.list_id = :listId', { listId: config.targetListId })
      .orderBy('card.position', 'DESC')
      .getOne();
    const nextPosition = (lastCard?.position ?? 0) + 1;

    // Criar o card
    const useSubject = config.subjectAsTitle !== false;
    const useBody = config.bodyAsDescription !== false;
    const title = useSubject && email.subject ? email.subject : `Email de ${email.from}`;
    const description = useBody ? (email.body || email.htmlBody || null) : null;

    // Preparar labels
    const labels = (config.addLabels || []).map((text) => ({
      text,
      color: '#579dff',
    }));

    // Preparar attachments
    const attachments = (email.attachments || []).map((att) => ({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: att.filename,
      url: att.url,
      isImage: /^image\//i.test(att.contentType),
      addedAt: new Date().toISOString(),
    }));

    const card = this.cardRepo.create({
      listId: config.targetListId,
      boardId,
      tenantId,
      title,
      description,
      position: nextPosition,
      labels,
      attachments,
      customFields: {
        __emailFrom: email.from,
        __emailReceivedAt: new Date().toISOString(),
      },
    });

    const saved = await this.cardRepo.save(card);

    // Adicionar atividade de criação
    await this.activityRepo.save(
      this.activityRepo.create({
        cardId: saved.id,
        boardId,
        tenantId,
        type: 'event',
        text: `Card criado automaticamente a partir de email de ${email.from}`,
        userName: 'Email-to-Card',
      }),
    );

    this.eventEmitter.emit('kanban.card.created', {
      cardId: saved.id,
      boardId,
      tenantId,
    });

    this.logger.log(`Card "${saved.title}" created from email in board ${boardId}`);
    return saved;
  }

  /**
   * Retorna o endereço de email configurado para um board
   */
  async getEmailAddress(tenantId: string, boardId: string): Promise<{ emailAddress: string; configured: boolean }> {
    const powerUp = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'email_to_card' },
    });
    const emailAddress = this.generateEmailAddress(boardId);
    return {
      emailAddress,
      configured: !!powerUp?.enabled,
    };
  }
}
