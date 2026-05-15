// src/kanban/entities/kanban-hour-request.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { TIMESTAMP_TYPE } from '../../database/column-types';

export type KanbanHourRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

@Entity('kanban_hour_requests')
@Index(['cardId'])
@Index(['tenantId'])
@Index(['approvalId'])
export class KanbanHourRequestEntity {
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

  @Column({ type: 'float' })
  hours: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'logged_date', type: 'date' })
  loggedDate: string;

  @Column({
    type: 'varchar',
    default: 'pending',
  })
  status: KanbanHourRequestStatus;

  @Column({ name: 'approval_id', nullable: true, type: 'varchar' })
  approvalId: string | null;

  @Column({ name: 'reviewed_by', nullable: true, type: 'varchar' })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', nullable: true, type: TIMESTAMP_TYPE })
  reviewedAt: Date | null;

  @Column({ name: 'review_note', nullable: true, type: 'text' })
  reviewNote: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
