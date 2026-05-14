// src/kanban/entities/kanban-time-log.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('kanban_time_logs')
@Index(['cardId'])
@Index(['tenantId'])
export class KanbanTimeLogEntity {
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
