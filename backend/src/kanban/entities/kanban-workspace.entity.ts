// src/kanban/entities/kanban-workspace.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('kanban_workspaces')
@Index(['tenantId'])
export class KanbanWorkspaceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ default: '#6366f1' })
  color: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'owner_id', nullable: true, type: 'varchar' })
  ownerId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
