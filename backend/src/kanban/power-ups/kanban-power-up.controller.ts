// src/kanban/power-ups/kanban-power-up.controller.ts
import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Request, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { KanbanPowerUpTemplateService } from './kanban-power-up-template.service';
import {
  CreatePowerUpTemplateDto, UpdatePowerUpTemplateDto,
  ApproveTemplateDto, RejectTemplateDto, InstallPowerUpDto,
} from './dto/kanban-power-up.dto';

@Controller({ version: '1' })
export class KanbanPowerUpController {
  constructor(private readonly svc: KanbanPowerUpTemplateService) {}

  @Get('kanban/power-ups/templates/defaults')
  async defaultTemplates(@Request() req: any) {
    // Public endpoint — tenantId extracted from JWT if present, otherwise use header
    const tenantId: string = req?.user?.tenantId ?? req?.headers?.['x-tenant-id'] ?? 'system';
    return this.svc.seedDefaultTemplates(tenantId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('kanban/boards/:boardId/power-up-templates')
  list(@Param('boardId') boardId: string, @Request() req: any) {
    return this.svc.listTemplates(req.user.tenantId, boardId, String(req.user.id));
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('kanban/boards/:boardId/power-up-templates')
  create(@Param('boardId') boardId: string, @Body() dto: CreatePowerUpTemplateDto, @Request() req: any) {
    return this.svc.createTemplate(req.user.tenantId, boardId, String(req.user.id), dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Put('kanban/power-up-templates/:id')
  update(@Param('id') id: string, @Body() dto: UpdatePowerUpTemplateDto, @Request() req: any) {
    return this.svc.updateTemplate(req.user.tenantId, id, String(req.user.id), dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('kanban/power-up-templates/:id/submit')
  submit(@Param('id') id: string, @Request() req: any) {
    return this.svc.submitTemplate(req.user.tenantId, id, String(req.user.id));
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete('kanban/power-up-templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Request() req: any) {
    await this.svc.deleteTemplate(req.user.tenantId, id, String(req.user.id));
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('kanban/power-up-templates/pending')
  pending(@Request() req: any) {
    return this.svc.listPending(req.user.tenantId, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('kanban/power-up-templates/library')
  library(@Request() req: any) {
    return this.svc.listLibrary(req.user.tenantId, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('kanban/power-up-templates/:id/approve')
  approve(@Param('id') id: string, @Body() dto: ApproveTemplateDto, @Request() req: any) {
    return this.svc.approveTemplate(req.user.tenantId, id, req.user.role, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('kanban/power-up-templates/:id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectTemplateDto, @Request() req: any) {
    return this.svc.rejectTemplate(req.user.tenantId, id, req.user.role, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('kanban/boards/:boardId/power-ups/available')
  available(@Param('boardId') boardId: string, @Request() req: any) {
    return this.svc.listAvailable(req.user.tenantId, boardId, String(req.user.id));
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('kanban/boards/:boardId/power-ups/install')
  install(@Param('boardId') boardId: string, @Body() dto: InstallPowerUpDto, @Request() req: any) {
    return this.svc.installTemplate(req.user.tenantId, boardId, String(req.user.id), dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('kanban/power-up-installations/:id/logs')
  logs(@Param('id') id: string, @Request() req: any) {
    return this.svc.listLogs(req.user.tenantId, id, String(req.user.id));
  }
}
