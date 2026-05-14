// src/kanban/entities/kanban-power-up.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type KanbanPowerUpType = 'slack' | 'github' | 'jira' | 'google_drive' | 'confluence' | 'giphy' | 'email_to_card' | 'burndown';

export interface KanbanSlackConfig {
  webhookUrl: string;
  channel?: string;
  notifyOnCreate?: boolean;
  notifyOnMove?: boolean;
  notifyOnComment?: boolean;
  notifyOnDue?: boolean;
  notifyOnArchive?: boolean;
}

export interface KanbanGithubConfig {
  token: string;               // GitHub personal access token
  repoOwner: string;
  repoName: string;
  targetListId?: string;       // move card here when PR is merged
  webhookSecret?: string;
  syncOnCreate?: boolean;      // create GitHub issue when card is created
  syncOnComment?: boolean;     // sync comments both ways
  createBranchOnCard?: boolean; // create feature branch when card is created
  branchPrefix?: string;       // e.g. "feature/" or "task/"
}

export interface KanbanJiraStatusMapping {
  listId: string;
  listTitle: string;
  jiraStatusId: string;
  jiraStatusName: string;
}

export interface KanbanJiraConfig {
  domain: string;            // e.g. "mycompany" → mycompany.atlassian.net
  email: string;             // Jira account email
  apiToken: string;          // Jira API token
  projectKey: string;        // e.g. "PROJ"
  issueType?: string;        // default: "Task"
  webhookSecret?: string;    // secret to validate incoming Jira webhooks
  syncOnMove?: boolean;      // sync status when card moves
  syncOnComment?: boolean;   // sync comments both ways
  syncOnCreate?: boolean;    // create Jira issue when card is created
  statusMapping: KanbanJiraStatusMapping[]; // list ↔ Jira status mapping
}

export interface KanbanGoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: string;
  defaultFolderId?: string;
}

export interface KanbanGiphyConfig {
  apiKey: string;
  rating?: 'g' | 'pg' | 'pg-13' | 'r'; // content rating filter
}

export interface KanbanEmailToCardConfig {
  targetListId: string;          // lista onde os cards serão criados
  emailAddress?: string;         // endereço gerado para receber emails (board-id@domain)
  subjectAsTitle?: boolean;      // usar assunto como título (default: true)
  bodyAsDescription?: boolean;   // usar corpo como descrição (default: true)
  addLabels?: string[];          // labels automáticas para cards criados por email
  allowedSenders?: string[];     // se preenchido, só aceita emails desses remetentes
}

export interface KanbanBurndownConfig {
  sprintDurationDays: number;    // duração do sprint em dias
  sprintStartDate?: string;      // data de início do sprint atual (ISO string)
  doneListIds: string[];         // IDs das listas que significam "concluído"
  trackingField?: 'cards' | 'points'; // rastrear por cards ou story points
  pointsFieldId?: string;        // ID do custom field de story points (se tracking por points)
}

export interface KanbanConfluenceConfig {
  domain: string;            // e.g. "mycompany" → mycompany.atlassian.net/wiki
  email: string;
  apiToken: string;
  spaceKey?: string;         // espaço padrão para busca
}

@Entity('kanban_power_ups')
@Index(['boardId'])
@Index(['tenantId'])
export class KanbanPowerUpEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ type: 'varchar', nullable: true })
  type: KanbanPowerUpType | null;

  @Column({ name: 'template_id', type: 'varchar', nullable: true })
  templateId: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  config: KanbanSlackConfig | KanbanGithubConfig | KanbanJiraConfig | KanbanGoogleDriveConfig | KanbanConfluenceConfig | KanbanGiphyConfig | KanbanEmailToCardConfig | KanbanBurndownConfig;

  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
