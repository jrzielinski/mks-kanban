// src/kanban/entities/kanban-board-star.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('kanban_board_stars')
@Index(['boardId', 'userId'])
@Index(['userId', 'tenantId'])
export class KanbanBoardStarEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
