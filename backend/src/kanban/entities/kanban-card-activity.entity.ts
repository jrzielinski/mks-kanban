// src/kanban/entities/kanban-card-activity.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type ActivityType = 'comment' | 'event';

@Entity('kanban_card_activities')
@Index(['cardId'])
@Index(['tenantId'])
export class KanbanCardActivityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'card_id' })
  cardId: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'user_id', nullable: true, type: 'varchar' })
  userId: string | null;

  @Column({ name: 'user_name', nullable: true, type: 'varchar' })
  userName: string | null;

  @Column({ type: 'varchar', default: 'comment' })
  type: ActivityType;

  @Column({ type: 'text' })
  text: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', nullable: true })
  updatedAt: Date | null;
}
