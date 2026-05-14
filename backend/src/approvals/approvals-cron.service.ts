import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ApprovalEntity } from './entities/approval.entity';
import { ApprovalHistoryEntity } from './entities/approval-history.entity';
import { ApprovalsService } from './approvals.service';

@Injectable()
export class ApprovalsCronService {
  private readonly logger = new Logger(ApprovalsCronService.name);

  constructor(
    @InjectRepository(ApprovalEntity)
    private readonly approvalsRepository: Repository<ApprovalEntity>,
    @InjectRepository(ApprovalHistoryEntity)
    private readonly historyRepository: Repository<ApprovalHistoryEntity>,
    private readonly approvalsService: ApprovalsService,
  ) {}

  /**
   * Processar aprovações expiradas (timeout)
   * Roda a cada 5 minutos
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleExpiredApprovals() {
    this.logger.log('Iniciando processamento de aprovações expiradas');

    const now = new Date();

    // Buscar aprovações pendentes que expiraram
    const expiredApprovals = await this.approvalsRepository.find({
      where: {
        status: 'pending',
        expiresAt: LessThan(now),
      },
    });

    this.logger.log(`Encontradas ${expiredApprovals.length} aprovações expiradas`);

    for (const approval of expiredApprovals) {
      try {
        await this.processTimeout(approval);
      } catch (error) {
        this.logger.error(
          `Erro ao processar timeout da aprovação ${approval.id}: ${error.message}`,
          error.stack,
        );
      }
    }

    this.logger.log('Processamento de aprovações expiradas concluído');
  }

  /**
   * Processar regras de escalação automática
   * Roda a cada 10 minutos
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleEscalationRules() {
    this.logger.log('Iniciando processamento de regras de escalação');

    const now = new Date();

    // Buscar aprovações pendentes com regras de escalação
    const approvalsWithRules = await this.approvalsRepository
      .createQueryBuilder('approval')
      .where('approval.status = :status', { status: 'pending' })
      .andWhere('approval.escalationRules IS NOT NULL')
      .getMany();

    this.logger.log(`Encontradas ${approvalsWithRules.length} aprovações com regras de escalação`);

    for (const approval of approvalsWithRules) {
      try {
        await this.processEscalationRules(approval, now);
      } catch (error) {
        this.logger.error(
          `Erro ao processar escalação da aprovação ${approval.id}: ${error.message}`,
          error.stack,
        );
      }
    }

    this.logger.log('Processamento de regras de escalação concluído');
  }

  /**
   * Processar timeout de uma aprovação
   */
  private async processTimeout(approval: ApprovalEntity): Promise<void> {
    const action = approval.timeoutAction || 'auto-reject';

    this.logger.log(
      `Processando timeout da aprovação ${approval.id} com ação: ${action}`,
    );

    switch (action) {
      case 'auto-reject':
        await this.autoReject(approval);
        break;

      case 'escalate':
        await this.autoEscalate(approval);
        break;

      case 'notify':
        await this.sendTimeoutNotification(approval);
        break;

      default:
        // Default: auto-reject
        await this.autoReject(approval);
    }
  }

  /**
   * Auto-rejeitar aprovação expirada
   */
  private async autoReject(approval: ApprovalEntity): Promise<void> {
    approval.status = 'expired';
    await this.approvalsRepository.save(approval);

    await this.addHistory(approval.id, 'expired', {
      previousStatus: 'pending',
      newStatus: 'expired',
      comments: 'Aprovação expirou automaticamente (auto-reject)',
    });

    // Enviar notificação
    await this.approvalsService.sendReminder(
      approval.id,
      'expiration',
      'email',
    );

    this.logger.log(`Aprovação ${approval.id} auto-rejeitada por timeout`);
  }

  /**
   * Auto-escalar aprovação expirada
   */
  private async autoEscalate(approval: ApprovalEntity): Promise<void> {
    const newLevel = (approval.escalationLevel || 0) + 1;

    approval.escalationLevel = newLevel;
    approval.lastEscalatedAt = new Date();

    // Se tiver regras de escalação, tentar obter o próximo aprovador
    if (approval.escalationRules && approval.escalationRules.length > 0) {
      const escalationRule = approval.escalationRules.find(
        (rule) => rule.action === 'escalate',
      );

      if (escalationRule) {
        if (escalationRule.targetUserId) {
          approval.approverId = escalationRule.targetUserId;
        }
        if (escalationRule.targetGroupId) {
          approval.approverGroupId = escalationRule.targetGroupId;
        }
      }
    }

    // Estender prazo de expiração (mais 24 horas)
    const newExpiresAt = new Date();
    newExpiresAt.setHours(newExpiresAt.getHours() + 24);
    approval.expiresAt = newExpiresAt;

    await this.approvalsRepository.save(approval);

    await this.addHistory(approval.id, 'escalated', {
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: `Escalada automaticamente por timeout para nível ${newLevel}`,
      metadata: { escalationLevel: newLevel },
    });

    // Enviar notificação de escalação
    await this.approvalsService.sendReminder(
      approval.id,
      'escalation',
      'email',
    );

    this.logger.log(
      `Aprovação ${approval.id} escalada automaticamente para nível ${newLevel}`,
    );
  }

