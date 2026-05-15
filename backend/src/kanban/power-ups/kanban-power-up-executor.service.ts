// src/kanban/power-ups/kanban-power-up-executor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanPowerUpEntity } from '../entities/kanban-power-up.entity';
import { KanbanPowerUpTemplateEntity, ResponseMappingAction } from './kanban-power-up-template.entity';
import { KanbanPowerUpLogEntity } from './kanban-power-up-log.entity';
import { KanbanBoardEntity } from '../entities/kanban-board.entity';
import { KanbanCardEntity } from '../entities/kanban-card.entity';
import { KanbanCardActivityEntity } from '../entities/kanban-card-activity.entity';
import { KanbanGateway } from '../kanban.gateway';
import { jsonArrayContains } from '../../database/json-sql';
import { KanbanCardEventPayload, KanbanEventKey } from './types';

// `isolated-vm` powers sandboxed user-script power-ups. It's a heavy native
// module that's awkward to ship in the Electron build, so it's optional —
// when missing, the backend still boots and only `mode === 'script'`
// power-ups fail at execution time.
let ivm: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ivm = require('isolated-vm');
} catch {
  // not installed — runScript() will throw a clear error if invoked
}

@Injectable()
export class KanbanPowerUpExecutorService {
  private readonly logger = new Logger(KanbanPowerUpExecutorService.name);
  private readonly processing = new Set<string>();

