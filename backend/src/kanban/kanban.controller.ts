// src/kanban/kanban.controller.ts
import { Controller, Get, Post, Patch, Delete, Body, Param, Req, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { KanbanService } from './kanban.service';
import { KanbanJiraPowerUpService } from './kanban-jira-powerup.service';
import { KanbanGoogleDrivePowerUpService } from './kanban-google-drive-powerup.service';
import { KanbanConfluencePowerUpService } from './kanban-confluence-powerup.service';
import { KanbanGiphyPowerUpService } from './kanban-giphy-powerup.service';
import { KanbanEmailToCardPowerUpService } from './kanban-email-to-card-powerup.service';
import { KanbanBurndownPowerUpService } from './kanban-burndown-powerup.service';
import { KanbanGithubPowerUpService } from './kanban-github-powerup.service';
import {
  CreateBoardDto, UpdateBoardDto, CreateListDto, UpdateListDto, ReorderListsDto,
  CreateCardDto, UpdateCardDto, MoveCardDto, MoveCardToBoardDto, CreateActivityDto, UpdateActivityDto,
  CreateWorkspaceDto, UpdateWorkspaceDto, CreatePowerUpDto, UpdatePowerUpDto, AdvancedSearchDto,
  CreateTimeLogDto, UpdateTimeLogDto, CreateHourRequestDto, InviteByEmailDto,
} from './dto/kanban.dto';

@ApiTags('Kanban')
@Controller({ path: 'kanban', version: '1' })
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class KanbanController {
  constructor(
    private readonly kanban: KanbanService,
    private readonly jiraPowerUp: KanbanJiraPowerUpService,
    private readonly googleDrivePowerUp: KanbanGoogleDrivePowerUpService,
    private readonly confluencePowerUp: KanbanConfluencePowerUpService,
    private readonly giphyPowerUp: KanbanGiphyPowerUpService,
    private readonly emailToCardPowerUp: KanbanEmailToCardPowerUpService,
    private readonly burndownPowerUp: KanbanBurndownPowerUpService,
    private readonly githubPowerUp: KanbanGithubPowerUpService,
  ) {}

  private tenant(req: any): string { return req.headers['x-tenant-id'] ?? req.user?.tenantId ?? 'staff'; }
  private userId(req: any): string { return String(req.user?.id ?? ''); }

  // ── BOARDS ────────────────────────────────────────────────────────────────

  @Get('boards')
  @ApiOperation({ summary: 'List boards' })
  async listBoards(@Req() req: any) {
    return this.kanban.listBoards(this.tenant(req), this.userId(req));
  }

  @Get('templates')
  @ApiOperation({ summary: 'List board templates' })
  async listTemplates(@Req() req: any) {
    return this.kanban.listTemplates(this.tenant(req));
  }

  @Post('boards')
  @ApiOperation({ summary: 'Create board' })
  async createBoard(@Body() dto: CreateBoardDto, @Req() req: any) {
    return this.kanban.createBoard(this.tenant(req), this.userId(req), dto);
  }

  @Get('boards/:boardId')
  @ApiOperation({ summary: 'Get board with lists and cards' })
  async getBoard(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.getBoard(this.tenant(req), boardId);
  }

  @Patch('boards/:boardId')
  @ApiOperation({ summary: 'Update board' })
  async updateBoard(@Param('boardId') boardId: string, @Body() dto: UpdateBoardDto, @Req() req: any) {
    return this.kanban.updateBoard(this.tenant(req), boardId, dto);
  }

  @Delete('boards/:boardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete board' })
  async deleteBoard(@Param('boardId') boardId: string, @Req() req: any) {
    await this.kanban.deleteBoard(this.tenant(req), boardId);
  }

  @Post('boards/:boardId/duplicate')
  @ApiOperation({ summary: 'Duplicate board with all lists and cards' })
  async duplicateBoard(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.duplicateBoard(this.tenant(req), boardId, this.userId(req));
  }

  @Get('boards/:boardId/archived')
  @ApiOperation({ summary: 'Get archived cards and lists for a board' })
  async getArchivedItems(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.getArchivedItems(this.tenant(req), boardId);
  }

  @Post('boards/:boardId/star')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Star a board' })
  async starBoard(@Param('boardId') boardId: string, @Req() req: any) {
    await this.kanban.starBoard(this.tenant(req), boardId, this.userId(req));
  }

  @Delete('boards/:boardId/star')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unstar a board' })
  async unstarBoard(@Param('boardId') boardId: string, @Req() req: any) {
    await this.kanban.unstarBoard(this.tenant(req), boardId, this.userId(req));
  }

  @Post('boards/:boardId/invite-token')
  @ApiOperation({ summary: 'Generate invite link token' })
  async generateInviteToken(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.generateInviteToken(this.tenant(req), boardId);
  }

  @Delete('boards/:boardId/invite-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke invite token' })
  async revokeInviteToken(@Param('boardId') boardId: string, @Req() req: any) {
    await this.kanban.revokeInviteToken(this.tenant(req), boardId);
  }

  @Post('boards/:boardId/invite-email')
  @ApiOperation({ summary: 'Send board invite by email' })
  async inviteByEmail(@Param('boardId') boardId: string, @Body() dto: InviteByEmailDto, @Req() req: any) {
    return this.kanban.inviteByEmail(this.tenant(req), boardId, dto.email, dto.inviterName ?? 'Alguém');
  }

  @Post('boards/:boardId/watch')
  @ApiOperation({ summary: 'Toggle watching a board' })
  async toggleWatchBoard(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.toggleWatchBoard(this.tenant(req), boardId, this.userId(req));
  }

  @Post('boards/:boardId/save-as-template')
  @ApiOperation({ summary: 'Save board as template' })
  async saveAsTemplate(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.saveAsTemplate(this.tenant(req), boardId, this.userId(req));
  }

  @Get('boards/:boardId/power-ups')
  @ApiOperation({ summary: 'List power-ups for board' })
  async listPowerUps(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.listPowerUps(this.tenant(req), boardId);
  }

  @Post('boards/:boardId/power-ups')
  @ApiOperation({ summary: 'Add power-up to board' })
  async createPowerUp(@Param('boardId') boardId: string, @Body() dto: CreatePowerUpDto, @Req() req: any) {
    return this.kanban.createPowerUp(this.tenant(req), boardId, dto);
  }

  // ── LISTS ─────────────────────────────────────────────────────────────────

  @Post('boards/:boardId/lists')
  @ApiOperation({ summary: 'Create list in board' })
  async createList(@Param('boardId') boardId: string, @Body() dto: CreateListDto, @Req() req: any) {
    return this.kanban.createList(this.tenant(req), boardId, dto);
  }

  @Patch('boards/:boardId/lists/reorder')
  @ApiOperation({ summary: 'Reorder lists' })
  async reorderLists(@Param('boardId') boardId: string, @Body() dto: ReorderListsDto, @Req() req: any) {
    await this.kanban.reorderLists(this.tenant(req), boardId, dto);
    return { ok: true };
  }

  @Patch('lists/:listId')
  @ApiOperation({ summary: 'Update list' })
  async updateList(@Param('listId') listId: string, @Body() dto: UpdateListDto, @Req() req: any) {
    return this.kanban.updateList(this.tenant(req), listId, dto);
  }

  @Delete('lists/:listId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteList(@Param('listId') listId: string, @Req() req: any) {
    await this.kanban.deleteList(this.tenant(req), listId);
  }

  @Post('lists/:listId/copy')
  @ApiOperation({ summary: 'Copy list with all cards' })
  async copyList(@Param('listId') listId: string, @Req() req: any) {
    return this.kanban.copyList(this.tenant(req), listId);
  }

  @Post('lists/:listId/clear-completed')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear all done checklist items from list cards' })
  async clearCompleted(@Param('listId') listId: string, @Req() req: any) {
    await this.kanban.clearCompleted(this.tenant(req), listId);
  }

  @Post('lists/:listId/restore')
  @ApiOperation({ summary: 'Restore archived list' })
  async restoreList(@Param('listId') listId: string, @Req() req: any) {
    return this.kanban.restoreList(this.tenant(req), listId);
  }

  // ── CARDS ─────────────────────────────────────────────────────────────────

  @Post('lists/:listId/cards')
  @ApiOperation({ summary: 'Create card in list' })
  async createCard(@Param('listId') listId: string, @Body() dto: CreateCardDto, @Req() req: any) {
    return this.kanban.createCard(this.tenant(req), listId, dto);
  }

  @Patch('cards/:cardId')
  @ApiOperation({ summary: 'Update card' })
  async updateCard(@Param('cardId') cardId: string, @Body() dto: UpdateCardDto, @Req() req: any) {
    return this.kanban.updateCard(this.tenant(req), cardId, dto);
  }

  @Patch('cards/:cardId/move')
  @ApiOperation({ summary: 'Move card to another list' })
  async moveCard(@Param('cardId') cardId: string, @Body() dto: MoveCardDto, @Req() req: any) {
    return this.kanban.moveCard(this.tenant(req), cardId, dto);
  }

  @Post('cards/:cardId/move-to-board')
  @ApiOperation({ summary: 'Move card to another board' })
  async moveCardToBoard(@Param('cardId') cardId: string, @Body() dto: MoveCardToBoardDto, @Req() req: any) {
    return this.kanban.moveCardToBoard(this.tenant(req), cardId, dto);
  }

  @Post('cards/:cardId/duplicate')
  @ApiOperation({ summary: 'Duplicate a card' })
  async duplicateCard(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.duplicateCard(this.tenant(req), cardId);
  }

  @Get('cards/:cardId/history')
  @ApiOperation({ summary: 'Get card movement history (C2)' })
  async getCardHistory(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.getCardHistory(this.tenant(req), cardId);
  }

  @Post('cards/:cardId/links')
  @ApiOperation({ summary: 'Link two cards bidirectionally (C3)' })
  async linkCards(@Param('cardId') cardId: string, @Body() body: { targetCardId: string }, @Req() req: any) {
    return this.kanban.linkCards(this.tenant(req), cardId, body.targetCardId);
  }

  @Delete('cards/:cardId/links/:targetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink two cards (C3)' })
  async unlinkCard(@Param('cardId') cardId: string, @Param('targetId') targetId: string, @Req() req: any) {
    return this.kanban.unlinkCard(this.tenant(req), cardId, targetId);
  }

  @Get('cards/batch')
  @ApiOperation({ summary: 'Get multiple cards by IDs (C3)' })
  async getBatchCards(@Query('ids') ids: string, @Req() req: any) {
    return this.kanban.getBatchCards(this.tenant(req), ids ? ids.split(',') : []);
  }

  @Post('cards/:cardId/blockers')
  @ApiOperation({ summary: 'Add a blocker to a card (C4)' })
  async addBlocker(@Param('cardId') cardId: string, @Body() body: { blockerCardId: string }, @Req() req: any) {
    return this.kanban.addBlocker(this.tenant(req), cardId, body.blockerCardId);
  }

  @Delete('cards/:cardId/blockers/:blockerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a blocker from a card (C4)' })
  async removeBlocker(@Param('cardId') cardId: string, @Param('blockerId') blockerId: string, @Req() req: any) {
    return this.kanban.removeBlocker(this.tenant(req), cardId, blockerId);
  }

  @Post('cards/:cardId/checklists/:groupId/items/:itemId/convert-to-card')
  @ApiOperation({ summary: 'Convert checklist item to card (C1)' })
  async convertChecklistItemToCard(
    @Param('cardId') cardId: string,
    @Param('groupId') groupId: string,
    @Param('itemId') itemId: string,
    @Body() body: { listId?: string },
    @Req() req: any,
  ) {
    return this.kanban.convertChecklistItemToCard(this.tenant(req), cardId, groupId, itemId, body.listId);
  }

  @Post('cards/:cardId/restore')
  @ApiOperation({ summary: 'Restore archived card' })
  async restoreCard(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.restoreCard(this.tenant(req), cardId);
  }

  @Delete('cards/:cardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCard(@Param('cardId') cardId: string, @Req() req: any) {
    await this.kanban.deleteCard(this.tenant(req), cardId);
  }

  // ── ACTIVITIES ────────────────────────────────────────────────────────────

  @Post('cards/:cardId/activities')
  @ApiOperation({ summary: 'Add comment or event to card' })
  async addActivity(@Param('cardId') cardId: string, @Body() dto: CreateActivityDto, @Req() req: any) {
    return this.kanban.addActivity(this.tenant(req), cardId, this.userId(req), dto);
  }

  @Get('cards/:cardId/activities')
  @ApiOperation({ summary: 'List card activities' })
  async listActivities(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.listActivities(this.tenant(req), cardId);
  }

  @Patch('activities/:activityId')
  @ApiOperation({ summary: 'Edit a comment' })
  async updateActivity(@Param('activityId') activityId: string, @Body() dto: UpdateActivityDto, @Req() req: any) {
    return this.kanban.updateActivity(this.tenant(req), activityId, this.userId(req), dto);
  }

  @Delete('activities/:activityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a comment' })
  async deleteActivity(@Param('activityId') activityId: string, @Req() req: any) {
    await this.kanban.deleteActivity(this.tenant(req), activityId, this.userId(req));
  }

  // ── BOARD ACTIVITIES ──────────────────────────────────────────────────────

  @Get('boards/:boardId/activities')
  @ApiOperation({ summary: 'List all activities for a board' })
  async listBoardActivities(@Param('boardId') boardId: string, @Req() req: any) {
    return this.kanban.listBoardActivities(this.tenant(req), boardId);
  }

  // ── CARDS EXTRA ───────────────────────────────────────────────────────────

  @Post('cards/:cardId/watch')
  @ApiOperation({ summary: 'Toggle watching a card' })
  async toggleWatchCard(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.toggleWatchCard(this.tenant(req), cardId, this.userId(req));
  }

  // ── POWER-UPS ─────────────────────────────────────────────────────────────

  @Patch('power-ups/:powerUpId')
  @ApiOperation({ summary: 'Update power-up config' })
  async updatePowerUp(@Param('powerUpId') powerUpId: string, @Body() dto: UpdatePowerUpDto, @Req() req: any) {
    return this.kanban.updatePowerUp(this.tenant(req), powerUpId, dto);
  }

  @Delete('power-ups/:powerUpId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove power-up' })
  async deletePowerUp(@Param('powerUpId') powerUpId: string, @Req() req: any) {
    await this.kanban.deletePowerUp(this.tenant(req), powerUpId);
  }

  // ── INVITE (public - no auth guard needed but share same controller) ──────

  @Get('join/:token')
  @ApiOperation({ summary: 'Preview board invite' })
  async previewInvite(@Param('token') token: string) {
    return this.kanban.getBoardByInviteToken(token);
  }

  @Post('join/:token')
  @ApiOperation({ summary: 'Join board via invite token' })
  async joinByToken(@Param('token') token: string, @Req() req: any) {
    return this.kanban.joinBoardByToken(this.tenant(req), token, this.userId(req), req.user?.name ?? 'Usuário');
  }

  // ── WORKSPACES ────────────────────────────────────────────────────────────

  @Get('workspaces')
  @ApiOperation({ summary: 'List workspaces' })
  async listWorkspaces(@Req() req: any) {
    return this.kanban.listWorkspaces(this.tenant(req));
  }

  @Post('workspaces')
  @ApiOperation({ summary: 'Create workspace' })
  async createWorkspace(@Body() dto: CreateWorkspaceDto, @Req() req: any) {
    return this.kanban.createWorkspace(this.tenant(req), this.userId(req), dto);
  }

  @Patch('workspaces/:workspaceId')
  @ApiOperation({ summary: 'Update workspace' })
  async updateWorkspace(@Param('workspaceId') workspaceId: string, @Body() dto: UpdateWorkspaceDto, @Req() req: any) {
    return this.kanban.updateWorkspace(this.tenant(req), workspaceId, dto);
  }

  @Delete('workspaces/:workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete workspace' })
  async deleteWorkspace(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    await this.kanban.deleteWorkspace(this.tenant(req), workspaceId);
  }

  // ── SEARCH ────────────────────────────────────────────────────────────────

  @Get('search')
  @ApiOperation({ summary: 'Search cards across all boards' })
  async searchCards(@Query('q') q: string, @Req() req: any) {
    return this.kanban.searchCards(this.tenant(req), q ?? '');
  }

  @Get('search/advanced')
  @ApiOperation({ summary: 'Advanced search with filters' })
  async advancedSearch(@Query() dto: AdvancedSearchDto, @Req() req: any) {
    return this.kanban.advancedSearch(this.tenant(req), dto);
  }

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────

  @Get('notifications')
  @ApiOperation({ summary: 'List user notifications' })
  async listNotifications(@Req() req: any) {
    return this.kanban.listNotifications(this.tenant(req), this.userId(req));
  }

  @Post('notifications/:notifId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark notification as read' })
  async markNotificationRead(@Param('notifId') notifId: string, @Req() req: any) {
    await this.kanban.markNotificationRead(this.tenant(req), notifId, this.userId(req));
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllNotificationsRead(@Req() req: any) {
    await this.kanban.markAllNotificationsRead(this.tenant(req), this.userId(req));
  }

  // ── TIME LOGS ─────────────────────────────────────────────────────────────

  @Get('cards/:cardId/time-logs')
  @ApiOperation({ summary: 'List time logs for a card' })
  async listTimeLogs(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.listTimeLogs(this.tenant(req), cardId);
  }

  @Post('cards/:cardId/time-logs')
  @ApiOperation({ summary: 'Add time log to card' })
  async addTimeLog(@Param('cardId') cardId: string, @Body() dto: CreateTimeLogDto, @Req() req: any) {
    return this.kanban.addTimeLog(this.tenant(req), cardId, this.userId(req), dto);
  }

  @Patch('time-logs/:logId')
  @ApiOperation({ summary: 'Update a time log entry' })
  async updateTimeLog(@Param('logId') logId: string, @Body() dto: UpdateTimeLogDto, @Req() req: any) {
    return this.kanban.updateTimeLog(this.tenant(req), logId, this.userId(req), dto);
  }

  @Delete('time-logs/:logId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a time log entry' })
  async deleteTimeLog(@Param('logId') logId: string, @Req() req: any) {
    await this.kanban.deleteTimeLog(this.tenant(req), logId, this.userId(req));
  }

  // ── HOUR REQUESTS ─────────────────────────────────────────────────────────

  @Get('cards/:cardId/hour-requests')
  @ApiOperation({ summary: 'List hour authorization requests for a card' })
  async listHourRequests(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.listHourRequests(this.tenant(req), cardId);
  }

  @Post('cards/:cardId/hour-requests')
  @ApiOperation({ summary: 'Create hour authorization request' })
  async createHourRequest(@Param('cardId') cardId: string, @Body() dto: CreateHourRequestDto, @Req() req: any) {
    return this.kanban.createHourRequest(this.tenant(req), cardId, this.userId(req), dto);
  }

  @Delete('hour-requests/:requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an hour authorization request' })
  async cancelHourRequest(@Param('requestId') requestId: string, @Req() req: any) {
    await this.kanban.cancelHourRequest(this.tenant(req), requestId, this.userId(req));
  }

  // ── GITHUB POWER-UP ─────────────────────────────────────────────────────

  @Post('boards/:boardId/github-webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive GitHub webhook events' })
  async githubWebhook(
    @Param('boardId') boardId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const event = req.headers['x-github-event'] || 'ping';
    const signature = req.headers['x-hub-signature-256'];
    return this.githubPowerUp.handleGithubWebhook(boardId, this.tenant(req), event, body, signature);
  }

  @Post('cards/:cardId/github-create-issue')
  @ApiOperation({ summary: 'Create a GitHub issue from this card and link it' })
  async createGithubIssueFromCard(
    @Param('cardId') cardId: string,
    @Req() req: any,
  ) {
    return this.githubPowerUp.createIssueFromCard(this.tenant(req), cardId);
  }

  @Post('cards/:cardId/github-link-issue')
  @ApiOperation({ summary: 'Link card to a GitHub issue' })
  async linkCardToGithubIssue(
    @Param('cardId') cardId: string,
    @Body() body: { issueNumber: number },
    @Req() req: any,
  ) {
    await this.githubPowerUp.linkCardToIssue(this.tenant(req), cardId, body.issueNumber);
    return { ok: true };
  }

  @Post('cards/:cardId/github-link-pr')
  @ApiOperation({ summary: 'Link card to a GitHub PR' })
  async linkCardToGithubPR(
    @Param('cardId') cardId: string,
    @Body() body: { prNumber: number },
    @Req() req: any,
  ) {
    await this.githubPowerUp.linkCardToPR(this.tenant(req), cardId, body.prNumber);
    return { ok: true };
  }

  @Get('boards/:boardId/github/issues')
  @ApiOperation({ summary: 'List repo issues for linking UI' })
  async listGithubIssues(
    @Param('boardId') boardId: string,
    @Query('state') state: string,
    @Req() req: any,
  ) {
    return this.githubPowerUp.listRepoIssues(this.tenant(req), boardId, state || 'open');
  }

  @Get('boards/:boardId/github/pulls')
  @ApiOperation({ summary: 'List repo PRs for linking UI' })
  async listGithubPRs(
    @Param('boardId') boardId: string,
    @Query('state') state: string,
    @Req() req: any,
  ) {
    return this.githubPowerUp.listRepoPRs(this.tenant(req), boardId, state || 'open');
  }

  // ── VOICE FORMAT / AI FORMAT ──────────────────────────────────────────

  @Post('voice-format')
  @ApiOperation({ summary: 'Format text using AI (voice transcript or markdown formatting)' })
  async voiceFormat(@Body() body: { text: string }, @Req() req: any) {
    return this.kanban.voiceFormat(this.tenant(req), body.text);
  }

  @Post('cards/:cardId/format-description')
  @ApiOperation({ summary: 'Format card description using AI' })
  async formatDescription(@Param('cardId') cardId: string, @Req() req: any) {
    return this.kanban.formatDescription(this.tenant(req), cardId);
  }

  // ── CARD DECOMPOSITION ──────────────────────────────────────────────────

  @Post('cards/:cardId/decompose')
  @ApiOperation({ summary: 'Decompose a complex card into sub-cards using AI' })
  async decomposeCard(
    @Param('cardId') cardId: string,
    @Req() req: any,
  ) {
    const cards = await this.kanban.decomposeCard(this.tenant(req), cardId);
    return { cards, count: cards.length };
  }

  // ── BUTLER NLP ──────────────────────────────────────────────────────────

  @Post('boards/:boardId/butler-parse')
  @ApiOperation({ summary: 'Parse natural language into automation rule via LLM' })
  async parseButlerRule(
    @Param('boardId') boardId: string,
    @Body() body: { text: string },
    @Req() req: any,
  ) {
    return this.kanban.parseButlerRule(this.tenant(req), boardId, body.text);
  }

  // ── JIRA POWER-UP ──────────────────────────────────────────────────────────

  @Post('boards/:boardId/jira-webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive Jira webhook events' })
  async jiraWebhook(
    @Param('boardId') boardId: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.jiraPowerUp.handleJiraWebhook(boardId, this.tenant(req), body);
  }

  @Post('cards/:cardId/jira-link')
  @ApiOperation({ summary: 'Link card to existing Jira issue' })
  async linkCardToJira(
    @Param('cardId') cardId: string,
    @Body() body: { issueKey: string },
    @Req() req: any,
  ) {
    await this.jiraPowerUp.linkCardToJira(this.tenant(req), cardId, body.issueKey);
    return { ok: true };
  }

  @Get('boards/:boardId/jira-statuses')
  @ApiOperation({ summary: 'Fetch Jira project statuses for mapping UI' })
  async getJiraStatuses(
    @Param('boardId') boardId: string,
    @Req() req: any,
  ) {
    return this.jiraPowerUp.getJiraStatuses(this.tenant(req), boardId);
  }

  // ── CARD SNOOZE ─────────────────────────────────────────────────────────

  @Post('cards/:cardId/snooze')
  @ApiOperation({ summary: 'Snooze a card until a specific date' })
  async snoozeCard(
    @Param('cardId') cardId: string,
    @Body() body: { until: string },
    @Req() req: any,
  ) {
    return this.kanban.snoozeCard(this.tenant(req), cardId, body.until);
  }

  @Post('cards/:cardId/unsnooze')
  @ApiOperation({ summary: 'Unsnooze a card immediately' })
  async unsnoozeCard(
    @Param('cardId') cardId: string,
    @Req() req: any,
  ) {
    return this.kanban.unsnoozeCard(this.tenant(req), cardId);
  }

  // ── GOOGLE DRIVE POWER-UP ──────────────────────────────────────────────

  @Get('boards/:boardId/gdrive/files')
  @ApiOperation({ summary: 'List Google Drive files for board' })
  // @ts-ignore
  async listDriveFiles(
    @Param('boardId') boardId: string,
    @Query('folderId') folderId: string,
    @Query('q') q: string,
    @Req() req: any,
  ) {
    return this.googleDrivePowerUp.listFiles(this.tenant(req), boardId, folderId || undefined, q || undefined);
  }

  @Post('cards/:cardId/gdrive-attach')
  @ApiOperation({ summary: 'Attach a Google Drive file to a card' })
  async attachDriveFile(
    @Param('cardId') cardId: string,
    @Body() body: { id: string; name: string; mimeType: string; webViewLink: string; iconLink?: string; thumbnailLink?: string },
    @Req() req: any,
  ) {
    await this.googleDrivePowerUp.attachFileToCard(this.tenant(req), cardId, body);
    return { ok: true };
  }

  // ── CONFLUENCE POWER-UP ────────────────────────────────────────────────

  @Get('boards/:boardId/confluence/search')
  @ApiOperation({ summary: 'Search Confluence pages' })
  async searchConfluencePages(
    @Param('boardId') boardId: string,
    @Query('q') q: string,
    @Query('spaceKey') spaceKey: string,
    @Req() req: any,
  ) {
    return this.confluencePowerUp.searchPages(this.tenant(req), boardId, q || '', spaceKey || undefined);
  }

  @Get('boards/:boardId/confluence/recent')
  @ApiOperation({ summary: 'List recent Confluence pages' })
  async listRecentConfluencePages(
    @Param('boardId') boardId: string,
    @Query('spaceKey') spaceKey: string,
    @Req() req: any,
  ) {
    return this.confluencePowerUp.listRecentPages(this.tenant(req), boardId, spaceKey || undefined);
  }

  @Get('boards/:boardId/confluence/spaces')
  @ApiOperation({ summary: 'List Confluence spaces' })
  async listConfluenceSpaces(
    @Param('boardId') boardId: string,
    @Req() req: any,
  ) {
    return this.confluencePowerUp.listSpaces(this.tenant(req), boardId);
  }

  @Post('cards/:cardId/confluence-link')
  @ApiOperation({ summary: 'Link a Confluence page to a card' })
  async linkConfluencePage(
    @Param('cardId') cardId: string,
    @Body() body: { id: string; title: string; webUrl: string; spaceKey: string },
    @Req() req: any,
  ) {
    await this.confluencePowerUp.linkPageToCard(this.tenant(req), cardId, body);
    return { ok: true };
  }

  @Delete('cards/:cardId/confluence-link/:pageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink a Confluence page from a card' })
  async unlinkConfluencePage(
    @Param('cardId') cardId: string,
    @Param('pageId') pageId: string,
    @Req() req: any,
  ) {
    await this.confluencePowerUp.unlinkPageFromCard(this.tenant(req), cardId, pageId);
  }

  // ── GIPHY POWER-UP ────────────────────────────────────────────────────

  @Get('boards/:boardId/giphy/search')
  @ApiOperation({ summary: 'Search GIFs on Giphy' })
  async searchGiphy(
    @Param('boardId') boardId: string,
    @Query('q') q: string,
    @Query('offset') offset: string,
    @Req() req: any,
  ) {
    return this.giphyPowerUp.search(this.tenant(req), boardId, q || '', parseInt(offset) || 0);
  }

  // ── EMAIL-TO-CARD POWER-UP ──────────────────────────────────────────

  @Post('boards/:boardId/email-to-card/incoming')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive incoming email webhook to create card' })
  async emailToCardWebhook(
    @Param('boardId') boardId: string,
    @Body() body: { from: string; subject: string; body: string; htmlBody?: string; attachments?: any[] },
    @Req() req: any,
  ) {
    const card = await this.emailToCardPowerUp.processIncomingEmail(this.tenant(req), boardId, body);
    return card ? { ok: true, cardId: card.id } : { ok: false, reason: 'not_processed' };
  }

  @Get('boards/:boardId/email-address')
  @ApiOperation({ summary: 'Get email address for Email-to-Card power-up' })
  async getEmailAddress(
    @Param('boardId') boardId: string,
    @Req() req: any,
  ) {
    return this.emailToCardPowerUp.getEmailAddress(this.tenant(req), boardId);
  }

  // ── BURNDOWN CHART POWER-UP ───────────────────────────────────────

  @Get('boards/:boardId/burndown')
  @ApiOperation({ summary: 'Get burndown chart data for a board' })
  async getBurndownData(
    @Param('boardId') boardId: string,
    @Req() req: any,
  ) {
    return this.burndownPowerUp.getBurndownData(this.tenant(req), boardId);
  }

  @Post('boards/:boardId/burndown/new-sprint')
  @ApiOperation({ summary: 'Start a new sprint for burndown tracking' })
  async startNewSprint(
    @Param('boardId') boardId: string,
    @Req() req: any,
  ) {
    await this.burndownPowerUp.startNewSprint(this.tenant(req), boardId);
    return { ok: true };
  }

  @Get('boards/:boardId/giphy/trending')
  @ApiOperation({ summary: 'Get trending GIFs from Giphy' })
  async trendingGiphy(
    @Param('boardId') boardId: string,
    @Query('offset') offset: string,
    @Req() req: any,
  ) {
    return this.giphyPowerUp.trending(this.tenant(req), boardId, parseInt(offset) || 0);
  }
}
