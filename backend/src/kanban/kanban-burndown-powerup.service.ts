// src/kanban/kanban-burndown-powerup.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanPowerUpEntity, KanbanBurndownConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanCardHistoryEntity } from './entities/kanban-card-history.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';

export interface BurndownDataPoint {
  date: string;           // ISO date (YYYY-MM-DD)
  ideal: number;          // valor ideal restante
  actual: number;         // valor real restante
  completed: number;      // acumulado concluído
  added: number;          // itens adicionados ao sprint (escopo adicional)
}

export interface BurndownChartData {
  sprintStartDate: string;
  sprintEndDate: string;
  totalScope: number;       // total de cards/pontos no início
  currentScope: number;     // total atual (incluindo adicionados)
  completedCount: number;   // total concluído
  remainingCount: number;   // restante
  dataPoints: BurndownDataPoint[];
  velocity: number;         // cards/pontos por dia
  projectedEndDate: string | null; // data estimada de conclusão
}

@Injectable()
export class KanbanBurndownPowerUpService {
  private readonly logger = new Logger(KanbanBurndownPowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanCardHistoryEntity) private historyRepo: Repository<KanbanCardHistoryEntity>,
    @InjectRepository(KanbanListEntity) private listRepo: Repository<KanbanListEntity>,
  ) {}

  /**
   * Calcula os dados do burndown chart para um board
   */
  async getBurndownData(tenantId: string, boardId: string): Promise<BurndownChartData> {
    const powerUp = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'burndown', enabled: true },
    });
    if (!powerUp) {
      throw new Error('Burndown power-up not enabled for this board');
    }

    const config = powerUp.config as KanbanBurndownConfig;
    const trackByPoints = config.trackingField === 'points' && config.pointsFieldId;
    const doneListIds = config.doneListIds || [];
    const sprintDays = config.sprintDurationDays || 14;

    // Calcular datas do sprint
    const sprintStart = config.sprintStartDate
      ? new Date(config.sprintStartDate)
      : new Date(Date.now() - sprintDays * 86400000);
    sprintStart.setHours(0, 0, 0, 0);

    const sprintEnd = new Date(sprintStart);
    sprintEnd.setDate(sprintEnd.getDate() + sprintDays);
    sprintEnd.setHours(23, 59, 59, 999);

    // Buscar todos os cards do board (não arquivados)
    const allCards = await this.cardRepo.find({
      where: { boardId, tenantId, isArchived: false },
    });

    // Buscar cards arquivados que estiveram no sprint
    const archivedCards = await this.cardRepo.find({
      where: { boardId, tenantId, isArchived: true },
    });

    const allBoardCards = [...allCards, ...archivedCards];

    // Buscar histórico de movimentação dentro do período do sprint
    const history = await this.historyRepo
      .createQueryBuilder('h')
      .where('h.board_id = :boardId', { boardId })
      .andWhere('h.tenant_id = :tenantId', { tenantId })
      .andWhere('h.moved_at >= :start', { start: sprintStart })
      .orderBy('h.moved_at', 'ASC')
      .getMany();

    // Função para obter o valor de um card (1 ou story points)
    const getCardValue = (card: KanbanCardEntity): number => {
      if (trackByPoints && config.pointsFieldId) {
        const points = card.customFields?.[config.pointsFieldId];
        return typeof points === 'number' ? points : 1;
      }
      return 1;
    };

    // Cards criados antes ou no início do sprint (escopo inicial)
    const cardsInSprint = allBoardCards.filter(
      (c) => new Date(c.createdAt) <= sprintEnd,
    );

    // Calcular escopo inicial (cards existentes no início do sprint)
    const initialCards = cardsInSprint.filter(
      (c) => new Date(c.createdAt) <= sprintStart,
    );
    const initialScope = initialCards.reduce((sum, c) => sum + getCardValue(c), 0);

    // Cards adicionados durante o sprint
    const addedDuringSprint = cardsInSprint.filter(
      (c) => new Date(c.createdAt) > sprintStart && new Date(c.createdAt) <= sprintEnd,
    );
    const addedScope = addedDuringSprint.reduce((sum, c) => sum + getCardValue(c), 0);

    const totalScope = initialScope + addedScope;

    // Calcular data points dia a dia
    const dataPoints: BurndownDataPoint[] = [];
    const now = new Date();
    const endDate = now < sprintEnd ? now : sprintEnd;

    // Mapear completions por dia usando history
    const completionsByDay = new Map<string, number>();
    const additionsByDay = new Map<string, number>();

    // Mapear cards que foram movidos para done lists
    for (const entry of history) {
      const day = entry.movedAt.toISOString().slice(0, 10);
      if (doneListIds.includes(entry.toListId)) {
        const card = allBoardCards.find((c) => c.id === entry.cardId);
        const val = card ? getCardValue(card) : 1;
        completionsByDay.set(day, (completionsByDay.get(day) || 0) + val);
      }
    }

    // Mapear adições por dia
    for (const card of addedDuringSprint) {
      const day = new Date(card.createdAt).toISOString().slice(0, 10);
      additionsByDay.set(day, (additionsByDay.get(day) || 0) + getCardValue(card));
    }

    // Gerar pontos do gráfico
    let cumulativeCompleted = 0;
    let cumulativeAdded = 0;
    const currentDay = new Date(sprintStart);

    for (let i = 0; i <= sprintDays; i++) {
      const dayStr = currentDay.toISOString().slice(0, 10);
      const idealRemaining = totalScope - (totalScope / sprintDays) * i;
      const completed = completionsByDay.get(dayStr) || 0;
      const added = additionsByDay.get(dayStr) || 0;

      cumulativeCompleted += completed;
      cumulativeAdded += added;

      const actualRemaining = initialScope + cumulativeAdded - cumulativeCompleted;

      if (currentDay <= endDate) {
        dataPoints.push({
          date: dayStr,
          ideal: Math.max(0, Math.round(idealRemaining * 10) / 10),
          actual: Math.max(0, actualRemaining),
          completed: cumulativeCompleted,
          added: cumulativeAdded,
        });
      } else {
        // Dias futuros: só ideal
        dataPoints.push({
          date: dayStr,
          ideal: Math.max(0, Math.round(idealRemaining * 10) / 10),
          actual: -1, // -1 indica dado futuro
          completed: -1,
          added: -1,
        });
      }

      currentDay.setDate(currentDay.getDate() + 1);
    }

    // Calcular velocidade (cards/pontos concluídos por dia)
    const daysElapsed = Math.max(1, Math.ceil((endDate.getTime() - sprintStart.getTime()) / 86400000));
    const velocity = Math.round((cumulativeCompleted / daysElapsed) * 10) / 10;

    // Projetar data de conclusão
    const remaining = initialScope + cumulativeAdded - cumulativeCompleted;
    let projectedEndDate: string | null = null;
    if (velocity > 0 && remaining > 0) {
      const daysToComplete = Math.ceil(remaining / velocity);
      const projected = new Date(endDate);
      projected.setDate(projected.getDate() + daysToComplete);
      projectedEndDate = projected.toISOString().slice(0, 10);
    } else if (remaining <= 0) {
      projectedEndDate = endDate.toISOString().slice(0, 10);
    }

    // Cards atualmente nas done lists
    const currentlyDone = allCards.filter((c) => doneListIds.includes(c.listId));
    const completedCount = currentlyDone.reduce((sum, c) => sum + getCardValue(c), 0);
    const remainingCount = totalScope - completedCount;

    return {
      sprintStartDate: sprintStart.toISOString().slice(0, 10),
      sprintEndDate: sprintEnd.toISOString().slice(0, 10),
      totalScope,
      currentScope: totalScope,
      completedCount,
      remainingCount: Math.max(0, remainingCount),
      dataPoints,
      velocity,
      projectedEndDate,
    };
  }

  /**
   * Inicia um novo sprint: atualiza a data de início
   */
  async startNewSprint(tenantId: string, boardId: string): Promise<void> {
    const powerUp = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'burndown', enabled: true },
    });
    if (!powerUp) throw new Error('Burndown power-up not enabled');

    const config = powerUp.config as KanbanBurndownConfig;
    config.sprintStartDate = new Date().toISOString().slice(0, 10);
    powerUp.config = config;
    await this.powerUpRepo.save(powerUp);
  }
}
