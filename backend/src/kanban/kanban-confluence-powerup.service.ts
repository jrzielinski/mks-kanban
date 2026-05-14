// src/kanban/kanban-confluence-powerup.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanPowerUpEntity, KanbanConfluenceConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  status: string;
  webUrl: string;
  excerpt?: string;
  lastModified?: string;
  lastModifiedBy?: string;
}

@Injectable()
export class KanbanConfluencePowerUpService {
  private readonly logger = new Logger(KanbanConfluencePowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
  ) {}

  private async getConfig(tenantId: string, boardId: string): Promise<KanbanConfluenceConfig | null> {
    const pu = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'confluence' as any, enabled: true },
    });
    if (!pu) return null;
    return pu.config as KanbanConfluenceConfig;
  }

  private authHeader(config: KanbanConfluenceConfig): string {
    return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }

  private baseUrl(config: KanbanConfluenceConfig): string {
    const domain = config.domain.replace(/\.atlassian\.net.*$/, '');
    return `https://${domain}.atlassian.net/wiki`;
  }

  /**
   * Buscar páginas no Confluence via CQL
   */
  async searchPages(
    tenantId: string,
    boardId: string,
    query: string,
    spaceKey?: string,
  ): Promise<ConfluencePage[]> {
    const config = await this.getConfig(tenantId, boardId);
    if (!config) throw new NotFoundException('Confluence power-up not configured');

    const space = spaceKey || config.spaceKey;
    let cql = `type = page AND title ~ "${query.replace(/"/g, '\\"')}"`;
    if (space) {
      cql += ` AND space.key = "${space}"`;
    }
    cql += ' ORDER BY lastmodified DESC';

    const params = new URLSearchParams({
      cql,
      limit: '20',
      expand: 'version,space,body.view',
    });

    const url = `${this.baseUrl(config)}/rest/api/content/search?${params}`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader(config),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      this.logger.error(`Confluence search error: ${response.status} ${err}`);
      throw new Error(`Confluence API error: ${response.status}`);
    }

    const data = await response.json();
    const baseWebUrl = this.baseUrl(config);

    return (data.results ?? []).map((page: any) => ({
      id: page.id,
      title: page.title,
      spaceKey: page.space?.key ?? '',
      status: page.status ?? 'current',
      webUrl: `${baseWebUrl}${page._links?.webui ?? `/pages/${page.id}`}`,
      excerpt: this.stripHtml((page.body?.view?.value ?? '').slice(0, 300)),
      lastModified: page.version?.when,
      lastModifiedBy: page.version?.by?.displayName,
    }));
  }

  /**
   * Listar páginas recentes de um espaço
   */
  async listRecentPages(
    tenantId: string,
    boardId: string,
    spaceKey?: string,
  ): Promise<ConfluencePage[]> {
    const config = await this.getConfig(tenantId, boardId);
    if (!config) return [];

    const space = spaceKey || config.spaceKey;
    let cql = 'type = page ORDER BY lastmodified DESC';
    if (space) {
      cql = `type = page AND space.key = "${space}" ORDER BY lastmodified DESC`;
    }

    const params = new URLSearchParams({
      cql,
      limit: '15',
      expand: 'version,space',
    });

    const url = `${this.baseUrl(config)}/rest/api/content/search?${params}`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader(config),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Confluence API error: ${response.status}`);
    }

    const data = await response.json();
    const baseWebUrl = this.baseUrl(config);

    return (data.results ?? []).map((page: any) => ({
      id: page.id,
      title: page.title,
      spaceKey: page.space?.key ?? '',
      status: page.status ?? 'current',
      webUrl: `${baseWebUrl}${page._links?.webui ?? `/pages/${page.id}`}`,
      lastModified: page.version?.when,
      lastModifiedBy: page.version?.by?.displayName,
    }));
  }

  /**
   * Listar espaços disponíveis
   */
  async listSpaces(
    tenantId: string,
    boardId: string,
  ): Promise<Array<{ key: string; name: string; type: string }>> {
    const config = await this.getConfig(tenantId, boardId);
    if (!config) throw new NotFoundException('Confluence power-up not configured');

    const url = `${this.baseUrl(config)}/rest/api/space?limit=50&type=global`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader(config),
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Confluence API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.results ?? []).map((s: any) => ({
      key: s.key,
      name: s.name,
      type: s.type,
    }));
  }

  /**
   * Vincular uma página do Confluence a um card
   */
  async linkPageToCard(
    tenantId: string,
    cardId: string,
    page: { id: string; title: string; webUrl: string; spaceKey: string },
  ): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    // Armazenar páginas vinculadas no customFields como array JSON
    const linkedPages: any[] = JSON.parse(
      (card.customFields?.['__confluencePages'] as string) || '[]',
    );

    // Evitar duplicatas
    if (linkedPages.some((p) => p.id === page.id)) return;

    linkedPages.push({
      id: page.id,
      title: page.title,
      webUrl: page.webUrl,
      spaceKey: page.spaceKey,
      linkedAt: new Date().toISOString(),
    });

    card.customFields = {
      ...(card.customFields || {}),
      __confluencePages: JSON.stringify(linkedPages),
    };

    await this.cardRepo.save(card);
  }

  /**
   * Desvincular uma página do card
   */
  async unlinkPageFromCard(
    tenantId: string,
    cardId: string,
    pageId: string,
  ): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const linkedPages: any[] = JSON.parse(
      (card.customFields?.['__confluencePages'] as string) || '[]',
    );

    const filtered = linkedPages.filter((p) => p.id !== pageId);

    card.customFields = {
      ...(card.customFields || {}),
      __confluencePages: filtered.length > 0 ? JSON.stringify(filtered) : null,
    };

    // Limpar campo se vazio
    if (!filtered.length) {
      delete card.customFields['__confluencePages'];
    }

    await this.cardRepo.save(card);
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
  }
}
