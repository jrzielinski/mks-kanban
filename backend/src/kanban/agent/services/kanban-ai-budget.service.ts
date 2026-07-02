import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanAiBudgetEntity } from '../entities/kanban-ai-budget.entity';
import { EncryptionService } from '../../../credentials/services/encryption.service';
import { ExecType } from '../dto/kanban-agent.dto';

/**
 * Estimativa CONSERVADORA de custo por tipo de execução, em USD. É uma cobrança
 * FLAT no momento do disparo — não é o custo real medido (o caminho embarcado do
 * mks-code ainda não captura costUsd de verdade; é um TODO conhecido em
 * agent-bridge/in-process.ts). Até esse hook fechar, a estimativa É o mecanismo
 * de proteção: cobra o pior caso na hora, não confia em medir depois.
 * Ajustável por env sem precisar mexer em código (mesmo padrão do gptapi/billing.constants.ts).
 */
function envCost(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const COST_ESTIMATE: Record<ExecType, number> = {
  code: envCost('AI_COST_ESTIMATE_CODE', 0.15),
  custom: envCost('AI_COST_ESTIMATE_CUSTOM', 0.15), // prompt livre = tratado como código (pior caso)
  tests: envCost('AI_COST_ESTIMATE_TESTS', 0.1),
  mockup: envCost('AI_COST_ESTIMATE_MOCKUP', 0.1),
  analysis: envCost('AI_COST_ESTIMATE_ANALYSIS', 0.05),
  review: envCost('AI_COST_ESTIMATE_REVIEW', 0.05),
};

export type BudgetDecision =
  | { allowed: true; reservedUsd: number; viaByok: boolean }
  | { allowed: false; reason: string };

@Injectable()
export class KanbanAiBudgetService {
  private readonly logger = new Logger(KanbanAiBudgetService.name);

  constructor(
    @InjectRepository(KanbanAiBudgetEntity)
    private readonly budgetRepo: Repository<KanbanAiBudgetEntity>,
    private readonly encryptionService: EncryptionService,
  ) {}

  estimateCost(execType: ExecType): number {
    return COST_ESTIMATE[execType] ?? COST_ESTIMATE.code;
  }

  /**
   * Garante que existe uma linha de orçamento pro tenant. SEM FREE-TIER: nasce
   * com balanceUsd=0 — um tenant novo, sem pagar nada e sem BYOK, é NEGADO na
   * primeira tentativa. É a decisão do produto, não um bug.
   */
  private async ensureRow(tenantId: string): Promise<KanbanAiBudgetEntity> {
    let row = await this.budgetRepo.findOne({ where: { tenantId } });
    if (!row) {
      row = this.budgetRepo.create({ tenantId, balanceUsd: '0' });
      try {
        row = await this.budgetRepo.save(row);
      } catch {
        // corrida: outra chamada criou primeiro — relê
        row = await this.budgetRepo.findOne({ where: { tenantId } });
      }
    }
    return row as KanbanAiBudgetEntity;
  }

  /**
   * O GATE. Chamado uma vez por tentativa de dispatch, ANTES de qualquer
   * chamada de IA. Duas saídas possíveis, sem meio-termo — nunca "quer
   * aumentar ou dividir em cards menores?" (essa pergunta É o furo):
   *
   *  - BYOK configurado → libera na hora, reservedUsd=0 (custo é do usuário).
   *  - Sem BYOK → debita o saldo do tenant ATOMICAMENTE (um único UPDATE com
   *    WHERE balance >= custo). Se não sobrar saldo, nega — hard stop.
   *
   * A trava é por TENANT, não por card/tarefa: dividir em 1, 5 ou 1000 cards
   * não muda nada — todos debitam do MESMO saldo.
   */
  async authorize(tenantId: string, execType: ExecType): Promise<BudgetDecision> {
    const row = await this.ensureRow(tenantId);

    if (row.byokApiKey) {
      this.logger.log(`[ai-budget] ${tenantId}: BYOK ativo — libera sem checar saldo`);
      return { allowed: true, reservedUsd: 0, viaByok: true };
    }

    const cost = this.estimateCost(execType);

    // UPDATE atômico condicionado ao saldo — corrida-segura sem lock explícito.
    // Se duas execuções chegarem "ao mesmo tempo", só uma (ou nenhuma) passa
    // pela condição WHERE; a outra recebe affected=0 e é negada.
    const result = await this.budgetRepo
      .createQueryBuilder()
      .update(KanbanAiBudgetEntity)
      .set({ balanceUsd: () => `balance_usd - ${cost}` })
      .where('tenant_id = :tenantId', { tenantId })
      .andWhere('balance_usd >= :cost', { cost })
      .execute();

    const affected = result.affected ?? 0;
    if (affected === 0) {
      this.logger.warn(`[ai-budget] ${tenantId}: saldo insuficiente pra execução tipo=${execType} (custo=$${cost})`);
      return {
        allowed: false,
        reason:
          'Sem saldo de IA nesta conta. Assine um plano ou configure sua própria chave de IA (BYOK) para continuar.',
      };
    }

    this.logger.log(`[ai-budget] ${tenantId}: reservado $${cost} (tipo=${execType})`);
    return { allowed: true, reservedUsd: cost, viaByok: false };
  }

  /** Credita saldo (chamado pelo webhook de pagamento — fora do escopo de hoje;
   *  o método existe pronto pra quando o billing for plugado). */
  async creditBalance(tenantId: string, amountUsd: number): Promise<void> {
    await this.ensureRow(tenantId);
    await this.budgetRepo
      .createQueryBuilder()
      .update(KanbanAiBudgetEntity)
      .set({ balanceUsd: () => `balance_usd + ${amountUsd}` })
      .where('tenant_id = :tenantId', { tenantId })
      .execute();
  }

  /** Configura BYOK — a partir daqui o tenant nunca mais é gateado por saldo. */
  async setByok(tenantId: string, provider: string, apiKey: string): Promise<void> {
    const row = await this.ensureRow(tenantId);
    row.byokProvider = provider;
    row.byokApiKey = this.encryptionService.encrypt(apiKey);
    await this.budgetRepo.save(row);
  }

  async clearByok(tenantId: string): Promise<void> {
    const row = await this.ensureRow(tenantId);
    row.byokProvider = null;
    row.byokApiKey = null;
    await this.budgetRepo.save(row);
  }

  async getStatus(tenantId: string): Promise<{ balanceUsd: number; byok: boolean }> {
    const row = await this.ensureRow(tenantId);
    return { balanceUsd: Number(row.balanceUsd), byok: !!row.byokApiKey };
  }
}
