/**
 * time-logs — extracted from KanbanService.
 */
import { KanbanService } from './kanban.service';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, ILike, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { KanbanBoardEntity, KanbanBoardMember } from './entities/kanban-board.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanCardActivityEntity, ActivityType } from './entities/kanban-card-activity.entity';
import { KanbanNotificationEntity } from './entities/kanban-notification.entity';
import { KanbanWorkspaceEntity } from './entities/kanban-workspace.entity';
import { KanbanBoardStarEntity } from './entities/kanban-board-star.entity';
import { KanbanPowerUpEntity } from './entities/kanban-power-up.entity';
import { KanbanTimeLogEntity } from './entities/kanban-time-log.entity';
import { KanbanHourRequestEntity } from './entities/kanban-hour-request.entity';
import { KanbanCardHistoryEntity } from './entities/kanban-card-history.entity';
import { ApprovalEntity } from '../approvals/entities/approval.entity';
import { ApprovalHistoryEntity } from '../approvals/entities/approval-history.entity';
import { KanbanMailService } from './kanban-mail.service';
import { KanbanGateway } from './kanban.gateway';
import { KanbanCardEventPayload, KanbanEventKey } from './power-ups/types';
import { MultiProviderAiService } from '../api-config/services/multi-provider-ai.service';
import { ApiConfigService } from '../api-config/api-config.service';

import { CreateHourRequestDto, CreateTimeLogDto, UpdateTimeLogDto } from './dto/kanban.dto';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
export async function listTimeLogs_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanTimeLogEntity[]> {
  return (service as any).timeLogRepo.find({
    where: { tenantId, cardId },
    order: { loggedDate: 'DESC', createdAt: 'DESC' },
  });
}

export async function addTimeLog_helper(service: KanbanService, tenantId: string, cardId: string, userId: string, dto: CreateTimeLogDto): Promise<KanbanTimeLogEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card não encontrado');

  const today = new Date().toISOString().slice(0, 10);
  const log = (service as any).timeLogRepo.create({
    cardId,
    boardId: card.boardId,
    tenantId,
    userId: userId || null,
    userName: dto.userName ?? null,
    hours: Math.round((dto.hours ?? 0) * 100) / 100,
    description: dto.description ?? null,
    loggedDate: dto.loggedDate ?? today,
  });
  const saved = await (service as any).timeLogRepo.save(log);
  (service as any).logEvent(tenantId, cardId, card.boardId,
    `${dto.userName ?? 'Alguém'} registrou ${dto.hours}h${dto.description ? ` — ${dto.description}` : ''}`
  ).catch(() => {});
  return saved;
}

export async function updateTimeLog_helper(service: KanbanService, tenantId: string, logId: string, userId: string, dto: UpdateTimeLogDto): Promise<KanbanTimeLogEntity> {
  const log = await (service as any).timeLogRepo.findOne({ where: { id: logId, tenantId } });
  if (!log) throw new NotFoundException('Registro não encontrado');
  if (log.userId && log.userId !== userId) throw new ForbiddenException('Sem permissão');
  if (dto.hours !== undefined) log.hours = Math.round(dto.hours * 100) / 100;
  if (dto.description !== undefined) log.description = dto.description ?? null;
  if (dto.loggedDate !== undefined) log.loggedDate = dto.loggedDate;
  return (service as any).timeLogRepo.save(log);
}

export async function deleteTimeLog_helper(service: KanbanService, tenantId: string, logId: string, userId: string): Promise<void> {
  const log = await (service as any).timeLogRepo.findOne({ where: { id: logId, tenantId } });
  if (!log) throw new NotFoundException('Registro não encontrado');
  if (log.userId && log.userId !== userId) throw new ForbiddenException('Sem permissão');
  await (service as any).timeLogRepo.remove(log);
}

export async function listHourRequests_helper(service: KanbanService, tenantId: string, cardId: string): Promise<KanbanHourRequestEntity[]> {
  return (service as any).hourRequestRepo.find({
    where: { tenantId, cardId },
    order: { createdAt: 'DESC' },
  });
}

