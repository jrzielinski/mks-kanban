import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan, IsNull, Not } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApprovalEntity, ApprovalStatus, ApprovalPriority } from './entities/approval.entity';
import { ApprovalHistoryEntity } from './entities/approval-history.entity';
import { ApprovalReminderEntity, ReminderType, ReminderChannel } from './entities/approval-reminder.entity';
import { ApprovalVotesEntity } from './entities/approval-votes.entity';
import {
  CreateApprovalDto,
  UpdateApprovalDto,
  ApproveRejectDto,
  ApprovalResponseDto,
  ApprovalListQueryDto,
  ApprovalStatsDto,
} from './dto';

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @InjectRepository(ApprovalEntity)
    private readonly approvalsRepository: Repository<ApprovalEntity>,
    @InjectRepository(ApprovalHistoryEntity)
    private readonly historyRepository: Repository<ApprovalHistoryEntity>,
    @InjectRepository(ApprovalReminderEntity)
    private readonly remindersRepository: Repository<ApprovalReminderEntity>,
    @InjectRepository(ApprovalVotesEntity)
    private readonly votesRepository: Repository<ApprovalVotesEntity>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Criar nova aprovação
   */
  async create(createApprovalDto: CreateApprovalDto): Promise<ApprovalResponseDto> {
    this.logger.log(`Criando aprovação: ${createApprovalDto.title}`);

    // Validar que tem pelo menos um aprovador definido
    if (!createApprovalDto.approverId && !createApprovalDto.approverGroupId) {
      throw new BadRequestException('Deve especificar approverId ou approverGroupId');
    }

    // @ts-ignore
    const approval = this.approvalsRepository.create({
      ...createApprovalDto,
      status: 'pending',
      expiresAt: createApprovalDto.expiresAt ? new Date(createApprovalDto.expiresAt) : null,
    });

    const saved = await this.approvalsRepository.save(approval);

    // Adicionar no histórico
    // @ts-ignore
    await this.addHistory(saved.id, 'created', {
      performedById: createApprovalDto.requesterId,
      newStatus: 'pending',
      comments: 'Aprovação criada',
    });

    // @ts-ignore
    this.logger.log(`Aprovação criada com sucesso: ${saved.id}`);
    // @ts-ignore
    return this.mapToResponseDto(saved);
  }

  /**
   * Listar aprovações com filtros e paginação
   */
  async findAll(query: ApprovalListQueryDto, tenantId?: string): Promise<{
    items: ApprovalResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const {
      status,
      approverId,
      approverGroupId,
      flowId,
      priority,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = query;

    const queryBuilder = this.approvalsRepository
      .createQueryBuilder('approval')
      .leftJoinAndSelect('approval.history', 'history')
      .leftJoinAndSelect('approval.reminders', 'reminders');

    // Filtros
    if (tenantId) {
      queryBuilder.andWhere('approval.tenantId = :tenantId', { tenantId });
    }

    if (status) {
      queryBuilder.andWhere('approval.status = :status', { status });
    }

    if (approverId) {
      queryBuilder.andWhere('approval.approverId = :approverId', { approverId });
    }

    if (approverGroupId) {
      queryBuilder.andWhere('approval.approverGroupId = :approverGroupId', { approverGroupId });
    }

    if (flowId) {
      queryBuilder.andWhere('approval.flowId = :flowId', { flowId });
    }

    if (priority) {
      queryBuilder.andWhere('approval.priority = :priority', { priority });
    }

    // Ordenação
    queryBuilder.orderBy(`approval.${sortBy}`, sortOrder);

    // Paginação
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return {
      items: items.map(item => this.mapToResponseDto(item)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Buscar aprovação por ID
   */
  async findOne(id: string, tenantId?: string): Promise<ApprovalResponseDto> {
    const approval = await this.approvalsRepository.findOne({
      where: tenantId ? { id, tenantId } : { id },
      relations: ['history', 'reminders'],
    });

    if (!approval) {
      throw new NotFoundException(`Aprovação ${id} não encontrada`);
    }

    return this.mapToResponseDto(approval);
  }

  /**
   * Buscar aprovações pendentes de um aprovador
   */
  async findPendingByApprover(approverId: string, tenantId?: string): Promise<ApprovalResponseDto[]> {
    const where: any = {
      status: 'pending',
      approverId,
    };

    if (tenantId) {
      where.tenantId = tenantId;
    }

    const approvals = await this.approvalsRepository.find({
      where,
      relations: ['history'],
      order: { priority: 'DESC', createdAt: 'ASC' },
    });

    return approvals.map(approval => this.mapToResponseDto(approval));
  }

  /**
   * Buscar aprovações pendentes de um grupo
   */
  async findPendingByGroup(approverGroupId: string, tenantId?: string): Promise<ApprovalResponseDto[]> {
    const where: any = {
      status: 'pending',
      approverGroupId,
    };

    if (tenantId) {
      where.tenantId = tenantId;
    }

    const approvals = await this.approvalsRepository.find({
      where,
      relations: ['history'],
      order: { priority: 'DESC', createdAt: 'ASC' },
    });

    return approvals.map(approval => this.mapToResponseDto(approval));
  }

  /**
   * Aprovar ou rejeitar aprovação
   */
  async approveOrReject(id: string, dto: ApproveRejectDto, tenantId?: string): Promise<ApprovalResponseDto> {
    const approval = await this.approvalsRepository.findOne({
      where: tenantId ? { id, tenantId } : { id },
      relations: ['votes'],
    });

    if (!approval) {
      throw new NotFoundException(`Aprovação ${id} não encontrada`);
    }

    if (approval.status !== 'pending') {
      throw new BadRequestException(`Aprovação já foi ${approval.status}`);
    }

    const strategy = approval.approvalStrategy || 'first_to_respond';

    // Lógica baseada na estratégia
    switch (strategy) {
      case 'first_to_respond':
        return await this.handleFirstToRespond(approval, dto);

      case 'all_must_approve':
        return await this.handleAllMustApprove(approval, dto);

      case 'sequential':
        return await this.handleSequential(approval, dto);

      default:
        throw new BadRequestException(`Estratégia de aprovação desconhecida: ${strategy}`);
    }
  }

  /**
   * Estratégia: First to Respond
   * Qualquer membro do grupo pode aprovar/rejeitar (comportamento original)
   */
  private async handleFirstToRespond(
    approval: ApprovalEntity,
    dto: ApproveRejectDto,
  ): Promise<ApprovalResponseDto> {
    // Verificar permissão (comparar como string para evitar mismatch number vs string do JWT)
    if (approval.approverId && String(approval.approverId) !== String(dto.userId)) {
      throw new ForbiddenException('Você não tem permissão para esta aprovação');
    }

    // Atualizar status
    const newStatus: ApprovalStatus = dto.action === 'approve' ? 'approved' : 'rejected';
    approval.status = newStatus;
    // @ts-ignore
    approval.approvedById = dto.userId;
    approval.comments = dto.comments || approval.comments;
    approval.responseData = dto.responseData || approval.responseData;
    approval.respondedAt = new Date();

    await this.approvalsRepository.save(approval);

    // Adicionar no histórico
    await this.addHistory(approval.id, dto.action, {
      performedById: dto.userId,
      performedByEmail: dto.userEmail,
      performedByName: dto.userName,
      previousStatus: 'pending',
      newStatus,
      comments: dto.comments,
    });

    this.logger.log(`Aprovação ${approval.id} foi ${newStatus} por ${dto.userId}`);

    // Emitir evento para retomar flow que está aguardando esta aprovação
    this.emitApprovalResolved(approval, newStatus);

    return this.mapToResponseDto(approval);
  }

  /**
   * Estratégia: All Must Approve
   * Todos os membros do grupo devem votar antes de finalizar
   */
  private async handleAllMustApprove(
    approval: ApprovalEntity,
    dto: ApproveRejectDto,
  ): Promise<ApprovalResponseDto> {
    // Verificar se já votou
    const existingVote = await this.votesRepository.findOne({
      where: { approvalId: approval.id, voterId: dto.userId },
    });

    if (existingVote) {
      throw new BadRequestException('Você já votou nesta aprovação');
    }

    // Registrar voto
    const vote = this.votesRepository.create({
      approvalId: approval.id,
      voterId: dto.userId,
      decision: dto.action === 'approve' ? 'approved' : 'rejected',
      comments: dto.comments,
      responseData: dto.responseData,
    });

    await this.votesRepository.save(vote);

    // Adicionar no histórico
    await this.addHistory(approval.id, `vote_${dto.action}`, {
      performedById: dto.userId,
      performedByEmail: dto.userEmail,
      performedByName: dto.userName,
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: dto.comments,
      metadata: { decision: vote.decision },
    });

    // Se alguém rejeitou, rejeitar toda a aprovação imediatamente
    if (dto.action === 'reject') {
      approval.status = 'rejected';
      // @ts-ignore
      approval.approvedById = dto.userId;
      approval.respondedAt = new Date();
      await this.approvalsRepository.save(approval);

      await this.addHistory(approval.id, 'rejected', {
        performedById: dto.userId,
        previousStatus: 'pending',
        newStatus: 'rejected',
        comments: 'Rejeitado - estratégia "all must approve"',
      });

      this.logger.log(`Aprovação ${approval.id} rejeitada por ${dto.userId} (all must approve)`);
      this.emitApprovalResolved(approval, 'rejected');
      return this.mapToResponseDto(approval);
    }

    // Verificar se todos os membros do grupo já votaram
    // TODO: Aqui você precisaria consultar o serviço de grupos para saber quantos membros tem
    // Por agora, vamos assumir que approverGroupId contém essa informação ou será verificado externamente

    this.logger.log(`Voto registrado para aprovação ${approval.id} por ${dto.userId}`);

    // Recarregar com votos
    const updated = await this.approvalsRepository.findOne({
      where: { id: approval.id },
      relations: ['votes', 'history', 'reminders'],
    });

    return this.mapToResponseDto(updated!);
  }

  /**
   * Estratégia: Sequential
   * Aprovadores devem aprovar em sequência definida
   */
  private async handleSequential(
    approval: ApprovalEntity,
    dto: ApproveRejectDto,
  ): Promise<ApprovalResponseDto> {
    if (!approval.sequentialApprovers || approval.sequentialApprovers.length === 0) {
      throw new BadRequestException('Aprovadores sequenciais não definidos');
    }

    const currentIndex = approval.currentApproverIndex || 0;
    const currentApprover = approval.sequentialApprovers[currentIndex];

    if (!currentApprover) {
      throw new BadRequestException('Índice de aprovador inválido');
    }

    // Verificar se é o aprovador corrente
    if (currentApprover.id !== dto.userId) {
      throw new ForbiddenException('Não é sua vez de aprovar');
    }

    // Registrar voto
    const vote = this.votesRepository.create({
      approvalId: approval.id,
      voterId: dto.userId,
      decision: dto.action === 'approve' ? 'approved' : 'rejected',
      comments: dto.comments,
      responseData: dto.responseData,
    });

    await this.votesRepository.save(vote);

    // Adicionar no histórico
    await this.addHistory(approval.id, `vote_${dto.action}_step_${currentIndex}`, {
      performedById: dto.userId,
      performedByEmail: dto.userEmail,
      performedByName: dto.userName,
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: dto.comments,
      metadata: { step: currentIndex, decision: vote.decision },
    });

    // Se rejeitou, rejeitar toda a aprovação
    if (dto.action === 'reject') {
      approval.status = 'rejected';
      approval.approvedById = dto.userId;
      approval.respondedAt = new Date();
      await this.approvalsRepository.save(approval);

      await this.addHistory(approval.id, 'rejected', {
        performedById: dto.userId,
        previousStatus: 'pending',
        newStatus: 'rejected',
        comments: `Rejeitado na etapa ${currentIndex + 1} de ${approval.sequentialApprovers.length}`,
      });

      this.logger.log(`Aprovação ${approval.id} rejeitada por ${dto.userId} na etapa ${currentIndex + 1}`);
      this.emitApprovalResolved(approval, 'rejected');
      return this.mapToResponseDto(approval);
    }

    // Se aprovou, avançar para próximo ou finalizar
    const nextIndex = currentIndex + 1;

    if (nextIndex >= approval.sequentialApprovers.length) {
      // Último aprovador - finalizar
      approval.status = 'approved';
      approval.approvedById = dto.userId;
      approval.respondedAt = new Date();
      approval.currentApproverIndex = nextIndex;

      await this.approvalsRepository.save(approval);

      await this.addHistory(approval.id, 'approved', {
        performedById: dto.userId,
        previousStatus: 'pending',
        newStatus: 'approved',
        comments: `Aprovado - completou todas as ${approval.sequentialApprovers.length} etapas`,
      });

      this.logger.log(`Aprovação ${approval.id} aprovada após completar todas as etapas`);
      this.emitApprovalResolved(approval, 'approved');
    } else {
      // Avançar para próximo aprovador
      approval.currentApproverIndex = nextIndex;
      await this.approvalsRepository.save(approval);

      const nextApprover = approval.sequentialApprovers[nextIndex];
      await this.addHistory(approval.id, 'advanced', {
        previousStatus: 'pending',
        newStatus: 'pending',
        comments: `Avançou para etapa ${nextIndex + 1} de ${approval.sequentialApprovers.length}`,
        metadata: { nextApproverId: nextApprover.id },
      });

      this.logger.log(`Aprovação ${approval.id} avançou para etapa ${nextIndex + 1}`);
    }

    // Recarregar com votos
    const updated = await this.approvalsRepository.findOne({
      where: { id: approval.id },
      relations: ['votes', 'history', 'reminders'],
    });

    return this.mapToResponseDto(updated!);
  }

  /**
   * Cancelar aprovação
   */
  async cancel(id: string, userId: string, reason: string, tenantId?: string): Promise<ApprovalResponseDto> {
    const approval = await this.approvalsRepository.findOne({
      where: tenantId ? { id, tenantId } : { id },
    });

    if (!approval) {
      throw new NotFoundException(`Aprovação ${id} não encontrada`);
    }

    if (approval.status !== 'pending') {
      throw new BadRequestException(`Não é possível cancelar aprovação com status ${approval.status}`);
    }

    // Apenas o solicitante pode cancelar
    if (approval.requesterId && approval.requesterId !== userId) {
      throw new ForbiddenException('Apenas o solicitante pode cancelar a aprovação');
    }

    approval.status = 'cancelled';
    approval.comments = reason;
    await this.approvalsRepository.save(approval);

    await this.addHistory(id, 'cancelled', {
      performedById: userId,
      previousStatus: 'pending',
      newStatus: 'cancelled',
      comments: reason,
    });

    this.logger.log(`Aprovação ${id} cancelada por ${userId}`);

    return this.mapToResponseDto(approval);
  }

  /**
   * Processar aprovações expiradas
   */
  async processExpiredApprovals(): Promise<number> {
    const now = new Date();

    const expiredApprovals = await this.approvalsRepository.find({
      where: {
        status: 'pending',
        expiresAt: LessThan(now),
      },
    });

    for (const approval of expiredApprovals) {
      approval.status = 'expired';
      await this.approvalsRepository.save(approval);

      await this.addHistory(approval.id, 'expired', {
        previousStatus: 'pending',
        newStatus: 'expired',
        comments: 'Aprovação expirou automaticamente',
      });

      // Enviar notificação de expiração
      await this.sendReminder(approval.id, 'expiration', 'email');
    }

    this.logger.log(`Processadas ${expiredApprovals.length} aprovações expiradas`);
    return expiredApprovals.length;
  }

  /**
   * Enviar lembrete
   */
  async sendReminder(
    approvalId: string,
    reminderType: ReminderType,
    channel: ReminderChannel,
    recipientId?: string,
    recipientEmail?: string,
    recipientPhone?: string,
  ): Promise<void> {
    const reminder = this.remindersRepository.create({
      approvalId,
      reminderType,
      channel,
      recipientId,
      recipientEmail,
      recipientPhone,
    });

    await this.remindersRepository.save(reminder);

    this.logger.log(`Lembrete ${reminderType} enviado para aprovação ${approvalId} via ${channel}`);
  }

  /**
   * Escalar aprovação
   */
  async escalate(id: string, escalationLevel: number, newApproverId?: string): Promise<ApprovalResponseDto> {
    const approval = await this.approvalsRepository.findOne({ where: { id } });

    if (!approval) {
      throw new NotFoundException(`Aprovação ${id} não encontrada`);
    }

    if (approval.status !== 'pending') {
      throw new BadRequestException('Só é possível escalar aprovações pendentes');
    }

    approval.escalationLevel = escalationLevel;
    if (newApproverId) {
      approval.approverId = newApproverId;
    }

    await this.approvalsRepository.save(approval);

    await this.addHistory(id, 'escalated', {
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: `Escalado para nível ${escalationLevel}`,
      metadata: { escalationLevel, newApproverId },
    });

    // Enviar notificação de escalação
    await this.sendReminder(id, 'escalation', 'email');

    this.logger.log(`Aprovação ${id} escalada para nível ${escalationLevel}`);

    return this.mapToResponseDto(approval);
  }

  /**
   * Reatribuir aprovação para outro aprovador
   */
  async reassign(
    id: string,
    newApproverId: string | undefined,
    newApproverGroupId: string | undefined,
    reason: string,
    reassignedBy: string,
    tenantId?: string,
  ): Promise<ApprovalResponseDto> {
    const approval = await this.approvalsRepository.findOne({
      where: tenantId ? { id, tenantId } : { id },
    });

    if (!approval) {
      throw new NotFoundException(`Aprovação ${id} não encontrada`);
    }

    if (approval.status !== 'pending') {
      throw new BadRequestException('Só é possível reatribuir aprovações pendentes');
    }

    // Validar que tem pelo menos um novo aprovador
    if (!newApproverId && !newApproverGroupId) {
      throw new BadRequestException('Deve especificar newApproverId ou newApproverGroupId');
    }

    // Armazenar aprovador anterior
    const previousApproverId = approval.approverId;
    const previousApproverGroupId = approval.approverGroupId;

    // Atualizar aprovador
    approval.reassignedFromId = previousApproverId || previousApproverGroupId;
    approval.reassignmentReason = reason;
    approval.reassignedAt = new Date();
    // @ts-ignore
    approval.approverId = newApproverId;
    // @ts-ignore
    approval.approverGroupId = newApproverGroupId;

    await this.approvalsRepository.save(approval);

    await this.addHistory(id, 'reassigned', {
      performedById: reassignedBy,
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: `Reatribuída: ${reason}`,
      metadata: {
        previousApproverId,
        previousApproverGroupId,
        newApproverId,
        newApproverGroupId,
      },
    });

    this.logger.log(`Aprovação ${id} reatribuída por ${reassignedBy}`);

    return this.mapToResponseDto(approval);
  }

  /**
   * Delegar aprovação para outro usuário temporariamente
   */
  async delegate(
    id: string,
    delegateToId: string,
    delegatedBy: string,
    reason: string | undefined,
    tenantId?: string,
  ): Promise<ApprovalResponseDto> {
    const approval = await this.approvalsRepository.findOne({
      where: tenantId ? { id, tenantId } : { id },
    });

    if (!approval) {
      throw new NotFoundException(`Aprovação ${id} não encontrada`);
    }

    if (approval.status !== 'pending') {
      throw new BadRequestException('Só é possível delegar aprovações pendentes');
    }

    // Verificar se o usuário tem permissão para delegar
    if (approval.approverId !== delegatedBy) {
      throw new ForbiddenException('Apenas o aprovador designado pode delegar sua aprovação');
    }

    approval.delegatedToId = delegateToId;
    approval.delegatedById = delegatedBy;
    approval.delegatedAt = new Date();

    await this.approvalsRepository.save(approval);

    await this.addHistory(id, 'delegated', {
      performedById: delegatedBy,
      previousStatus: 'pending',
      newStatus: 'pending',
      comments: reason || 'Aprovação delegada',
      metadata: {
        delegatedToId: delegateToId,
        delegatedById: delegatedBy,
      },
    });

    this.logger.log(`Aprovação ${id} delegada por ${delegatedBy} para ${delegateToId}`);

    return this.mapToResponseDto(approval);
  }

  /**
   * Obter estatísticas
   */
  async getStats(tenantId?: string): Promise<ApprovalStatsDto> {
    const queryBuilder = this.approvalsRepository.createQueryBuilder('approval');

    if (tenantId) {
      queryBuilder.where('approval.tenantId = :tenantId', { tenantId });
    }

    const [
      pending,
      approved,
      rejected,
      expired,
      cancelled,
      total,
    ] = await Promise.all([
      queryBuilder.clone().andWhere('approval.status = :status', { status: 'pending' }).getCount(),
      queryBuilder.clone().andWhere('approval.status = :status', { status: 'approved' }).getCount(),
      queryBuilder.clone().andWhere('approval.status = :status', { status: 'rejected' }).getCount(),
      queryBuilder.clone().andWhere('approval.status = :status', { status: 'expired' }).getCount(),
      queryBuilder.clone().andWhere('approval.status = :status', { status: 'cancelled' }).getCount(),
      queryBuilder.getCount(),
    ]);

    // Calcular tempo médio de resposta
    const respondedApprovals = await this.approvalsRepository
      .createQueryBuilder('approval')
      .where('approval.respondedAt IS NOT NULL')
      .andWhere(tenantId ? 'approval.tenantId = :tenantId' : '1=1', { tenantId })
      .getMany();

    let averageResponseTimeMinutes: number | undefined;
    if (respondedApprovals.length > 0) {
      const totalMinutes = respondedApprovals.reduce((sum, approval) => {
        const diff = approval.respondedAt!.getTime() - approval.createdAt.getTime();
        return sum + (diff / 1000 / 60); // Converter para minutos
      }, 0);
      averageResponseTimeMinutes = Math.round(totalMinutes / respondedApprovals.length);
    }

    return {
      pending,
      approved,
      rejected,
      expired,
      cancelled,
      total,
      averageResponseTimeMinutes,
    };
  }

  /**
   * Emitir evento quando aprovação é resolvida (para retomar flows pausados)
   */
  private emitApprovalResolved(approval: ApprovalEntity, decision: string): void {
    if (approval.flowExecutionId) {
      this.eventEmitter.emit('approval.resolved', {
        approvalId: approval.id,
        flowExecutionId: approval.flowExecutionId,
        flowId: approval.flowId,
        nodeId: approval.nodeId,
        decision,
        comments: approval.comments,
        responseData: approval.responseData,
        approvedById: approval.approvedById,
      });
      this.logger.log(
        `Evento approval.resolved emitido para flow instance ${approval.flowExecutionId}`,
      );
    }
    if (approval.requestData?.kanbanHourRequestId) {
      this.eventEmitter.emit('approval.kanban.resolved', {
        approvalId: approval.id,
        kanbanHourRequestId: approval.requestData.kanbanHourRequestId,
        decision,
        comments: approval.comments,
        approvedById: approval.approvedById,
      });
      this.logger.log(
        `Evento approval.kanban.resolved emitido para kanban hour request ${approval.requestData.kanbanHourRequestId}`,
      );
    }
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

  /**
   * Mapear entity para DTO
   */
  private mapToResponseDto(approval: ApprovalEntity): ApprovalResponseDto {
    return {
      id: approval.id,
      flowExecutionId: approval.flowExecutionId,
      flowId: approval.flowId,
      nodeId: approval.nodeId,
      status: approval.status,
      requesterId: approval.requesterId,
      approverId: approval.approverId,
      approverGroupId: approval.approverGroupId,
      approvedById: approval.approvedById,
      approvalStrategy: approval.approvalStrategy,
      sequentialApprovers: approval.sequentialApprovers,
      currentApproverIndex: approval.currentApproverIndex,
      requestData: approval.requestData,
      responseData: approval.responseData,
      comments: approval.comments,
      expiresAt: approval.expiresAt,
      respondedAt: approval.respondedAt,
      escalationLevel: approval.escalationLevel,
      priority: approval.priority,
      title: approval.title,
      description: approval.description,
      tenantId: approval.tenantId,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      votes: approval.votes?.map(v => ({
        id: v.id,
        voterId: v.voterId,
        decision: v.decision,
        comments: v.comments,
        responseData: v.responseData,
        votedAt: v.votedAt,
      })),
      history: approval.history?.map(h => ({
        id: h.id,
        action: h.action,
        performedById: h.performedById,
        performedByEmail: h.performedByEmail,
        performedByName: h.performedByName,
        previousStatus: h.previousStatus,
        newStatus: h.newStatus,
        comments: h.comments,
        metadata: h.metadata,
        createdAt: h.createdAt,
      })),
      reminders: approval.reminders?.map(r => ({
        id: r.id,
        reminderType: r.reminderType,
        sentAt: r.sentAt,
        recipientId: r.recipientId,
        recipientEmail: r.recipientEmail,
        recipientPhone: r.recipientPhone,
        channel: r.channel,
        createdAt: r.createdAt,
      })),
    };
  }
}