  /**
   * Enviar notificação de timeout
   */
  private async sendTimeoutNotification(approval: ApprovalEntity): Promise<void> {
    approval.lastNotifiedAt = new Date();
    approval.notificationCount = (approval.notificationCount || 0) + 1;

    // Estender prazo (mais 12 horas)
    const newExpiresAt = new Date();
    newExpiresAt.setHours(newExpiresAt.getHours() + 12);
    approval.expiresAt = newExpiresAt;

    await this.approvalsRepository.save(approval);

    await this.addHistory(approval.id, 'notified', {
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: `Notificação de timeout enviada (${approval.notificationCount}x)`,
    });

    // Enviar notificação
    await this.approvalsService.sendReminder(
      approval.id,
      'reminder',
      'email',
    );

    this.logger.log(
      `Notificação de timeout enviada para aprovação ${approval.id}`,
    );
  }

  /**
   * Processar regras de escalação de uma aprovação
   */
  private async processEscalationRules(
    approval: ApprovalEntity,
    now: Date,
  ): Promise<void> {
    if (!approval.escalationRules || approval.escalationRules.length === 0) {
      return;
    }

    // Calcular minutos desde a criação
    const minutesSinceCreated = Math.floor(
      (now.getTime() - approval.createdAt.getTime()) / 1000 / 60,
    );

    // Verificar cada regra
    for (const rule of approval.escalationRules) {
      // Verificar se já passou o tempo da regra
      if (minutesSinceCreated >= rule.after) {
        // Verificar se esta regra já foi executada
        const alreadyExecuted = await this.historyRepository.findOne({
          where: {
            approvalId: approval.id,
            action: 'escalation-rule',
            metadata: { ruleAfter: rule.after } as any,
          },
        });

        if (alreadyExecuted) {
          continue; // Já foi executada
        }

        // Executar ação da regra
        await this.executeEscalationRule(approval, rule, minutesSinceCreated);
      }
    }
  }

  /**
   * Executar ação de uma regra de escalação
   */
  private async executeEscalationRule(
    approval: ApprovalEntity,
    rule: any,
    minutesSinceCreated: number,
  ): Promise<void> {
    this.logger.log(
      `Executando regra de escalação para aprovação ${approval.id}: ${rule.action} após ${rule.after} minutos`,
    );

    switch (rule.action) {
      case 'notify':
        approval.lastNotifiedAt = new Date();
        approval.notificationCount = (approval.notificationCount || 0) + 1;
        await this.approvalsRepository.save(approval);

        await this.addHistory(approval.id, 'escalation-rule', {
          previousStatus: 'pending',
          newStatus: 'pending',
          comments: rule.message || `Notificação automática após ${rule.after} minutos`,
          metadata: { ruleAfter: rule.after, action: 'notify' },
        });

        await this.approvalsService.sendReminder(
          approval.id,
          'reminder',
          'email',
        );
        break;

      case 'escalate':
        const newLevel = (approval.escalationLevel || 0) + 1;
        approval.escalationLevel = newLevel;
        approval.lastEscalatedAt = new Date();

        if (rule.targetUserId) {
          approval.approverId = rule.targetUserId;
        }
        if (rule.targetGroupId) {
          approval.approverGroupId = rule.targetGroupId;
        }

        await this.approvalsRepository.save(approval);

        await this.addHistory(approval.id, 'escalation-rule', {
          previousStatus: 'pending',
          newStatus: 'pending',
          comments: `Escalada para nível ${newLevel} após ${rule.after} minutos`,
          metadata: {
            ruleAfter: rule.after,
            action: 'escalate',
            escalationLevel: newLevel,
            targetUserId: rule.targetUserId,
            targetGroupId: rule.targetGroupId,
          },
        });

        await this.approvalsService.sendReminder(
          approval.id,
          'escalation',
          'email',
        );
        break;

      case 'auto-reject':
        approval.status = 'expired';
        await this.approvalsRepository.save(approval);

        await this.addHistory(approval.id, 'escalation-rule', {
          previousStatus: 'pending',
          newStatus: 'expired',
          comments: `Auto-rejeitada após ${rule.after} minutos sem resposta`,
          metadata: { ruleAfter: rule.after, action: 'auto-reject' },
        });

        await this.approvalsService.sendReminder(
          approval.id,
          'expiration',
          'email',
        );
        break;
    }

    this.logger.log(
      `Regra de escalação executada para aprovação ${approval.id}`,
    );
  }

  /**
   * Adicionar entrada no histórico
   */
  private async addHistory(
    approvalId: string,
    action: string,
    data: {
      performedById?: string;
      performedByEmail?: string;
      performedByName?: string;
      previousStatus?: string;
      newStatus?: string;
      comments?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<void> {
    const history = this.historyRepository.create({
      approvalId,
      action,
      ...data,
    });

    await this.historyRepository.save(history);
  }
}
