// src/kanban/entities/kanban-list.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('kanban_lists')
@Index(['boardId'])
@Index(['tenantId'])
export class KanbanListEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column()
  title: string;

  @Column({ default: '#e2e8f0' })
  color: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ name: 'is_archived', default: false })
  isArchived: boolean;

  @Column({ name: 'wip_limit', type: 'int', default: 0 })
  wipLimit: number;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
