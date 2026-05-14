// src/kanban/power-ups/kanban-power-up-log.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('kanban_power_up_execution_logs')
export class KanbanPowerUpLogEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'installation_id' }) installationId: string;
  @Column({ name: 'board_id' }) boardId: string;
  @Column({ name: 'tenant_id' }) tenantId: string;
  @Column({ name: 'event_type' }) eventType: string;
  @Column({ nullable: true, type: 'int' }) statusCode: number | null;
  @Column({ nullable: true, type: 'text' }) error: string | null;
  @Column({ name: 'response_snippet', nullable: true, type: 'text' }) responseSnippet: string | null;
  @CreateDateColumn({ name: 'executed_at' }) executedAt: Date;
}
