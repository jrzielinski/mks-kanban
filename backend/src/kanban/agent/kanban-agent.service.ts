// src/kanban/agent/kanban-agent.service.ts
import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { KanbanBoardRepoEntity } from './entities/kanban-board-repo.entity';
import { KanbanListAgentConfigEntity } from './entities/kanban-list-agent-config.entity';
import { KanbanAgentExecutionEntity } from './entities/kanban-agent-execution.entity';
import { AgentCoreService } from '../../agent-core/agent-core.service';
import { EncryptionService } from '../../credentials/services/encryption.service';
import { KanbanService } from '../kanban.service';
import { KanbanCardEntity, KanbanAttachment } from '../entities/kanban-card.entity';
import { KanbanCardActivityEntity } from '../entities/kanban-card-activity.entity';
import { CreateActivityDto } from '../dto/kanban.dto';
import { CreateBoardRepoDto, UpdateBoardRepoDto, UpsertListAgentConfigDto, ExecuteCardDto, ExecType } from './dto/kanban-agent.dto';
import { KanbanCardEventPayload } from '../power-ups/types';

const LOOP_GUARD_MINUTES = 5;

// Type instructions appended to prompt based on exec type
const TYPE_INSTRUCTIONS: Record<ExecType, string> = {
  code: 'Implement the above. Follow existing code patterns. Create a new branch.',
  analysis: 'Provide a structured business and technical analysis in markdown.',
  mockup: 'Generate an HTML prototype of the described interface.',
  tests: 'Write comprehensive unit and integration tests.',
  review: 'Review the code in the specified branch. Return a structured report.',
  custom: '', // replaced by customPrompt
};

// Exec types that skip git ops (oneshot)
const ONESHOT_TYPES: ExecType[] = ['analysis', 'review'];

@Injectable()
export class KanbanAgentService {
  private readonly logger = new Logger(KanbanAgentService.name);

