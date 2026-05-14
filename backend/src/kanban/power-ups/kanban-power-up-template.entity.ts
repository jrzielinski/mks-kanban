// src/kanban/power-ups/kanban-power-up-template.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { KanbanEventKey } from './types';

export type PowerUpMode = 'simple' | 'builder' | 'script';
export type PowerUpStatus = 'draft' | 'pending' | 'approved' | 'published_tenant' | 'published_template' | 'rejected';

export interface PowerUpConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export interface ResponseMappingAction {
  condition?: { field: string; operator: '==' | '!=' | 'contains'; value: string };
  action: 'moveCard' | 'assignMember' | 'setDue' | 'addComment';
  params: Record<string, string>;
}

@Entity('kanban_power_up_templates')
@Index(['tenantId'])
@Index(['boardId'])
@Index(['status'])
export class KanbanPowerUpTemplateEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id' }) tenantId: string;
  @Column({ name: 'board_id' }) boardId: string;
  @Column({ name: 'created_by' }) createdBy: string;
  @Column() name: string;
  @Column({ default: '⚡' }) icon: string;
  @Column({ nullable: true, type: 'text' }) description: string | null;
  @Column({ type: 'varchar' }) mode: PowerUpMode;
  @Column({ name: 'trigger_events', type: 'jsonb', default: '[]' }) triggerEvents: KanbanEventKey[];
  @Column({ nullable: true, type: 'text' }) url: string | null;
  @Column({ name: 'headers_template', type: 'jsonb', nullable: true }) headersTemplate: Record<string, string> | null;
  @Column({ name: 'payload_template', type: 'jsonb', nullable: true }) payloadTemplate: Record<string, unknown> | null;
  @Column({ name: 'config_schema', type: 'jsonb', default: '[]' }) configSchema: PowerUpConfigField[];
  @Column({ nullable: true, type: 'text' }) script: string | null;
  @Column({ name: 'response_mapping', type: 'jsonb', nullable: true }) responseMapping: ResponseMappingAction[] | null;
  @Column({ type: 'varchar', default: 'draft' }) status: PowerUpStatus;
  @Column({ name: 'rejection_reason', nullable: true, type: 'text' }) rejectionReason: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
