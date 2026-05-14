// src/kanban/kanban-google-drive-powerup.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KanbanPowerUpEntity, KanbanGoogleDriveConfig } from './entities/kanban-power-up.entity';
import { KanbanCardEntity } from './entities/kanban-card.entity';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  iconLink: string;
  thumbnailLink?: string;
  size?: string;
  modifiedTime: string;
  parents?: string[];
}

@Injectable()
export class KanbanGoogleDrivePowerUpService {
  private readonly logger = new Logger(KanbanGoogleDrivePowerUpService.name);

  constructor(
    @InjectRepository(KanbanPowerUpEntity) private powerUpRepo: Repository<KanbanPowerUpEntity>,
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
  ) {}

  private async getConfig(tenantId: string, boardId: string): Promise<{ powerUp: KanbanPowerUpEntity; config: KanbanGoogleDriveConfig } | null> {
    const pu = await this.powerUpRepo.findOne({
      where: { boardId, tenantId, type: 'google_drive', enabled: true },
    });
    if (!pu) return null;
    return { powerUp: pu, config: pu.config as KanbanGoogleDriveConfig };
  }

  private async refreshTokenIfNeeded(config: KanbanGoogleDriveConfig): Promise<string> {
    if (!config.refreshToken) {
      return config.accessToken;
    }

    // Check if token expires soon (within 5 minutes)
    if (config.tokenExpiry) {
      const expiry = new Date(config.tokenExpiry).getTime();
      if (expiry > Date.now() + 5 * 60 * 1000) {
        return config.accessToken;
      }
    }

    // Refresh the token
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        this.logger.warn(`Failed to refresh Google token: ${response.status}`);
        return config.accessToken;
      }

      const data = await response.json();
      config.accessToken = data.access_token;
      if (data.expires_in) {
        config.tokenExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
      }

      return config.accessToken;
    } catch (err) {
      this.logger.error('Error refreshing Google token', err);
      return config.accessToken;
    }
  }

  /**
   * List files in a folder (or root)
   */
  async listFiles(
    tenantId: string,
    boardId: string,
    folderId?: string,
    query?: string,
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const result = await this.getConfig(tenantId, boardId);
    if (!result) throw new NotFoundException('Google Drive power-up not configured');
    const { config } = result;

    const accessToken = await this.refreshTokenIfNeeded(config);

    // Save refreshed token back
    await this.powerUpRepo.update(
      { boardId, tenantId, type: 'google_drive' as any },
      { config: config as any },
    );

    const parent = folderId || 'root';
    let q = `'${parent}' in parents and trashed = false`;
    if (query) {
      q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    }

    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,mimeType,webViewLink,iconLink,thumbnailLink,size,modifiedTime,parents)',
      orderBy: 'folder,name',
      pageSize: '50',
    });

    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      const err = await response.text();
      this.logger.error(`Google Drive API error: ${response.status} ${err}`);
      throw new Error(`Google Drive API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      files: data.files ?? [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * Attach a Google Drive file to a kanban card
   */
  async attachFileToCard(
    tenantId: string,
    cardId: string,
    file: { id: string; name: string; mimeType: string; webViewLink: string; iconLink?: string; thumbnailLink?: string },
  ): Promise<void> {
    const card = await this.cardRepo.findOne({ where: { id: cardId, tenantId } });
    if (!card) throw new NotFoundException('Card not found');

    const isImage = file.mimeType.startsWith('image/');
    const attachment = {
      id: `gdrive_${file.id}`,
      name: `📁 ${file.name}`,
      url: file.webViewLink,
      isImage,
      addedAt: new Date().toISOString(),
    };

    card.attachments = [...(card.attachments || []), attachment];
    await this.cardRepo.save(card);
  }
}
