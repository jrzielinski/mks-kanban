import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Orçamento de IA por tenant — a ÚNICA trava que não é gamável por divisão de
 * card. Um teto por CARD ou por TAREFA é sempre furável (crie mais cards/tarefas
 * e o teto reseta); um saldo por TENANT não é — não importa quantos cards ou
 * quão divididos, o gasto sai do MESMO saldo.
 *
 * SEM FREE-TIER DE IA: `balanceUsd` nasce em 0. Sem saldo pago e sem BYOK, o
 * gate em KanbanAiBudgetService NEGA a execução antes de qualquer chamada de
 * IA — "não pagou não leva" (decisão explícita do produto, 2026-07-01).
 *
 * BYOK: se o tenant configurou a própria chave (`byokApiKey`), o gate PULA a
 * checagem de saldo — o custo é do usuário, não nosso.
 */
@Entity('kanban_ai_budgets')
export class KanbanAiBudgetEntity {
  @PrimaryColumn({ name: 'tenant_id' })
  tenantId: string;

  /** Saldo pré-pago em USD. Debitado ATOMICAMENTE (UPDATE ... WHERE balance >= custo)
   *  no momento do dispatch — nunca depois, nunca com "aumentar ou dividir?". */
  @Column({ type: 'decimal', precision: 12, scale: 6, default: 0, name: 'balance_usd' })
  balanceUsd: string;

  /** Provider da chave própria do usuário (ex.: 'anthropic', 'openai', 'groq'). */
  @Column({ type: 'varchar', nullable: true, name: 'byok_provider' })
  byokProvider: string | null;

  /** Chave própria do usuário, cifrada (mesmo padrão de KanbanBoardRepoEntity.gitToken). */
  @Column({ type: 'text', nullable: true, name: 'byok_api_key' })
  byokApiKey: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
