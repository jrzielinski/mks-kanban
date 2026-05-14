import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Logger,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ApprovalsService } from './approvals.service';
import {
  CreateApprovalDto,
  ApproveRejectDto,
  ApprovalResponseDto,
  ApprovalListQueryDto,
  ApprovalStatsDto,
} from './dto';
import { ReassignApprovalDto, DelegateApprovalDto } from './dto/reassign-approval.dto';

@ApiTags('Aprovações')
@Controller({ path: 'approvals', version: '1' })
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class ApprovalsController {
  private readonly logger = new Logger(ApprovalsController.name);

  constructor(private readonly approvalsService: ApprovalsService) {}


  /**
   * Criar nova aprovação
   * POST /api/v1/approvals
   */
  @Post()
  @ApiOperation({ summary: 'Criar nova aprovação' })
  @ApiResponse({ status: 201, description: 'Aprovação criada com sucesso', type: ApprovalResponseDto })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  async create(
    @Body() createApprovalDto: CreateApprovalDto,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    const approval = await this.approvalsService.create({
      ...createApprovalDto,
      tenantId,
    });

    return {
      success: true,
      data: approval,
    };
  }

  /**
   * Listar aprovações com filtros
   * GET /api/v1/approvals
   */
  @Get()
  @ApiOperation({ summary: 'Listar aprovações com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista de aprovações' })
  async findAll(
    @Query() query: ApprovalListQueryDto,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    const result = await this.approvalsService.findAll(query, tenantId);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Buscar minhas aprovações pendentes
   * GET /api/v1/approvals/my/pending
   */
  @Get('my/pending')
  @ApiOperation({ summary: 'Buscar aprovações pendentes do usuário autenticado' })
  @ApiResponse({ status: 200, description: 'Lista de aprovações pendentes' })
  async findMyPending(@Req() req: any) {
    const userId = req.user?.id;
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    if (!userId) {
      return {
        success: false,
        message: 'Usuário não autenticado',
      };
    }

    const approvals = await this.approvalsService.findPendingByApprover(userId, tenantId);

    return {
      success: true,
      count: approvals.length,
      data: approvals,
    };
  }

  /**
   * Buscar aprovações pendentes de um grupo
   * GET /api/v1/approvals/group/:groupId/pending
   */
  @Get('group/:groupId/pending')
  @ApiOperation({ summary: 'Buscar aprovações pendentes de um grupo' })
  @ApiResponse({ status: 200, description: 'Lista de aprovações pendentes do grupo' })
  async findGroupPending(
    @Param('groupId') groupId: string,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    const approvals = await this.approvalsService.findPendingByGroup(groupId, tenantId);

    return {
      success: true,
      count: approvals.length,
      data: approvals,
    };
  }

  /**
   * Obter estatísticas de aprovações
   * GET /api/v1/approvals/stats/summary
   */
  @Get('stats/summary')
  @ApiOperation({ summary: 'Obter estatísticas de aprovações' })
  @ApiResponse({ status: 200, description: 'Estatísticas obtidas com sucesso', type: ApprovalStatsDto })
  async getStats(@Req() req: any) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    const stats = await this.approvalsService.getStats(tenantId);

    return {
      success: true,
      data: stats,
    };
  }

  /**
   * Buscar aprovação por ID
   * GET /api/v1/approvals/:id
   */
  @Get(':id')
  @ApiOperation({ summary: 'Buscar aprovação por ID' })
  @ApiResponse({ status: 200, description: 'Aprovação encontrada', type: ApprovalResponseDto })
  @ApiResponse({ status: 404, description: 'Aprovação não encontrada' })
  async findOne(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    const approval = await this.approvalsService.findOne(id, tenantId);

    return {
      success: true,
      data: approval,
    };
  }

  /**
   * Aprovar ou rejeitar aprovação
   * POST /api/v1/approvals/:id/action
   */
  @Post(':id/action')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprovar ou rejeitar aprovação' })
  @ApiResponse({ status: 200, description: 'Ação executada com sucesso', type: ApprovalResponseDto })
  @ApiResponse({ status: 400, description: 'Ação inválida' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Aprovação não encontrada' })
  async approveOrReject(
    @Param('id') id: string,
    @Body() dto: ApproveRejectDto,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    // Se userId não foi fornecido no body, usar o do token
    if (!dto.userId && req.user?.id) {
      dto.userId = req.user.id;
      dto.userEmail = req.user.email;
      dto.userName = req.user.name || req.user.fullName;
    }

    const approval = await this.approvalsService.approveOrReject(id, dto, tenantId);

    return {
      success: true,
      message: `Aprovação ${dto.action === 'approve' ? 'aprovada' : 'rejeitada'} com sucesso`,
      data: approval,
    };
  }

  /**
   * Cancelar aprovação
   * DELETE /api/v1/approvals/:id
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Cancelar aprovação' })
  @ApiResponse({ status: 200, description: 'Aprovação cancelada com sucesso' })
  @ApiResponse({ status: 400, description: 'Não é possível cancelar' })
  @ApiResponse({ status: 403, description: 'Sem permissão' })
  @ApiResponse({ status: 404, description: 'Aprovação não encontrada' })
  async cancel(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    const approval = await this.approvalsService.cancel(id, userId, reason, tenantId);

    return {
      success: true,
      message: 'Aprovação cancelada com sucesso',
      data: approval,
    };
  }

  /**
   * Escalar aprovação
   * POST /api/v1/approvals/:id/escalate
   */
  @Post(':id/escalate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Escalar aprovação para nível superior' })
  @ApiResponse({ status: 200, description: 'Aprovação escalada com sucesso' })
  @ApiResponse({ status: 400, description: 'Não é possível escalar' })
  @ApiResponse({ status: 404, description: 'Aprovação não encontrada' })
  async escalate(
    @Param('id') id: string,
    @Body('escalationLevel') escalationLevel: number,
    @Body('newApproverId') newApproverId?: string,
  ) {
    const approval = await this.approvalsService.escalate(id, escalationLevel, newApproverId);

    return {
      success: true,
      message: `Aprovação escalada para nível ${escalationLevel}`,
      data: approval,
    };
  }

  /**
   * Reatribuir aprovação
   * PUT /api/v1/approvals/:id/reassign
   */
  @Put(':id/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reatribuir aprovação para outro aprovador' })
  @ApiResponse({ status: 200, description: 'Aprovação reatribuída com sucesso' })
  @ApiResponse({ status: 400, description: 'Não é possível reatribuir' })
  @ApiResponse({ status: 404, description: 'Aprovação não encontrada' })
  async reassign(
    @Param('id') id: string,
    @Body() dto: ReassignApprovalDto,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    // Se reassignedBy não foi fornecido, usar o do token
    if (!dto.reassignedBy && req.user?.id) {
      dto.reassignedBy = req.user.id;
    }

    const approval = await this.approvalsService.reassign(
      id,
      dto.newApproverId,
      dto.newApproverGroupId,
      dto.reason,
      dto.reassignedBy,
      tenantId,
    );

    return {
      success: true,
      message: 'Aprovação reatribuída com sucesso',
      data: approval,
    };
  }

  /**
   * Delegar aprovação
   * PUT /api/v1/approvals/:id/delegate
   */
  @Put(':id/delegate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delegar aprovação para outro usuário' })
  @ApiResponse({ status: 200, description: 'Aprovação delegada com sucesso' })
  @ApiResponse({ status: 400, description: 'Não é possível delegar' })
  @ApiResponse({ status: 403, description: 'Sem permissão para delegar' })
  @ApiResponse({ status: 404, description: 'Aprovação não encontrada' })
  async delegate(
    @Param('id') id: string,
    @Body() dto: DelegateApprovalDto,
    @Req() req: any,
  ) {
    const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;

    // Se delegatedBy não foi fornecido, usar o do token
    if (!dto.delegatedBy && req.user?.id) {
      dto.delegatedBy = req.user.id;
    }

    const approval = await this.approvalsService.delegate(
      id,
      dto.delegateToId,
      dto.delegatedBy,
      dto.reason,
      tenantId,
    );

    return {
      success: true,
      message: 'Aprovação delegada com sucesso',
      data: approval,
    };
  }

  /**
   * Processar aprovações expiradas (CRON)
   * POST /api/v1/approvals/process-expired
   */
  @Post('process-expired')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Processar aprovações expiradas (uso interno/CRON)' })
  @ApiResponse({ status: 200, description: 'Aprovações expiradas processadas' })
  async processExpired() {
    const count = await this.approvalsService.processExpiredApprovals();

    return {
      success: true,
      message: `${count} aprovações expiradas foram processadas`,
      count,
    };
  }
}
