// src/kanban/entities/kanban-notification.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('kanban_notifications')
@Index(['userId', 'tenantId'])
@Index(['tenantId'])
export class KanbanNotificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'board_id', nullable: true, type: 'varchar' })
  boardId: string | null;

  @Column({ name: 'card_id', nullable: true, type: 'varchar' })
  cardId: string | null;

  @Column({ name: 'card_title', nullable: true, type: 'varchar' })
  cardTitle: string | null;

  @Column({ type: 'varchar' })
  type: string; // 'mention' | 'due_soon' | 'overdue'

  @Column({ type: 'text' })
  text: string;

  @Column({ name: 'is_read', default: false })
  isRead: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