  constructor(
    @InjectRepository(KanbanBoardRepoEntity)
    private readonly repoRepo: Repository<KanbanBoardRepoEntity>,
    @InjectRepository(KanbanListAgentConfigEntity)
    private readonly configRepo: Repository<KanbanListAgentConfigEntity>,
    @InjectRepository(KanbanAgentExecutionEntity)
    private readonly executionRepo: Repository<KanbanAgentExecutionEntity>,
    @InjectRepository(KanbanCardEntity)
    private readonly cardRepo: Repository<KanbanCardEntity>,
    private readonly agentCoreService: AgentCoreService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => KanbanService))
    private readonly kanbanService: KanbanService,
  ) {}

  // ── Board Repos ──────────────────────────────────────────────────

  async listRepos(boardId: string, tenantId: string): Promise<KanbanBoardRepoEntity[]> {
    return this.repoRepo.find({ where: { boardId, tenantId } });
  }

  async createRepo(boardId: string, dto: CreateBoardRepoDto, tenantId: string): Promise<KanbanBoardRepoEntity> {
    const encryptedToken = dto.gitToken
      ? this.encryptionService.encrypt(dto.gitToken)
      : null;
    const entity = this.repoRepo.create({
      boardId, tenantId,
      name: dto.name,
      repoUrl: dto.repoUrl,
      defaultBranch: dto.defaultBranch || 'main',
      gitToken: encryptedToken,
    });
    return this.repoRepo.save(entity);
  }

  async updateRepo(boardId: string, repoId: string, dto: UpdateBoardRepoDto, tenantId: string): Promise<KanbanBoardRepoEntity> {
    const repo = await this.repoRepo.findOne({ where: { id: repoId, boardId, tenantId } });
    if (!repo) throw new NotFoundException('Repository not found');
    if (dto.name !== undefined) repo.name = dto.name;
    if (dto.repoUrl !== undefined) repo.repoUrl = dto.repoUrl;
    if (dto.defaultBranch !== undefined) repo.defaultBranch = dto.defaultBranch;
    if (dto.gitToken !== undefined) {
      repo.gitToken = dto.gitToken ? this.encryptionService.encrypt(dto.gitToken) : null;
    }
    return this.repoRepo.save(repo);
  }

  async deleteRepo(boardId: string, repoId: string, tenantId: string): Promise<void> {
    const repo = await this.repoRepo.findOne({ where: { id: repoId, boardId, tenantId } });
    if (!repo) throw new NotFoundException('Repository not found');
    await this.repoRepo.remove(repo);
  }

  // ── List Agent Config ────────────────────────────────────────────

  async getListConfig(listId: string, tenantId: string): Promise<KanbanListAgentConfigEntity | null> {
    return this.configRepo.findOne({ where: { listId, tenantId } });
  }

  async upsertListConfig(listId: string, boardId: string, dto: UpsertListAgentConfigDto, tenantId: string): Promise<KanbanListAgentConfigEntity> {
    let config = await this.configRepo.findOne({ where: { listId, tenantId } });
    if (!config) {
      config = this.configRepo.create({ listId, boardId, tenantId });
    }
    Object.assign(config, dto);
    return this.configRepo.save(config);
  }

  async deleteListConfig(listId: string, tenantId: string): Promise<void> {
    await this.configRepo.delete({ listId, tenantId });
  }

  // ── Agent Status ─────────────────────────────────────────────────

  getAgentStatus(tenantId: string): { connected: boolean; agentCount: number } {
    const count = this.agentCoreService.getConnectedAgentsCount(tenantId);
    return { connected: count > 0, agentCount: count };
  }

  // ── Card Agent Context (public endpoint) ─────────────────────────

  async getCardAgentContext(
    cardId: string,
    tenantId: string,
  ): Promise<{ markdown: string; attachments: Array<{ name: string; url: string }> }> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const activities = await this.kanbanService.listActivities(tenantId, cardId);
    const linkedCards = await this.resolveLinkedCards(card.linkedCardIds, tenantId);
    const markdown = this.buildFullContext(card, activities, linkedCards, null, null, undefined, []);

    return {
      markdown,
      attachments: (card.attachments || []).map(a => ({ name: a.name, url: a.url })),
    };
  }

  // ── Card Execution ───────────────────────────────────────────────

  async listExecutions(cardId: string, tenantId: string): Promise<KanbanAgentExecutionEntity[]> {
    return this.executionRepo.find({
      where: { cardId, tenantId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async cancelExecution(execId: string, tenantId: string): Promise<void> {
    const exec = await this.executionRepo.findOne({ where: { id: execId, tenantId } });
    if (!exec || exec.status !== 'running') return;
    await this.executionRepo.update({ id: execId, tenantId }, { status: 'cancelled', completedAt: new Date() });
  }

  async executeCard(
    cardId: string,
    dto: ExecuteCardDto,
    userId: string,
    tenantId: string,
  ): Promise<{ execId: string }> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const listConfig = await this.configRepo.findOne({ where: { listId: card.listId, tenantId } });

    // Resolve repo
    let repoContext: { repoUrl: string; repoBranch?: string; gitToken?: string } | undefined;
    let repoUrl: string | undefined;
    if (dto.repoId) {
      const repo = await this.repoRepo.findOne({ where: { id: dto.repoId, tenantId } });
      if (repo) {
        const decryptedToken = repo.gitToken ? this.encryptionService.decrypt(repo.gitToken) : undefined;
        repoContext = { repoUrl: repo.repoUrl, repoBranch: dto.branch || repo.defaultBranch, gitToken: decryptedToken };
        repoUrl = repo.repoUrl;
      }
    }

    // Gather full context: activities, linked cards, attachments
    const activities = await this.kanbanService.listActivities(tenantId, cardId);
    const linkedCards = await this.resolveLinkedCards(card.linkedCardIds, tenantId);
    const downloadedFiles = await this.resolveCardAttachments(card);

    const prompt = this.buildFullContext(
      card, activities, linkedCards,
      listConfig?.promptPrefix || null,
      dto.execType,
      dto.customPrompt,
      downloadedFiles,
    );

    const execId = uuidv4();

    // Create execution record first (so execId exists before dispatch)
    const exec = this.executionRepo.create({
      id: execId,
      cardId, boardId: card.boardId, listId: card.listId,
      execType: dto.execType,
      prompt,
      repoUrl: repoUrl || null,
      status: 'pending',
      tenantId, userId,
    });
    await this.executionRepo.save(exec);

    // Fire and forget — dispatch runs async
    this.runExecution(exec, card, repoContext, dto.execType, dto.branch, listConfig).catch(err =>
      this.logger.error(`[KanbanAgent] Execution ${execId} unhandled error: ${err.message}`),
    );

    return { execId };
  }

  private async runExecution(
    exec: KanbanAgentExecutionEntity,
    card: KanbanCardEntity,
    repoContext: { repoUrl: string; repoBranch?: string; gitToken?: string } | undefined,
    execType: ExecType,
    branch: string | undefined,
    listConfig: KanbanListAgentConfigEntity | null,
  ): Promise<void> {
    const execId = exec.id;
    await this.executionRepo.update(execId, { status: 'running', startedAt: new Date() });

    try {
      const result = await this.agentCoreService.dispatchTask(
        { id: execId, scopeId: card.boardId, title: card.title },
        exec.tenantId,
        exec.prompt,
        repoContext,
        branch,
        undefined, // cli — agent picks
        50,
        { oneshot: ONESHOT_TYPES.includes(execType), execId },
      );

      await this.executionRepo.update(execId, {
        status: 'completed',
        result: result.content,
        costUsd: result.costUsd as any,
        branchCreated: result.gitInfo?.branch || null,
        gitCommits: result.gitInfo?.commits || null,
        gitPushed: result.gitInfo?.pushed || false,
        completedAt: new Date(),
      });

      // Process agent result: update card checklists, post structured comment
      await this.processAgentResult(exec, card, result.content, result.gitInfo);

      // Move card on success
      if (listConfig?.moveOnCompleteListId) {
        await this.kanbanService.moveCard(
          exec.tenantId,
          exec.cardId,
          { targetListId: listConfig.moveOnCompleteListId, position: 0 } as any,
        ).catch(err => this.logger.warn(`[KanbanAgent] Move on complete failed: ${err.message}`));
      }
    } catch (err: any) {
      await this.executionRepo.update(execId, {
        status: 'failed',
        result: err.message,
        completedAt: new Date(),
      });

      await this.kanbanService.addActivity(
        exec.tenantId,
        exec.cardId,
        exec.userId || 'agent',
        { text: `❌ Agent falhou na execução.\n\n${err.message}`, type: 'comment', userName: 'MakeStudio Agent' } as CreateActivityDto,
      );

      if (listConfig?.moveOnFailListId) {
        await this.kanbanService.moveCard(
          exec.tenantId,
          exec.cardId,
          { targetListId: listConfig.moveOnFailListId, position: 0 } as any,
        ).catch(err2 => this.logger.warn(`[KanbanAgent] Move on fail failed: ${err2.message}`));
      }
    }
  }

  // ── Auto-trigger from column move ───────────────────────────────

  @OnEvent('kanban.card.moved')
  async handleCardMoved(payload: KanbanCardEventPayload): Promise<void> {
    const toListId = (payload.extra?.toListId ?? '') as string;
    const tenantId = payload.tenantId;
    const cardId = payload.cardId;

    const config = await this.configRepo.findOne({
      where: { listId: toListId, tenantId: tenantId, enabled: true },
    });
    if (!config) return;

    // Loop guard: skip if card has running/completed execution in last 5 min
    const recentExec = await this.executionRepo.findOne({
      where: { cardId: cardId, tenantId: tenantId },
      order: { createdAt: 'DESC' },
    });
    if (recentExec) {
      const minutesAgo = (Date.now() - new Date(recentExec.createdAt).getTime()) / 60000;
      if (minutesAgo < LOOP_GUARD_MINUTES && ['running', 'completed'].includes(recentExec.status)) {
        this.logger.log(`[KanbanAgent] Loop guard triggered for card ${cardId}`);
        return;
      }
    }

    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId: tenantId } });
    if (!card) return;

    const execType = (config.defaultExecType || 'analysis') as ExecType;
    let repoContext: { repoUrl: string; repoBranch?: string; gitToken?: string } | undefined;
    let repoUrl: string | undefined;

    if (config.defaultRepoId) {
      const repo = await this.repoRepo.findOne({ where: { id: config.defaultRepoId, tenantId: tenantId } });
      if (repo) {
        const decryptedToken = repo.gitToken ? this.encryptionService.decrypt(repo.gitToken) : undefined;
        repoContext = { repoUrl: repo.repoUrl, repoBranch: config.defaultBranch || repo.defaultBranch, gitToken: decryptedToken };
        repoUrl = repo.repoUrl;
      }
    }

    // Gather full context for auto-triggered execution
    const activities = await this.kanbanService.listActivities(tenantId, cardId);
    const linkedCards = await this.resolveLinkedCards(card.linkedCardIds, tenantId);
    const downloadedFiles = await this.resolveCardAttachments(card);

    const prompt = this.buildFullContext(
      card, activities, linkedCards,
      config.promptPrefix, execType, undefined,
      downloadedFiles,
    );

    const execId = uuidv4();

    const exec = this.executionRepo.create({
      id: execId,
      cardId: card.id, boardId: card.boardId, listId: toListId,
      execType,
      prompt,
      repoUrl: repoUrl || null,
      status: 'pending',
      tenantId: tenantId,
      userId: null,
    });
    await this.executionRepo.save(exec);

    this.runExecution(exec, card, repoContext, execType, config.defaultBranch || undefined, config)
      .catch(err => this.logger.error(`[KanbanAgent] Auto-trigger execution ${execId} error: ${err.message}`));
  }

  // ── Full Context Builder (markdown) ──────────────────────────────

  private buildFullContext(
    card: KanbanCardEntity,
    activities: KanbanCardActivityEntity[],
    linkedCards: Array<{ id: string; title: string; description: string | null; listTitle?: string }>,
    promptPrefix: string | null,
    execType: ExecType | null,
    customPrompt: string | undefined,
    downloadedFiles: Array<{ name: string; localPath: string }>,
  ): string {
    const parts: string[] = [];

    // ── Prompt prefix (system/board instructions)
    if (promptPrefix) {
      parts.push(promptPrefix);
      parts.push('');
    }

    // ── Title
    parts.push(`# Task: ${card.title}`);
    parts.push('');

    // ── Description
    if (card.description) {
      parts.push('## Description');
      parts.push(card.description);
      parts.push('');
    }

    // ── Labels
    if (card.labels && card.labels.length > 0) {
      parts.push('## Labels');
      for (const label of card.labels) {
        parts.push(`- **${label.text}** (${label.color})`);
      }
      parts.push('');
    }

    // ── Checklists (grouped)
    const hasChecklists = (card.checklists && card.checklists.length > 0) || (card.checklist && card.checklist.length > 0);
    if (hasChecklists) {
      parts.push('## Checklists');

      if (card.checklists && card.checklists.length > 0) {
        for (const group of card.checklists) {
          parts.push(`### ${group.title}`);
          for (const item of (group.items || [])) {
            const dueInfo = item.dueDate ? ` (due: ${item.dueDate})` : '';
            parts.push(`- [${item.done ? 'x' : ' '}] ${item.text}${dueInfo}`);
          }
          parts.push('');
        }
      }

      if (card.checklist && card.checklist.length > 0) {
        for (const item of card.checklist) {
          parts.push(`- [${item.done ? 'x' : ' '}] ${item.text}`);
        }
        parts.push('');
      }
    }

    // ── Comments & Notes (chronological)
    const comments = activities.filter(a => a.type === 'comment');
    if (comments.length > 0) {
      parts.push('## Comments & Notes');
      for (const comment of comments) {
        const date = new Date(comment.createdAt).toISOString().split('T')[0];
        const author = comment.userName || comment.userId || 'Unknown';
        parts.push(`**${author}** (${date}):`);
        parts.push(comment.text);
        parts.push('');
      }
    }

    // ── Activity History (events only — moves, assignments, etc.)
    const events = activities.filter(a => a.type === 'event');
    if (events.length > 0) {
      parts.push('## Activity History');
      for (const event of events) {
        const date = new Date(event.createdAt).toISOString().split('T')[0];
        parts.push(`- [${date}] ${event.text}`);
      }
      parts.push('');
    }

    // ── Attachments (downloaded files)
    if (downloadedFiles.length > 0) {
      parts.push('## Attachments');
      parts.push(`The following ${downloadedFiles.length} file(s) have been downloaded to the local filesystem:`);
      for (const file of downloadedFiles) {
        parts.push(`- ${file.name} → \`${file.localPath}\``);
      }
      parts.push('');
      parts.push('IMPORTANT: These files were provided as reference material for this task. Read them, analyze their content, and use them as instructed. For image/SVG files that need to be placed in the project, copy them to the appropriate location. For documents (PDF, CSV, etc.), read and use the information as context.');
      parts.push('');
    }

    // ── Linked Cards
    if (linkedCards.length > 0) {
      parts.push('## Linked Cards');
      for (const linked of linkedCards) {
        const desc = linked.description ? ` — ${linked.description.substring(0, 200)}${linked.description.length > 200 ? '...' : ''}` : '';
        const list = linked.listTitle ? ` [${linked.listTitle}]` : '';
        parts.push(`- **${linked.title}**${list}${desc}`);
      }
      parts.push('');
    }

    // ── Custom Fields
    if (card.customFields && Object.keys(card.customFields).length > 0) {
      parts.push('## Custom Fields');
      for (const [key, value] of Object.entries(card.customFields)) {
        if (value !== null && value !== undefined && value !== '') {
          parts.push(`- **${key}**: ${value}`);
        }
      }
      parts.push('');
    }

    // ── Metadata
    parts.push('## Metadata');
    parts.push(`- **Card ID**: ${card.id}`);
    if (card.startDate) parts.push(`- **Start Date**: ${new Date(card.startDate).toISOString().split('T')[0]}`);
    if (card.dueDate) parts.push(`- **Due Date**: ${new Date(card.dueDate).toISOString().split('T')[0]}`);
    if (card.maxHours) parts.push(`- **Max Hours Budget**: ${card.maxHours}h`);
    parts.push(`- **Created**: ${new Date(card.createdAt).toISOString().split('T')[0]}`);
    parts.push(`- **Last Updated**: ${new Date(card.updatedAt).toISOString().split('T')[0]}`);
    parts.push('');

    // ── Execution Instructions
    if (execType) {
      parts.push('---');
      parts.push('');
      parts.push('## Execution Instructions');
      if (execType === 'custom' && customPrompt) {
        parts.push(customPrompt);
      } else {
        parts.push(TYPE_INSTRUCTIONS[execType]);
      }
    }

    return parts.join('\n').trim();
  }

  // ── Resolve Linked Cards ────────────────────────────────────────

  private async resolveLinkedCards(
    linkedCardIds: string[],
    tenantId: string,
  ): Promise<Array<{ id: string; title: string; description: string | null; listTitle?: string }>> {
    if (!linkedCardIds || linkedCardIds.length === 0) return [];

    try {
      const cards = await this.cardRepo.find({
        where: { id: In(linkedCardIds), tenantId },
      });

      return cards.map(c => ({
        id: c.id,
        title: c.title,
        description: c.description,
      }));
    } catch (err) {
      this.logger.warn(`[KanbanAgent] Failed to resolve linked cards: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Resolve Card Attachments (download from S3) ──────────────────

  private async resolveCardAttachments(
    card: KanbanCardEntity,
  ): Promise<Array<{ name: string; localPath: string }>> {
    const attachments: KanbanAttachment[] = card.attachments || [];
    if (attachments.length === 0) return [];

    const attachDir = `/tmp/kanban-attachments/${card.id}`;
    try {
      if (!fs.existsSync(attachDir)) {
        fs.mkdirSync(attachDir, { recursive: true });
      }
    } catch (err) {
      this.logger.warn(`[KanbanAgent] Failed to create attachment dir: ${(err as Error).message}`);
      return [];
    }

    const downloadedFiles: Array<{ name: string; localPath: string }> = [];

    for (const attachment of attachments) {
      const fileName = attachment.name || `attachment-${downloadedFiles.length}`;
      const filePath = path.join(attachDir, fileName);

      try {
        let downloadUrl = attachment.url;

        // Convert public URL to internal MinIO URL for server-side download
        const s3Endpoint = this.configService.get<string>('S3_ENDPOINT');
        const s3Bucket = this.configService.get<string>('AWS_S3_BUCKET');
        const publicBase = this.configService.get<string>('S3_PUBLIC_BASE_URL');

        if (publicBase && s3Endpoint && downloadUrl.startsWith(publicBase)) {
          const key = downloadUrl.replace(publicBase + '/', '');
          downloadUrl = `${s3Endpoint}/${s3Bucket}/${key}`;
        }

        const response = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });

        fs.writeFileSync(filePath, response.data);
        downloadedFiles.push({ name: fileName, localPath: filePath });
        this.logger.log(`[KanbanAgent] Attachment downloaded: ${fileName} → ${filePath}`);
      } catch (err) {
        this.logger.warn(`[KanbanAgent] Failed to download attachment ${fileName}: ${(err as Error).message}`);
      }
    }

    return downloadedFiles;
  }

  // ── Process Agent Result ─────────────────────────────────────────

  private async processAgentResult(
    exec: KanbanAgentExecutionEntity,
    card: KanbanCardEntity,
    content: string | null,
    gitInfo?: { branch?: string; commits?: number; pushed?: boolean },
  ): Promise<void> {
    // Build structured comment from agent result
    const commentParts: string[] = ['✅ Agent concluiu a execução.'];

    if (gitInfo?.branch) {
      commentParts.push('');
      commentParts.push(`**Branch:** \`${gitInfo.branch}\``);
      if (gitInfo.commits) commentParts.push(`**Commits:** ${gitInfo.commits}`);
      if (gitInfo.pushed) commentParts.push(`**Push:** Realizado com sucesso`);
    }

    if (content) {
      commentParts.push('');
      commentParts.push('---');
      commentParts.push('');

      // Truncate very long results for comment (full result is in execution record)
      const maxCommentLength = 3000;
      if (content.length > maxCommentLength) {
        commentParts.push(content.substring(0, maxCommentLength));
        commentParts.push('');
        commentParts.push(`_(Resultado truncado — ${content.length} caracteres total. Veja a execução completa para o resultado integral.)_`);
      } else {
        commentParts.push(content);
      }
    }

    await this.kanbanService.addActivity(
      exec.tenantId,
      exec.cardId,
      exec.userId || 'agent',
      { text: commentParts.join('\n'), type: 'comment', userName: 'MakeStudio Agent' } as CreateActivityDto,
    );

    // Try to auto-update checklist items based on agent result
    if (content) {
      await this.tryUpdateChecklistFromResult(exec.tenantId, card, content);
    }
  }

  // ── Auto-update checklist from agent result ──────────────────────

  private async tryUpdateChecklistFromResult(
    tenantId: string,
    card: KanbanCardEntity,
    content: string,
  ): Promise<void> {
    try {
      // Look for completed checklist markers in agent output
      // Pattern: [x] item text  or  ✅ item text  or  DONE: item text
      const completedPatterns = [
        /\[x\]\s+(.+)/gi,
        /✅\s+(.+)/g,
        /DONE:\s+(.+)/gi,
        /COMPLETED:\s+(.+)/gi,
      ];

      const completedTexts: string[] = [];
      for (const pattern of completedPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          completedTexts.push(match[1].trim().toLowerCase());
        }
      }

      if (completedTexts.length === 0) return;

      let updated = false;

      // Update checklists (grouped)
      if (card.checklists && card.checklists.length > 0) {
        for (const group of card.checklists) {
          for (const item of (group.items || [])) {
            if (item.done) continue;
            const itemTextLower = item.text.trim().toLowerCase();
            const isCompleted = completedTexts.some(ct =>
              itemTextLower.includes(ct) || ct.includes(itemTextLower),
            );
            if (isCompleted) {
              item.done = true;
              updated = true;
            }
          }
        }
      }

      // Update legacy checklist (flat)
      if (card.checklist && card.checklist.length > 0) {
        for (const item of card.checklist) {
          if (item.done) continue;
          const itemTextLower = item.text.trim().toLowerCase();
          const isCompleted = completedTexts.some(ct =>
            itemTextLower.includes(ct) || ct.includes(itemTextLower),
          );
          if (isCompleted) {
            item.done = true;
            updated = true;
          }
        }
      }

      if (updated) {
        await this.cardRepo.update(card.id, {
          checklists: card.checklists,
          checklist: card.checklist,
        });
        this.logger.log(`[KanbanAgent] Auto-updated checklist items for card ${card.id}`);
      }
    } catch (err) {
      this.logger.warn(`[KanbanAgent] Failed to auto-update checklist: ${(err as Error).message}`);
    }
  }
}
