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

  /**
   * Optional role the MakeStudio Bot plays for cards in this list.
   * Free-form varchar, conventionally one of:
   *   implement | test | qa | review | deploy
   * `null` means "no agent action — human-only column" and is the
   * default for every existing list (zero migration impact for users
   * who don't opt in).
   */
  @Column({ name: 'agent_role', nullable: true, type: 'varchar' })
  agentRole: string | null;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
