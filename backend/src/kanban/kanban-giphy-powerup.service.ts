// src/kanban/kanban-giphy-powerup.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanPowerUpEntity, KanbanGiphyConfig } from './entities/kanban-power-up.entity';

export interface GiphyGif {
  id: string;
  title: string;
  url: string;           // giphy page URL
  previewUrl: string;    // small preview (200px wide)
  originalUrl: string;   // full-size GIF
  width: number;
  height: number;
}

@Injectable()
export class KanbanGiphyPowerUpService {
  private readonly logger = new Logger(KanbanGiphyPowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
  ) {}

  private async getConfig(tenantId: string, boardId: string): Promise<KanbanGiphyConfig | null> {
    const pu = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'giphy' as any, enabled: true },
    });
    if (!pu) return null;
    return pu.config as KanbanGiphyConfig;
  }

  private mapGifs(data: any): GiphyGif[] {
    return (data ?? []).map((gif: any) => ({
      id: gif.id,
      title: gif.title || '',
      url: gif.url,
      previewUrl: gif.images?.fixed_width_small?.url || gif.images?.fixed_width?.url || gif.images?.original?.url,
      originalUrl: gif.images?.original?.url,
      width: parseInt(gif.images?.original?.width || '0', 10),
      height: parseInt(gif.images?.original?.height || '0', 10),
    }));
  }

  /**
   * Buscar GIFs por termo
   */
  async search(
    tenantId: string,
    boardId: string,
    query: string,
    offset = 0,
  ): Promise<{ gifs: GiphyGif[]; totalCount: number }> {
    const config = await this.getConfig(tenantId, boardId);
    if (!config) throw new NotFoundException('Giphy power-up not configured');

    const params = new URLSearchParams({
      api_key: config.apiKey,
      q: query,
      limit: '24',
      offset: String(offset),
      rating: config.rating || 'pg',
      lang: 'pt',
    });

    const response = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`);
    if (!response.ok) {
      this.logger.error(`Giphy search error: ${response.status}`);
      throw new Error(`Giphy API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      gifs: this.mapGifs(data.data),
      totalCount: data.pagination?.total_count ?? 0,
    };
  }

  /**
   * GIFs em alta (trending)
   */
  async trending(
    tenantId: string,
    boardId: string,
    offset = 0,
  ): Promise<{ gifs: GiphyGif[]; totalCount: number }> {
    const config = await this.getConfig(tenantId, boardId);
    if (!config) throw new NotFoundException('Giphy power-up not configured');

    const params = new URLSearchParams({
      api_key: config.apiKey,
      limit: '24',
      offset: String(offset),
      rating: config.rating || 'pg',
    });

    const response = await fetch(`https://api.giphy.com/v1/gifs/trending?${params}`);
    if (!response.ok) {
      throw new Error(`Giphy API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      gifs: this.mapGifs(data.data),
      totalCount: data.pagination?.total_count ?? 0,
    };
  }
}
