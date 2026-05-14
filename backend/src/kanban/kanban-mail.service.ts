// src/kanban/kanban-mail.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '../mailer/mailer.service';

export interface KanbanEmailRecipient {
  name: string;
  email: string;
}

@Injectable()
export class KanbanMailService {
  private readonly logger = new Logger(KanbanMailService.name);

  constructor(private readonly mailerService: MailerService) {}

  async sendMentionEmail(params: {
    recipient: KanbanEmailRecipient;
    mentionedBy: string;
    cardTitle: string;
    boardTitle: string;
    commentText: string;
    cardUrl?: string;
  }): Promise<void> {
    try {
      await this.mailerService.sendMail({
        to: `"${params.recipient.name}" <${params.recipient.email}>`,
        subject: `${params.mentionedBy} mencionou você em "${params.cardTitle}"`,
        templatePath: '',
        context: {},
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #0c66e4; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">Você foi mencionado</h2>
            </div>
            <div style="padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #172b4d; font-size: 15px; margin: 0 0 16px;">
                <strong>${params.mentionedBy}</strong> mencionou você em um comentário no card <strong>"${params.cardTitle}"</strong> no board <strong>${params.boardTitle}</strong>.
              </p>
              <blockquote style="background: white; border-left: 4px solid #579dff; padding: 12px 16px; margin: 0 0 16px; border-radius: 0 8px 8px 0; color: #44546f; font-style: italic;">
                ${params.commentText}
              </blockquote>
              ${params.cardUrl ? `<a href="${params.cardUrl}" style="display: inline-block; background: #0c66e4; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Ver card</a>` : ''}
            </div>
          </div>
        `,
      });
    } catch (err) {
      this.logger.warn(`Failed to send mention email to ${params.recipient.email}: ${err}`);
    }
  }

  async sendInviteEmail(params: {
    recipientEmail: string;
    boardTitle: string;
    inviteLink: string;
    inviterName: string;
  }): Promise<void> {
    try {
      await this.mailerService.sendMail({
        to: params.recipientEmail,
        subject: `${params.inviterName} convidou você para o board "${params.boardTitle}"`,
        templatePath: '',
        context: {},
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #0c66e4; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">Convite para board Kanban</h2>
            </div>
            <div style="padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #172b4d; font-size: 15px; margin: 0 0 16px;">
                <strong>${params.inviterName}</strong> convidou você para colaborar no board <strong>"${params.boardTitle}"</strong>.
              </p>
              <a href="${params.inviteLink}" style="display: inline-block; background: #0c66e4; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Aceitar convite</a>
              <p style="color: #626f86; font-size: 12px; margin-top: 16px;">Ou copie este link: ${params.inviteLink}</p>
            </div>
          </div>
        `,
      });
    } catch (err) {
      this.logger.warn(`Failed to send invite email to ${params.recipientEmail}: ${err}`);
    }
  }

  async sendOverdueEmail(params: {
    recipient: KanbanEmailRecipient;
    cardTitle: string;
    boardTitle: string;
    dueDate: Date;
    cardUrl?: string;
  }): Promise<void> {
    try {
      const dueDateStr = params.dueDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
      await this.mailerService.sendMail({
        to: `"${params.recipient.name}" <${params.recipient.email}>`,
        subject: `Card "${params.cardTitle}" está atrasado!`,
        templatePath: '',
        context: {},
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #f87168; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">Card atrasado</h2>
            </div>
            <div style="padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #172b4d; font-size: 15px; margin: 0 0 16px;">
                O card <strong>"${params.cardTitle}"</strong> no board <strong>${params.boardTitle}</strong> venceu em <strong>${dueDateStr}</strong> e está atrasado.
              </p>
              ${params.cardUrl ? `<a href="${params.cardUrl}" style="display: inline-block; background: #f87168; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Ver card</a>` : ''}
            </div>
          </div>
        `,
      });
    } catch (err) {
      this.logger.warn(`Failed to send overdue email to ${params.recipient.email}: ${err}`);
    }
  }

  async sendAssignedEmail(params: {
    recipient: KanbanEmailRecipient;
    assignedBy: string;
    cardTitle: string;
    boardTitle: string;
    cardUrl?: string;
  }): Promise<void> {
    try {
      await this.mailerService.sendMail({
        to: `"${params.recipient.name}" <${params.recipient.email}>`,
        subject: `Você foi atribuído ao card "${params.cardTitle}"`,
        templatePath: '',
        context: {},
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #579dff; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">Nova atribuição</h2>
            </div>
            <div style="padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #172b4d; font-size: 15px; margin: 0 0 16px;">
                <strong>${params.assignedBy}</strong> atribuiu você ao card <strong>"${params.cardTitle}"</strong> no board <strong>${params.boardTitle}</strong>.
              </p>
              ${params.cardUrl ? `<a href="${params.cardUrl}" style="display: inline-block; background: #579dff; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Ver card</a>` : ''}
            </div>
          </div>
        `,
      });
    } catch (err) {
      this.logger.warn(`Failed to send assigned email to ${params.recipient.email}: ${err}`);
    }
  }

  async sendWatcherCommentEmail(params: {
    recipient: KanbanEmailRecipient;
    commentBy: string;
    cardTitle: string;
    boardTitle: string;
    commentText: string;
    cardUrl?: string;
  }): Promise<void> {
    try {
      await this.mailerService.sendMail({
        to: `"${params.recipient.name}" <${params.recipient.email}>`,
        subject: `Novo comentário em "${params.cardTitle}"`,
        templatePath: '',
        context: {},
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #4bce97; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">Novo comentário</h2>
            </div>
            <div style="padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #172b4d; font-size: 15px; margin: 0 0 16px;">
                <strong>${params.commentBy}</strong> comentou no card <strong>"${params.cardTitle}"</strong> no board <strong>${params.boardTitle}</strong>.
              </p>
              <blockquote style="background: white; border-left: 4px solid #4bce97; padding: 12px 16px; margin: 0 0 16px; border-radius: 0 8px 8px 0; color: #44546f; font-style: italic;">
                ${params.commentText.length > 200 ? params.commentText.slice(0, 200) + '...' : params.commentText}
              </blockquote>
              ${params.cardUrl ? `<a href="${params.cardUrl}" style="display: inline-block; background: #4bce97; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Ver card</a>` : ''}
            </div>
          </div>
        `,
      });
    } catch (err) {
      this.logger.warn(`Failed to send watcher comment email to ${params.recipient.email}: ${err}`);
    }
  }

  async sendDueSoonEmail(params: {
    recipient: KanbanEmailRecipient;
    cardTitle: string;
    boardTitle: string;
    dueDate: Date;
    cardUrl?: string;
  }): Promise<void> {
    try {
      const dueDateStr = params.dueDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
      await this.mailerService.sendMail({
        to: `"${params.recipient.name}" <${params.recipient.email}>`,
        subject: `Card "${params.cardTitle}" vence amanhã`,
        templatePath: '',
        context: {},
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #ff991f; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">⚠️ Vencimento próximo</h2>
            </div>
            <div style="padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #172b4d; font-size: 15px; margin: 0 0 16px;">
                O card <strong>"${params.cardTitle}"</strong> no board <strong>${params.boardTitle}</strong> vence em <strong>${dueDateStr}</strong>.
              </p>
              ${params.cardUrl ? `<a href="${params.cardUrl}" style="display: inline-block; background: #ff991f; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Ver card</a>` : ''}
            </div>
          </div>
        `,
      });
    } catch (err) {
      this.logger.warn(`Failed to send due-soon email to ${params.recipient.email}: ${err}`);
    }
  }
}
