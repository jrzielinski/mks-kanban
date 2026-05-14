// src/kanban/agent/kanban-agent.controller.ts
import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Request, UseGuards, ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { KanbanAgentService } from './kanban-agent.service';
import { CreateBoardRepoDto, UpdateBoardRepoDto, UpsertListAgentConfigDto, ExecuteCardDto } from './dto/kanban-agent.dto';

function requireTenantId(req: any): string {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new ForbiddenException('Missing tenantId in token');
  return tenantId;
}

@UseGuards(AuthGuard('jwt'))
@Controller({ version: '1' })
export class KanbanAgentController {
  constructor(private readonly kanbanAgentService: KanbanAgentService) {}

  // ── Agent Status ─────────────────────────────────────────────────

  @Get('kanban/agent/status')
  getAgentStatus(@Request() req: any) {
    const tenantId = requireTenantId(req);
    return this.kanbanAgentService.getAgentStatus(tenantId);
  }

  // ── Board Repos ──────────────────────────────────────────────────

  @Get('kanban/boards/:boardId/repos')
  listRepos(@Param('boardId') boardId: string, @Request() req: any) {
    return this.kanbanAgentService.listRepos(boardId, requireTenantId(req));
  }

  @Post('kanban/boards/:boardId/repos')
  createRepo(@Param('boardId') boardId: string, @Body() dto: CreateBoardRepoDto, @Request() req: any) {
    return this.kanbanAgentService.createRepo(boardId, dto, requireTenantId(req));
  }

  @Put('kanban/boards/:boardId/repos/:repoId')
  updateRepo(
    @Param('boardId') boardId: string,
    @Param('repoId') repoId: string,
    @Body() dto: UpdateBoardRepoDto,
    @Request() req: any,
  ) {
    return this.kanbanAgentService.updateRepo(boardId, repoId, dto, requireTenantId(req));
  }

  @Delete('kanban/boards/:boardId/repos/:repoId')
  deleteRepo(@Param('boardId') boardId: string, @Param('repoId') repoId: string, @Request() req: any) {
    return this.kanbanAgentService.deleteRepo(boardId, repoId, requireTenantId(req));
  }

  // ── List Agent Config ────────────────────────────────────────────

  @Get('kanban/lists/:listId/agent-config')
  getListConfig(@Param('listId') listId: string, @Request() req: any) {
    return this.kanbanAgentService.getListConfig(listId, requireTenantId(req));
  }

  @Put('kanban/lists/:listId/agent-config')
  upsertListConfig(
    @Param('listId') listId: string,
    @Body() dto: UpsertListAgentConfigDto,
    @Request() req: any,
  ) {
    const tenantId = requireTenantId(req);
    return this.kanbanAgentService.upsertListConfig(listId, dto.boardId, dto, tenantId);
  }

  @Delete('kanban/lists/:listId/agent-config')
  deleteListConfig(@Param('listId') listId: string, @Request() req: any) {
    return this.kanbanAgentService.deleteListConfig(listId, requireTenantId(req));
  }

  // ── Card Execution ───────────────────────────────────────────────

  @Post('kanban/cards/:cardId/execute')
  executeCard(@Param('cardId') cardId: string, @Body() dto: ExecuteCardDto, @Request() req: any) {
    const tenantId = requireTenantId(req);
    return this.kanbanAgentService.executeCard(
      cardId, dto,
      String(req.user?.id || ''),
      tenantId,
    );
  }

  @Get('kanban/cards/:cardId/agent-context')
  getCardAgentContext(@Param('cardId') cardId: string, @Request() req: any) {
    return this.kanbanAgentService.getCardAgentContext(cardId, requireTenantId(req));
  }

  @Get('kanban/cards/:cardId/executions')
  listExecutions(@Param('cardId') cardId: string, @Request() req: any) {
    return this.kanbanAgentService.listExecutions(cardId, requireTenantId(req));
  }

  @Delete('kanban/cards/:cardId/executions/:id')
  cancelExecution(@Param('id') id: string, @Request() req: any) {
    return this.kanbanAgentService.cancelExecution(id, requireTenantId(req));
  }
}