export async function createHourRequest_helper(service: KanbanService, 
  tenantId: string,
  cardId: string,
  userId: string,
  dto: CreateHourRequestDto,
): Promise<KanbanHourRequestEntity> {
  const card = await (service as any).cardRepo.findOne({ where: { id: cardId, tenantId } });
  if (!card) throw new NotFoundException('Card não encontrado');

  const board = await (service as any).boardRepo.findOne({ where: { id: card.boardId, tenantId } });
  if (!board) throw new NotFoundException('Board não encontrado');

  // Find the manager: board owner or first member with role 'manager'
  const managerId = board.ownerId ?? (board.members as any[]).find((m: any) => m.role === 'manager')?.id ?? null;

  const today = new Date().toISOString().slice(0, 10);
  const hourRequest = (service as any).hourRequestRepo.create({
    cardId,
    boardId: card.boardId,
    tenantId,
    userId: userId || null,
    userName: dto.userName ?? null,
    hours: Math.round((dto.hours ?? 0) * 100) / 100,
    description: dto.description ?? null,
    loggedDate: dto.loggedDate ?? today,
    status: 'pending',
  });
  const savedRequest = await (service as any).hourRequestRepo.save(hourRequest);

  // Create an approval record so it appears in the /approvals screen
  if (managerId) {
    const approval = (service as any).approvalRepo.create({
      title: `Autorização de horas — ${card.title}`,
      description: `${dto.userName ?? 'Usuário'} solicitou ${dto.hours}h para o card "${card.title}".${dto.description ? ` Motivo: ${dto.description}` : ''}`,
      status: 'pending',
      priority: 'medium',
      requesterId: userId || null,
      approverId: managerId,
      tenantId,
      requestData: {
        kanbanHourRequestId: savedRequest.id,
        cardId,
        boardId: card.boardId,
        cardTitle: card.title,
        hours: savedRequest.hours,
        description: dto.description ?? null,
        loggedDate: savedRequest.loggedDate,
        requesterName: dto.userName ?? null,
      },
    } as any);
    const savedApproval = await (service as any).approvalRepo.save(approval);

    // Save approval history
    const history = (service as any).approvalHistoryRepo.create({
      approvalId: savedApproval.id,
      action: 'created',
      performedById: userId || null,
      newStatus: 'pending',
      comments: 'Solicitação de horas criada via Kanban',
    } as any);
    await (service as any).approvalHistoryRepo.save(history).catch(() => {});

    // Link approval ID back to hour request
    savedRequest.approvalId = savedApproval.id;
    await (service as any).hourRequestRepo.save(savedRequest);
  }

  (service as any).logEvent(tenantId, cardId, card.boardId,
    `${dto.userName ?? 'Alguém'} solicitou autorização de ${dto.hours}h`
  ).catch(() => {});

  return savedRequest;
}

export async function cancelHourRequest_helper(service: KanbanService, tenantId: string, requestId: string, userId: string): Promise<void> {
  const req = await (service as any).hourRequestRepo.findOne({ where: { id: requestId, tenantId } });
  if (!req) throw new NotFoundException('Solicitação não encontrada');
  if (req.userId && req.userId !== userId) throw new ForbiddenException('Sem permissão');
  if (req.status !== 'pending') throw new ForbiddenException('Solicitação já foi processada');

  req.status = 'cancelled';
  await (service as any).hourRequestRepo.save(req);

  // Cancel the linked approval
  if (req.approvalId) {
    const approval = await (service as any).approvalRepo.findOne({ where: { id: req.approvalId, tenantId: req.tenantId } });
    if (approval && approval.status === 'pending') {
      approval.status = 'cancelled';
      await (service as any).approvalRepo.save(approval);

      const history = (service as any).approvalHistoryRepo.create({
        approvalId: approval.id,
        action: 'cancelled',
        performedById: userId || null,
        previousStatus: 'pending',
        newStatus: 'cancelled',
        comments: 'Solicitação cancelada pelo solicitante',
      } as any);
      await (service as any).approvalHistoryRepo.save(history).catch(() => {});
    }
  }
}

export async function handleApprovalKanbanResolved_helper(service: KanbanService, payload: {
  approvalId: string;
  kanbanHourRequestId: string;
  decision: string;
  comments?: string;
  approvedById?: string;
}): Promise<void> {
  const req = await (service as any).hourRequestRepo.findOne({ where: { id: payload.kanbanHourRequestId } });
  if (!req || req.status !== 'pending') return;

  const newStatus = payload.decision === 'approved' ? 'approved' : 'rejected';
  req.status = newStatus;
  req.reviewedBy = payload.approvedById ?? null;
  req.reviewedAt = new Date();
  req.reviewNote = payload.comments ?? null;
  await (service as any).hourRequestRepo.save(req);

  if (newStatus === 'approved') {
    // Create the actual time log
    const log = (service as any).timeLogRepo.create({
      cardId: req.cardId,
      boardId: req.boardId,
      tenantId: req.tenantId,
      userId: req.userId,
      userName: req.userName,
      hours: req.hours,
      description: req.description,
      loggedDate: req.loggedDate,
    });
    await (service as any).timeLogRepo.save(log);

    (service as any).logEvent(req.tenantId, req.cardId, req.boardId,
      `${req.userName ?? 'Alguém'} teve ${req.hours}h aprovadas e registradas`
    ).catch(() => {});

    (service as any).logger.log(`Hour request ${req.id} approved — time log created`);
  } else {
    (service as any).logEvent(req.tenantId, req.cardId, req.boardId,
      `Solicitação de ${req.hours}h de ${req.userName ?? 'alguém'} foi reprovada`
    ).catch(() => {});

    (service as any).logger.log(`Hour request ${req.id} rejected`);
  }
}
