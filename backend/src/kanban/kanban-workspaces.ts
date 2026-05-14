/**
 * workspaces — extracted from KanbanService.
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
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

export async function listWorkspaces_helper(service: KanbanService, tenantId: string): Promise<KanbanWorkspaceEntity[]> {
  return (service as any).workspaceRepo.find({ where: { tenantId }, order: { createdAt: 'ASC' } });
}

// @ts-ignore
export async function createWorkspace_helper(service: KanbanService, tenantId: string, ownerId: string, dto: CreateWorkspaceDto): Promise<KanbanWorkspaceEntity> {
  const ws = (service as any).workspaceRepo.create({ ...dto, tenantId, ownerId });
  return (service as any).workspaceRepo.save(ws);
}

// @ts-ignore
export async function updateWorkspace_helper(service: KanbanService, tenantId: string, workspaceId: string, dto: UpdateWorkspaceDto): Promise<KanbanWorkspaceEntity> {
  const ws = await (service as any).workspaceRepo.findOne({ where: { id: workspaceId, tenantId } });
  if (!ws) throw new NotFoundException('Workspace not found');
  Object.assign(ws, dto);
  return (service as any).workspaceRepo.save(ws);
}

export async function deleteWorkspace_helper(service: KanbanService, tenantId: string, workspaceId: string): Promise<void> {
  const ws = await (service as any).workspaceRepo.findOne({ where: { id: workspaceId, tenantId } });
  if (!ws) throw new NotFoundException('Workspace not found');
  // Detach boards from this workspace
  await (service as any).boardRepo.update({ workspaceId, tenantId }, { workspaceId: null });
  await (service as any).workspaceRepo.remove(ws);
}
