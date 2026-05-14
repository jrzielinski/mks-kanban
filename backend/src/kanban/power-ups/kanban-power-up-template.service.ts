// src/kanban/power-ups/kanban-power-up-template.service.ts
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { KanbanPowerUpTemplateEntity, PowerUpStatus } from './kanban-power-up-template.entity';
import { KanbanPowerUpEntity } from '../entities/kanban-power-up.entity';
import { KanbanBoardEntity } from '../entities/kanban-board.entity';
import { KanbanPowerUpLogEntity } from './kanban-power-up-log.entity';
import {
  CreatePowerUpTemplateDto, UpdatePowerUpTemplateDto,
  ApproveTemplateDto, RejectTemplateDto, InstallPowerUpDto,
} from './dto/kanban-power-up.dto';

@Injectable()
export class KanbanPowerUpTemplateService {
  constructor(
    @InjectRepository(KanbanPowerUpTemplateEntity)
    private readonly templateRepo: Repository<KanbanPowerUpTemplateEntity>,
    @InjectRepository(KanbanPowerUpEntity)
    private readonly installRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanBoardEntity)
    private readonly boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanPowerUpLogEntity)
    private readonly logRepo: Repository<KanbanPowerUpLogEntity>,
  ) {}

  private async assertBoardOwner(tenantId: string, boardId: string, userId: string): Promise<KanbanBoardEntity> {
    const board = await this.boardRepo.findOne({
      where: this.isUUID(boardId) ? { id: boardId, tenantId } : ({ slug: boardId, tenantId } as any),
    });
    if (!board) throw new NotFoundException('Board not found');
    if (board.ownerId !== userId) throw new ForbiddenException('Only the board owner can perform this action');
    return board;
  }

  private async findBoard(tenantId: string, boardId: string): Promise<KanbanBoardEntity> {
    const board = await this.boardRepo.findOne({
      where: this.isUUID(boardId) ? { id: boardId, tenantId } : ({ slug: boardId, tenantId } as any),
    });
    if (!board) throw new NotFoundException('Board not found');
    return board;
  }

  private isUUID(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  async listTemplates(tenantId: string, boardId: string, userId: string) {
    const board = await this.findBoard(tenantId, boardId);
    return this.templateRepo.find({ where: { boardId: board.id, tenantId }, order: { createdAt: 'DESC' } });
  }

  async createTemplate(tenantId: string, boardId: string, userId: string, dto: CreatePowerUpTemplateDto) {
    const board = await this.assertBoardOwner(tenantId, boardId, userId);
    const tpl = this.templateRepo.create({
      ...dto,
      tenantId,
      boardId: board.id,
      createdBy: userId,
      status: 'draft',
      icon: dto.icon ?? '⚡',
      configSchema: dto.configSchema ?? [],
      triggerEvents: dto.triggerEvents ?? [],
    });
    return this.templateRepo.save(tpl);
  }

  async updateTemplate(tenantId: string, id: string, userId: string, dto: UpdatePowerUpTemplateDto) {
    const tpl = await this.templateRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Template not found');
    if (tpl.createdBy !== userId) throw new ForbiddenException();
    if (!['draft', 'rejected'].includes(tpl.status)) throw new BadRequestException('Only draft or rejected templates can be edited');
    Object.assign(tpl, dto);
    return this.templateRepo.save(tpl);
  }

  async submitTemplate(tenantId: string, id: string, userId: string) {
    const tpl = await this.templateRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Template not found');
    if (tpl.createdBy !== userId) throw new ForbiddenException();
    if (!['draft', 'rejected'].includes(tpl.status)) throw new BadRequestException('Template is not in draft or rejected status');
    tpl.status = 'pending';
    tpl.rejectionReason = null;
    return this.templateRepo.save(tpl);
  }

  async deleteTemplate(tenantId: string, id: string, userId: string) {
    const tpl = await this.templateRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Template not found');
    if (tpl.createdBy !== userId) throw new ForbiddenException();
    if (!['draft', 'rejected'].includes(tpl.status)) throw new BadRequestException('Only draft or rejected templates can be deleted');
    await this.templateRepo.remove(tpl);
  }

  private assertAdmin(role: string) {
    if (role !== 'admin') throw new ForbiddenException('Tenant admin only');
  }

  async listPending(tenantId: string, role: string) {
    this.assertAdmin(role);
    return this.templateRepo.find({ where: { tenantId, status: 'pending' }, order: { updatedAt: 'DESC' } });
  }

  async listLibrary(tenantId: string, role: string) {
    this.assertAdmin(role);
    return this.templateRepo.find({
      where: { tenantId, status: In(['published_tenant', 'published_template']) },
      order: { updatedAt: 'DESC' },
    });
  }

  async approveTemplate(tenantId: string, id: string, role: string, dto: ApproveTemplateDto) {
    this.assertAdmin(role);
    const tpl = await this.templateRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Template not found');
    if (tpl.status !== 'pending') throw new BadRequestException('Template is not pending');
    const statusMap: Record<string, PowerUpStatus> = {
      board: 'approved',
      tenant: 'published_tenant',
      template: 'published_template',
    };
    tpl.status = statusMap[dto.scope];
    return this.templateRepo.save(tpl);
  }

  async rejectTemplate(tenantId: string, id: string, role: string, dto: RejectTemplateDto) {
    this.assertAdmin(role);
    const tpl = await this.templateRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('Template not found');
    if (tpl.status !== 'pending') throw new BadRequestException('Template is not pending');
    tpl.status = 'rejected';
    tpl.rejectionReason = dto.reason;
    return this.templateRepo.save(tpl);
  }

  async listAvailable(tenantId: string, boardId: string, userId: string) {
    const board = await this.findBoard(tenantId, boardId);
    return this.templateRepo.find({
      where: [
        { tenantId, status: 'approved', boardId: board.id },
        { tenantId, status: 'published_tenant' },
        { tenantId, status: 'published_template' },
      ],
      order: { name: 'ASC' },
    });
  }

  async installTemplate(tenantId: string, boardId: string, userId: string, dto: InstallPowerUpDto) {
    const board = await this.assertBoardOwner(tenantId, boardId, userId);
    const tpl = await this.templateRepo.findOne({ where: { id: dto.templateId, tenantId } });
    if (!tpl) throw new NotFoundException('Template not found');
    const installable: PowerUpStatus[] = ['approved', 'published_tenant', 'published_template'];
    if (!installable.includes(tpl.status)) throw new BadRequestException('Template is not available for installation');
    if (tpl.status === 'approved' && tpl.boardId !== board.id) throw new ForbiddenException('Template is approved only for a different board');

    const installation = this.installRepo.create({
      boardId: board.id,
      tenantId,
      type: null,
      templateId: dto.templateId,
      config: dto.config ?? {},
      enabled: true,
    });
    return this.installRepo.save(installation);
  }

  async listLogs(tenantId: string, installationId: string, userId: string) {
    const installation = await this.installRepo.findOne({ where: { id: installationId, tenantId } });
    if (!installation) throw new NotFoundException('Installation not found');
    await this.assertBoardOwner(tenantId, installation.boardId, userId);
    return this.logRepo.find({
      where: { installationId },
      order: { executedAt: 'DESC' },
      take: 100,
    });
  }

  async seedDefaultTemplates(tenantId: string): Promise<KanbanPowerUpTemplateEntity[]> {
    const SYSTEM_BOARD_ID = '00000000-0000-0000-0000-000000000000';
    const SYSTEM_USER_ID = 'system';

    const defaults: Partial<KanbanPowerUpTemplateEntity>[] = [
      {
        name: 'Slack Notifier',
        icon: '💬',
        description: 'Sends a Slack notification when a card is moved to a list.',
        mode: 'simple',
        triggerEvents: ['card.moved'],
        url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK',
        configSchema: [
          { key: 'webhookUrl', label: 'Slack Webhook URL', type: 'url', required: true, placeholder: 'https://hooks.slack.com/services/...' },
        ],
        status: 'published_template',
      },
      {
        name: 'Auto-Archive Done',
        icon: '📦',
        description: 'Automatically archives cards when moved to the "Done" list.',
        mode: 'builder',
        triggerEvents: ['card.moved'],
        url: null,
        responseMapping: [
          {
            condition: { field: 'list.name', operator: '==', value: 'Done' },
            action: 'moveCard',
            params: { listId: '{{card.listId}}' },
          },
        ],
        configSchema: [],
        status: 'published_template',
      },
      {
        name: 'Auto-Assign Creator',
        icon: '👤',
        description: 'Automatically assigns the card creator as a member when a card is created.',
        mode: 'builder',
        triggerEvents: ['card.created'],
        url: null,
        responseMapping: [
          {
            action: 'assignMember',
            params: { userId: '{{event.actor.id}}' },
          },
        ],
        configSchema: [],
        status: 'published_template',
      },
      {
        name: 'Due Date Setter',
        icon: '📅',
        description: 'Sets a due date 7 days from now when a card is created.',
        mode: 'builder',
        triggerEvents: ['card.created'],
        url: null,
        responseMapping: [
          {
            action: 'setDue',
            params: { daysOffset: '7' },
          },
        ],
        configSchema: [],
        status: 'published_template',
      },
    ];

    const results: KanbanPowerUpTemplateEntity[] = [];

    for (const def of defaults) {
      const existing = await this.templateRepo.findOne({
        where: { tenantId, name: def.name, boardId: SYSTEM_BOARD_ID },
      });
      if (existing) {
        results.push(existing);
        continue;
      }
      const tpl = this.templateRepo.create({
        ...def,
        tenantId,
        boardId: SYSTEM_BOARD_ID,
        createdBy: SYSTEM_USER_ID,
        icon: def.icon ?? '⚡',
        configSchema: def.configSchema ?? [],
        triggerEvents: (def.triggerEvents ?? []) as any,
      });
      results.push(await this.templateRepo.save(tpl));
    }

    return results;
  }
}
