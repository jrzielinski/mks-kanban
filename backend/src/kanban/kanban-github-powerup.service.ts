// src/kanban/kanban-github-powerup.service.ts
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import axios from 'axios';
import * as crypto from 'crypto';
import { KanbanPowerUpEntity, KanbanGithubConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';
import { KanbanListEntity } from './entities/kanban-list.entity';
import { KanbanBoardEntity } from './entities/kanban-board.entity';
import { KanbanCardActivityEntity } from './entities/kanban-card-activity.entity';

const GH_ISSUE_NUMBER = '__githubIssueNumber';
const GH_ISSUE_URL = '__githubIssueUrl';
const GH_PR_NUMBER = '__githubPrNumber';
const GH_PR_URL = '__githubPrUrl';
const GH_BRANCH = '__githubBranch';

@Injectable()
export class KanbanGithubPowerUpService {
  private readonly logger = new Logger(KanbanGithubPowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanListEntity) private listRepo: Repository<KanbanListEntity>,
    @InjectRepository(KanbanBoardEntity) private boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanCardActivityEntity) private activityRepo: Repository<KanbanCardActivityEntity>,
  ) {}

  // ── HELPERS ─────────────────────────────────────────────────────────────

  private api(token: string) {
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };
  }

  private async getGithubPowerUps(boardId: string, tenantId: string): Promise<{ pu: KanbanPowerUpEntity; cfg: KanbanGithubConfig }[]> {
    const pups = await this.powerUpRepo.find({ where: { boardId, tenantId, type: 'github', enabled: true } });
    return pups.map(pu => ({ pu, cfg: pu.config as KanbanGithubConfig })).filter(p => p.cfg.token && p.cfg.repoOwner && p.cfg.repoName);
  }

  private async logEvent(tenantId: string, cardId: string, boardId: string, text: string): Promise<void> {
    await this.activityRepo.save(this.activityRepo.create({
      tenantId, cardId, boardId, type: 'event', text, userId: 'system', userName: 'GitHub Sync',
    })).catch(() => {});
  }

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);
  }

  private verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
    const hmac = crypto.createHmac('sha256', secret);
    const digest = `sha256=${hmac.update(payload).digest('hex')}`;
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  }

  // ── KANBAN → GITHUB ────────────────────────────────────────────────────

  /** Card created → create GitHub issue + optional branch */
  @OnEvent('kanban.card.created')
  async onCardCreated(payload: { cardId: string; boardId: string; tenantId: string }): Promise<void> {
    const { cardId, boardId, tenantId } = payload;
    const ghPups = await this.getGithubPowerUps(boardId, tenantId);
    if (ghPups.length === 0) return;

    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card || (card.customFields as any)?.[GH_ISSUE_NUMBER]) return;

    for (const { cfg } of ghPups) {
      if (!cfg.syncOnCreate) continue;
      try {
        // Create GitHub issue
        const issueResp = await axios.post(
          `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/issues`,
          {
            title: card.title,
            body: card.description || '',
            labels: card.labels?.map(l => l.text).filter(Boolean) || [],
          },
          this.api(cfg.token),
        );

        const issueNumber = issueResp.data.number;
        const issueUrl = issueResp.data.html_url;

        const fields: Record<string, any> = {
          ...(card.customFields || {}),
          [GH_ISSUE_NUMBER]: issueNumber,
          [GH_ISSUE_URL]: issueUrl,
        };

        // Create feature branch if enabled
        if (cfg.createBranchOnCard) {
          try {
            const prefix = cfg.branchPrefix || 'feature/';
            const branchName = `${prefix}${issueNumber}-${this.slugify(card.title)}`;

            // Get default branch SHA
            const repoResp = await axios.get(
              `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}`,
              this.api(cfg.token),
            );
            const defaultBranch = repoResp.data.default_branch;
            const refResp = await axios.get(
              `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/git/ref/heads/${defaultBranch}`,
              this.api(cfg.token),
            );
            const sha = refResp.data.object.sha;

            await axios.post(
              `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/git/refs`,
              { ref: `refs/heads/${branchName}`, sha },
              this.api(cfg.token),
            );

            fields[GH_BRANCH] = branchName;
            await this.logEvent(tenantId, cardId, boardId, `Branch \`${branchName}\` criada no GitHub`);
          } catch (err) {
            this.logger.warn(`Failed to create branch for card ${cardId}: ${err.message}`);
          }
        }

        await this.cardRepo.update(card.id, { customFields: fields });
        await this.logEvent(tenantId, cardId, boardId, `Issue #${issueNumber} criada no GitHub`);
        this.logger.log(`Created GitHub issue #${issueNumber} for card ${cardId}`);
      } catch (err) {
        this.logger.warn(`Failed to create GitHub issue for card ${cardId}: ${err.message}`);
      }
    }
  }

  /** Comment added → sync to GitHub issue */
  @OnEvent('kanban.card.commented')
  async onCardCommented(payload: { cardId: string; boardId: string; tenantId: string; text: string; userName: string }): Promise<void> {
    const { cardId, boardId, tenantId, text, userName } = payload;
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) return;

    const issueNumber = (card.customFields as any)?.[GH_ISSUE_NUMBER];
    if (!issueNumber) return;

    const ghPups = await this.getGithubPowerUps(boardId, tenantId);
    for (const { cfg } of ghPups) {
      if (!cfg.syncOnComment) continue;
      try {
        await axios.post(
          `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/issues/${issueNumber}/comments`,
          { body: `**${userName}** (via Kanban):\n\n${text}` },
          this.api(cfg.token),
        );
      } catch (err) {
        this.logger.warn(`Failed to sync comment to GitHub #${issueNumber}: ${err.message}`);
      }
    }
  }

  // ── GITHUB → KANBAN (Webhook receiver) ─────────────────────────────────

  async handleGithubWebhook(
    boardId: string,
    tenantId: string,
    event: string,
    body: any,
    signature?: string,
    rawBody?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const ghPups = await this.getGithubPowerUps(boardId, tenantId);
    if (ghPups.length === 0) return { ok: false, message: 'No active GitHub power-up for this board' };

    // Validate webhook signature if secret configured
    const { cfg } = ghPups[0];
    if (cfg.webhookSecret && signature && rawBody) {
      if (!this.verifyWebhookSignature(cfg.webhookSecret, rawBody, signature)) {
        return { ok: false, message: 'Invalid webhook signature' };
      }
    }

    // ── PR events
    if (event === 'pull_request') {
      return this.handlePREvent(boardId, tenantId, body, ghPups);
    }

    // ── Issue events
    if (event === 'issues') {
      return this.handleIssueEvent(boardId, tenantId, body, ghPups);
    }

    // ── Issue/PR comment events
    if (event === 'issue_comment') {
      return this.handleCommentEvent(boardId, tenantId, body, ghPups);
    }

    return { ok: true, message: `Event ${event} received but not processed` };
  }

  private async handlePREvent(
    boardId: string,
    tenantId: string,
    body: any,
    ghPups: { pu: KanbanPowerUpEntity; cfg: KanbanGithubConfig }[],
  ): Promise<{ ok: boolean; message: string }> {
    const action = body.action;
    const pr = body.pull_request;
    if (!pr) return { ok: false, message: 'No PR data in webhook' };

    const prNumber = pr.number;
    const prUrl = pr.html_url;
    const prBranch = pr.head?.ref;

    // Try to find card by PR number, branch name, or mentioned issue
    let card = await this.findCardByGithubField(boardId, tenantId, GH_PR_NUMBER, prNumber);

    // Try to match by branch name
    if (!card && prBranch) {
      card = await this.findCardByGithubField(boardId, tenantId, GH_BRANCH, prBranch);
    }

    // Try to match by issue reference in PR body (e.g. "Closes #123")
    if (!card && pr.body) {
      const issueMatch = pr.body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
      if (issueMatch) {
        card = await this.findCardByGithubField(boardId, tenantId, GH_ISSUE_NUMBER, parseInt(issueMatch[1]));
      }
    }

    if (!card) return { ok: true, message: `PR #${prNumber} received but no linked card found` };

    // Link PR to card
    const fields = {
      ...(card.customFields || {}),
      [GH_PR_NUMBER]: prNumber,
      [GH_PR_URL]: prUrl,
    };
    await this.cardRepo.update(card.id, { customFields: fields });

    if (action === 'opened') {
      await this.logEvent(tenantId, card.id, boardId, `PR #${prNumber} aberta no GitHub: ${pr.title}`);
    } else if (action === 'closed' && pr.merged) {
      // PR merged → move card to target list
      const { cfg } = ghPups[0];
      if (cfg.targetListId) {
        const targetList = await this.listRepo.findOne({ where: { id: cfg.targetListId, boardId } });
        if (targetList && card.listId !== cfg.targetListId) {
          await this.cardRepo.update(card.id, { listId: cfg.targetListId, position: 0 });
          await this.logEvent(tenantId, card.id, boardId, `Card movido para "${targetList.title}" após merge da PR #${prNumber}`);
          this.logger.log(`Moved card ${card.id} to list ${cfg.targetListId} after PR #${prNumber} merged`);
        }
      }
      await this.logEvent(tenantId, card.id, boardId, `PR #${prNumber} mergeada no GitHub`);
    } else if (action === 'closed' && !pr.merged) {
      await this.logEvent(tenantId, card.id, boardId, `PR #${prNumber} fechada sem merge`);
    }

    return { ok: true, message: `PR #${prNumber} ${action} processed` };
  }

  private async handleIssueEvent(
    boardId: string,
    tenantId: string,
    body: any,
    ghPups: { pu: KanbanPowerUpEntity; cfg: KanbanGithubConfig }[],
  ): Promise<{ ok: boolean; message: string }> {
    const action = body.action;
    const issue = body.issue;
    if (!issue) return { ok: false, message: 'No issue data' };

    const issueNumber = issue.number;

    // Find existing linked card
    let card = await this.findCardByGithubField(boardId, tenantId, GH_ISSUE_NUMBER, issueNumber);

    // Issue created in GitHub → create card
    if (action === 'opened' && !card) {
      const { cfg } = ghPups[0];
      if (!cfg.syncOnCreate) return { ok: true, message: 'syncOnCreate disabled' };

      const firstList = await this.listRepo.findOne({
        where: { boardId, isArchived: false },
        order: { position: 'ASC' },
      });
      if (!firstList) return { ok: false, message: 'No list found in board' };

      const lastCard = await this.cardRepo
        .createQueryBuilder('card')
        .where('card.list_id = :listId', { listId: firstList.id })
        .orderBy('card.position', 'DESC')
        .getOne();

      const newCard = this.cardRepo.create({
        tenantId,
        boardId,
        listId: firstList.id,
        title: issue.title,
        description: issue.body || '',
        position: (lastCard?.position ?? 0) + 1,
        labels: (issue.labels || []).map((l: any) => ({ text: l.name, color: `#${l.color}` })),
        customFields: {
          [GH_ISSUE_NUMBER]: issueNumber,
          [GH_ISSUE_URL]: issue.html_url,
        },
      });
      const saved = await this.cardRepo.save(newCard);
      await this.logEvent(tenantId, saved.id, boardId, `Card criado a partir da issue #${issueNumber} do GitHub`);
      this.logger.log(`Created card ${saved.id} from GitHub issue #${issueNumber}`);
      return { ok: true, message: `Card created from issue #${issueNumber}` };
    }

    // Issue closed → move to target list
    if (action === 'closed' && card) {
      const { cfg } = ghPups[0];
      if (cfg.targetListId && card.listId !== cfg.targetListId) {
        await this.cardRepo.update(card.id, { listId: cfg.targetListId, position: 0 });
        await this.logEvent(tenantId, card.id, boardId, `Card movido após fechar issue #${issueNumber} no GitHub`);
      }
    }

    // Issue reopened → log
    if (action === 'reopened' && card) {
      await this.logEvent(tenantId, card.id, boardId, `Issue #${issueNumber} reaberta no GitHub`);
    }

    return { ok: true, message: `Issue #${issueNumber} ${action} processed` };
  }

  private async handleCommentEvent(
    boardId: string,
    tenantId: string,
    body: any,
    ghPups: { pu: KanbanPowerUpEntity; cfg: KanbanGithubConfig }[],
  ): Promise<{ ok: boolean; message: string }> {
    if (body.action !== 'created') return { ok: true, message: 'Ignored non-create comment' };

    const issue = body.issue;
    const comment = body.comment;
    if (!issue || !comment) return { ok: false, message: 'No issue/comment data' };

    const card = await this.findCardByGithubField(boardId, tenantId, GH_ISSUE_NUMBER, issue.number);
    if (!card) return { ok: true, message: 'No linked card' };

    const { cfg } = ghPups[0];
    if (!cfg.syncOnComment) return { ok: true, message: 'Comment sync disabled' };

    // Don't sync comments we sent ourselves (avoid loop)
    if (comment.body?.includes('(via Kanban)')) return { ok: true, message: 'Skipped own comment' };

    const authorName = comment.user?.login || 'GitHub';
    await this.activityRepo.save(this.activityRepo.create({
      tenantId,
      cardId: card.id,
      boardId,
      type: 'comment',
      text: `[GitHub · ${authorName}] ${comment.body}`,
      userId: 'github-sync',
      userName: `GitHub · ${authorName}`,
    }));

    return { ok: true, message: `Comment synced for issue #${issue.number}` };
  }

  private async findCardByGithubField(boardId: string, tenantId: string, field: string, value: any): Promise<KanbanCardEntity | null> {
    const cards = await this.cardRepo
      .createQueryBuilder('c')
      .where('c.tenant_id = :tenantId', { tenantId })
      .andWhere('c.board_id = :boardId', { boardId })
      .andWhere(`c.custom_fields ->> '${field}' = :value`, { value: String(value) })
      .getMany();
    return cards[0] || null;
  }

  // ── UTILITY: Link card to existing PR/Issue ────────────────────────────

  async linkCardToIssue(tenantId: string, cardId: string, issueNumber: number): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const ghPups = await this.getGithubPowerUps(card.boardId, tenantId);
    if (ghPups.length === 0) throw new UnprocessableEntityException('GitHub power-up not configured on this board.');

    const { cfg } = ghPups[0];
    try {
      const resp = await axios.get(
        `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/issues/${issueNumber}`,
        this.api(cfg.token),
      );
      const fields = {
        ...(card.customFields || {}),
        [GH_ISSUE_NUMBER]: issueNumber,
        [GH_ISSUE_URL]: resp.data.html_url,
      };
      await this.cardRepo.update(card.id, { customFields: fields });
      await this.logEvent(tenantId, cardId, card.boardId, `Card vinculado à issue #${issueNumber} do GitHub`);
    } catch {
      throw new NotFoundException(`GitHub issue #${issueNumber} not found`);
    }
  }

  async linkCardToPR(tenantId: string, cardId: string, prNumber: number): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const ghPups = await this.getGithubPowerUps(card.boardId, tenantId);
    if (ghPups.length === 0) throw new UnprocessableEntityException('GitHub power-up not configured on this board.');

    const { cfg } = ghPups[0];
    try {
      const resp = await axios.get(
        `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/pulls/${prNumber}`,
        this.api(cfg.token),
      );
      const fields = {
        ...(card.customFields || {}),
        [GH_PR_NUMBER]: prNumber,
        [GH_PR_URL]: resp.data.html_url,
      };
      await this.cardRepo.update(card.id, { customFields: fields });
      await this.logEvent(tenantId, cardId, card.boardId, `Card vinculado à PR #${prNumber} do GitHub`);
    } catch {
      throw new NotFoundException(`GitHub PR #${prNumber} not found`);
    }
  }

  /** Create a GitHub issue from the card title + description, then link it */
  async createIssueFromCard(tenantId: string, cardId: string): Promise<{ number: number; html_url: string }> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const ghPups = await this.getGithubPowerUps(card.boardId, tenantId);
    if (ghPups.length === 0) throw new UnprocessableEntityException('GitHub power-up not configured on this board. Enable it in board settings first.');

    const { cfg } = ghPups[0];
    const labels: string[] = card.labels?.map((l: any) => l.text).filter(Boolean) || [];

    const resp = await axios.post(
      `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/issues`,
      { title: card.title, body: card.description || '', labels },
      this.api(cfg.token),
    );

    const issueNumber = resp.data.number;
    const html_url = resp.data.html_url;

    await this.cardRepo.update(card.id, {
      customFields: {
        ...(card.customFields || {}),
        [GH_ISSUE_NUMBER]: issueNumber,
        [GH_ISSUE_URL]: html_url,
      },
    });
    await this.logEvent(tenantId, cardId, card.boardId, `Issue #${issueNumber} criada no GitHub a partir deste card`);
    return { number: issueNumber, html_url };
  }

  /** List open issues for linking UI */
  async listRepoIssues(tenantId: string, boardId: string, state = 'open'): Promise<any[]> {
    const ghPups = await this.getGithubPowerUps(boardId, tenantId);
    if (ghPups.length === 0) return [];
    const { cfg } = ghPups[0];
    try {
      const resp = await axios.get(
        `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/issues`,
        { ...this.api(cfg.token), params: { state, per_page: 30 } },
      );
      return (resp.data || []).filter((i: any) => !i.pull_request).map((i: any) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.html_url,
        labels: (i.labels || []).map((l: any) => l.name),
        createdAt: i.created_at,
      }));
    } catch (err) {
      this.logger.warn(`Failed to list GitHub issues: ${err.message}`);
      return [];
    }
  }

  /** List open PRs for linking UI */
  async listRepoPRs(tenantId: string, boardId: string, state = 'open'): Promise<any[]> {
    const ghPups = await this.getGithubPowerUps(boardId, tenantId);
    if (ghPups.length === 0) return [];
    const { cfg } = ghPups[0];
    try {
      const resp = await axios.get(
        `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}/pulls`,
        { ...this.api(cfg.token), params: { state, per_page: 30 } },
      );
      return (resp.data || []).map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        merged: p.merged_at != null,
        draft: p.draft,
        url: p.html_url,
        branch: p.head?.ref,
        createdAt: p.created_at,
      }));
    } catch (err) {
      this.logger.warn(`Failed to list GitHub PRs: ${err.message}`);
      return [];
    }
  }
}