  constructor(
    @InjectRepository(KanbanPowerUpEntity)
    private readonly installRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanPowerUpTemplateEntity)
    private readonly templateRepo: Repository<KanbanPowerUpTemplateEntity>,
    @InjectRepository(KanbanPowerUpLogEntity)
    private readonly logRepo: Repository<KanbanPowerUpLogEntity>,
    @InjectRepository(KanbanBoardEntity)
    private readonly boardRepo: Repository<KanbanBoardEntity>,
    @InjectRepository(KanbanCardEntity)
    private readonly cardRepo: Repository<KanbanCardEntity>,
    @InjectRepository(KanbanCardActivityEntity)
    private readonly activityRepo: Repository<KanbanCardActivityEntity>,
    private readonly gateway: KanbanGateway,
  ) {}

  @OnEvent('kanban.card.created')
  async onCardCreated(payload: KanbanCardEventPayload) { await this.handle('card.created', payload); }

  @OnEvent('kanban.card.moved')
  async onCardMoved(payload: KanbanCardEventPayload) { await this.handle('card.moved', payload); }

  @OnEvent('kanban.card.commented')
  async onCardCommented(payload: KanbanCardEventPayload) { await this.handle('card.commented', payload); }

  @OnEvent('kanban.card.edited')
  async onCardEdited(payload: KanbanCardEventPayload) { await this.handle('card.edited', payload); }

  @OnEvent('kanban.card.assigned')
  async onCardAssigned(payload: KanbanCardEventPayload) { await this.handle('card.assigned', payload); }

  @OnEvent('kanban.card.due_changed')
  async onCardDueChanged(payload: KanbanCardEventPayload) { await this.handle('card.due_changed', payload); }

  private async handle(eventKey: KanbanEventKey, payload: KanbanCardEventPayload): Promise<void> {
    if (this.processing.has(payload.cardId)) return;
    this.processing.add(payload.cardId);
    try {
      await this.dispatch(eventKey, payload);
    } finally {
      this.processing.delete(payload.cardId);
    }
  }

  private async dispatch(eventKey: KanbanEventKey, payload: KanbanCardEventPayload): Promise<void> {
    const installations = await this.installRepo
      .createQueryBuilder('i')
      .innerJoin(KanbanPowerUpTemplateEntity, 't', 't.id = i.template_id')
      .where('i.board_id = :boardId', { boardId: payload.boardId })
      .andWhere('i.tenant_id = :tenantId', { tenantId: payload.tenantId })
      .andWhere('i.enabled = true')
      .andWhere('i.template_id IS NOT NULL')
      .andWhere(jsonArrayContains('t.trigger_events', 'eventKey'), { eventKey })
      .select(['i.id', 'i.templateId', 'i.config', 'i.boardId', 'i.tenantId'])
      .getRawMany();

    if (!installations.length) return;

    const board = await this.boardRepo.findOne({ where: { id: payload.boardId, tenantId: payload.tenantId } });
    const boardMembers = board?.members ?? [];
    const hydratedMembers = payload.card.memberIds.map(mid => {
      const m = boardMembers.find(bm => bm.id === mid);
      return m ? { id: m.id, name: m.name, email: (m as any).email ?? '', avatarColor: m.avatarColor ?? '' } : { id: mid, name: '', email: '', avatarColor: '' };
    });

    const varCtx = {
      card: {
        ...payload.card,
        members: hydratedMembers,
        list: { id: payload.card.listId, name: '', position: 0 },
        board: { id: payload.boardId, name: board?.title ?? '', slug: (board as any)?.slug ?? '' },
      },
      event: { type: payload.eventType, actor: payload.actor, timestamp: payload.timestamp, ...payload.extra },
    };

    for (const row of installations) {
      const templateId = row.i_templateId ?? row['i_template_id'];
      const installId = row.i_id ?? row['i_id'];
      const config = row.i_config ?? row['i_config'] ?? {};

      const template = await this.templateRepo.findOne({ where: { id: templateId } });
      if (!template) continue;

      let statusCode: number | null = null;
      let error: string | null = null;
      let responseSnippet: string | null = null;

      try {
        const result = await this.executeTemplate(template, varCtx, config);
        statusCode = result.statusCode;
        responseSnippet = result.responseSnippet;

        if (template.responseMapping?.length && result.responseBody) {
          await this.applyResponseMapping(template.responseMapping, result.responseBody, payload);
        }
      } catch (err: any) {
        error = err?.message ?? String(err);
        this.logger.warn(`[PowerUpExecutor] Error executing template ${templateId}: ${error}`);
      }

      await this.logRepo.save(this.logRepo.create({
        installationId: installId,
        boardId: payload.boardId,
        tenantId: payload.tenantId,
        eventType: eventKey,
        statusCode,
        error,
        responseSnippet,
      }));
    }
  }

  private interpolate(template: string, ctx: Record<string, unknown>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
      const parts = path.trim().split('.');
      let val: any = ctx;
      for (const p of parts) {
        if (val == null) return '';
        val = val[p];
      }
      return val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
    });
  }

  private interpolateObj(obj: Record<string, unknown>, ctx: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = typeof v === 'string' ? this.interpolate(v, ctx) : v;
    }
    return result;
  }

  private async executeTemplate(
    template: KanbanPowerUpTemplateEntity,
    ctx: Record<string, unknown>,
    config: Record<string, string>,
  ): Promise<{ statusCode: number | null; responseSnippet: string | null; responseBody: any }> {
    if (template.mode === 'simple') {
      validateWebhookUrl(template.url!);
      const res = await fetch(template.url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: (ctx as any).event, card: (ctx as any).card }),
      });
      const text = await res.text().catch(() => '');
      return { statusCode: res.status, responseSnippet: text.slice(0, 500), responseBody: tryParseJson(text) };
    }

    if (template.mode === 'builder') {
      validateWebhookUrl(template.url!);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (template.headersTemplate) {
        for (const [k, v] of Object.entries(template.headersTemplate)) {
          headers[k] = this.interpolate(v, ctx);
        }
      }
      const body = template.payloadTemplate ? this.interpolateObj(template.payloadTemplate, ctx) : ctx;
      const res = await fetch(template.url!, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await res.text().catch(() => '');
      return { statusCode: res.status, responseSnippet: text.slice(0, 500), responseBody: tryParseJson(text) };
    }

    if (template.mode === 'script' && template.script) {
      return await this.runScript(template.script, ctx, config);
    }

    return { statusCode: null, responseSnippet: null, responseBody: null };
  }

  private async runScript(
    script: string,
    ctx: Record<string, unknown>,
    config: Record<string, string>,
  ): Promise<{ statusCode: number | null; responseSnippet: string | null; responseBody: any }> {
    if (!ivm) {
      throw new Error(
        'Script-mode power-ups are unavailable in this build (isolated-vm is not installed).',
      );
    }
    const isolate = new ivm.Isolate({ memoryLimit: 32 });
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());
    await jail.set('__ctx', new ivm.ExternalCopy({ ...ctx, config }).copyInto());

    let resultStatusCode: number | null = null;
    let resultBody: any = null;

    const fetchCallback = new ivm.Reference(async (url: string, opts: any) => {
      try {
        validateWebhookUrl(url);
        const res = await fetch(url, {
          method: opts?.method ?? 'POST',
          headers: opts?.headers ?? { 'Content-Type': 'application/json' },
          body: opts?.body,
        });
        const text = await res.text();
        resultStatusCode = res.status;
        resultBody = tryParseJson(text);
        return new ivm.ExternalCopy({ status: res.status, body: resultBody }).copyInto();
      } catch (e: any) {
        return new ivm.ExternalCopy({ error: e.message }).copyInto();
      }
    });
    await jail.set('__fetch', fetchCallback);

    const wrappedScript = `
      (async () => {
        const ctx = __ctx;
        const fetch = (url, opts) => __fetch.apply(undefined, [url, opts], { arguments: { copy: true } });
        ${script}
      })()
    `;

    try {
      const fn = await isolate.compileScript(wrappedScript);
      await fn.run(context, { timeout: 5000 });
    } catch (err: any) {
      throw new Error(`Script error: ${err.message}`);
    } finally {
      isolate.dispose();
    }

    return {
      statusCode: resultStatusCode,
      responseSnippet: resultBody ? JSON.stringify(resultBody).slice(0, 500) : null,
      responseBody: resultBody,
    };
  }

  private async applyResponseMapping(
    mapping: ResponseMappingAction[],
    responseBody: any,
    payload: KanbanCardEventPayload,
  ): Promise<void> {
    for (const action of mapping) {
      if (action.condition) {
        const { field, operator, value } = action.condition;
        const actual = String(getByPath(responseBody, field) ?? '');
        if (operator === '==' && actual !== value) continue;
        if (operator === '!=' && actual === value) continue;
        if (operator === 'contains' && !actual.includes(value)) continue;
      }

      try {
        if (action.action === 'moveCard' && action.params.listId) {
          const card = await this.cardRepo.findOne({ where: { id: payload.cardId, tenantId: payload.tenantId } });
          if (card) {
            await this.cardRepo.update(
              { id: payload.cardId, tenantId: payload.tenantId },
              { listId: action.params.listId },
            );
            this.gateway.emit(payload.tenantId, payload.boardId, 'card:updated', { ...card, listId: action.params.listId });
          }
        } else if (action.action === 'addComment') {
          const text = action.params.text ?? String(getByPath(responseBody, action.params.sourceField ?? 'message') ?? '');
          if (text) {
            const card = await this.cardRepo.findOne({ where: { id: payload.cardId, tenantId: payload.tenantId } });
            if (card) {
              const activity = this.activityRepo.create({
                cardId: payload.cardId,
                boardId: payload.boardId,
                tenantId: payload.tenantId,
                userId: null,
                userName: 'Power-Up',
                type: 'comment',
                text,
              });
              const saved = await this.activityRepo.save(activity);
              this.gateway.emit(payload.tenantId, payload.boardId, 'activity:added', { cardId: payload.cardId, activity: saved });
            }
          }
        } else if (action.action === 'assignMember') {
          const userId = action.params.userId ?? String(getByPath(responseBody, action.params.sourceField ?? 'userId') ?? '');
          if (userId) {
            const card = await this.cardRepo.findOne({ where: { id: payload.cardId, tenantId: payload.tenantId } });
            if (card && !card.memberIds.includes(userId)) {
              card.memberIds = [...card.memberIds, userId];
              await this.cardRepo.save(card);
              this.gateway.emit(payload.tenantId, payload.boardId, 'card:updated', card);
            }
          }
        } else if (action.action === 'setDue') {
          let dueDate: Date | null = null;
          if (action.params.dueDate) {
            dueDate = new Date(action.params.dueDate);
          } else if (action.params.daysOffset) {
            dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + Number(action.params.daysOffset));
          } else if (action.params.sourceField) {
            const raw = String(getByPath(responseBody, action.params.sourceField) ?? '');
            if (raw) dueDate = new Date(raw);
          }
          if (dueDate && !isNaN(dueDate.getTime())) {
            const card = await this.cardRepo.findOne({ where: { id: payload.cardId, tenantId: payload.tenantId } });
            if (card) {
              card.dueDate = dueDate;
              await this.cardRepo.save(card);
              this.gateway.emit(payload.tenantId, payload.boardId, 'card:updated', card);
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`[PowerUpExecutor] responseMapping action failed: ${err.message}`);
      }
    }
  }
}

function tryParseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, p) => acc?.[p], obj);
}

function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo não permitido');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') throw new Error('URL interna não permitida');
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      throw new Error('URL interna não permitida');
    }
  }
}
