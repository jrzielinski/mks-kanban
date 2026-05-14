import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('kanban_card_history')
@Index(['cardId'])
@Index(['tenantId'])
export class KanbanCardHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'card_id' })
  cardId: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'from_list_id', type: 'varchar', nullable: true })
  fromListId: string | null;

  @Column({ name: 'from_list_title', type: 'varchar', nullable: true })
  fromListTitle: string | null;

  @Column({ name: 'to_list_id', type: 'varchar' })
  toListId: string;

  @Column({ name: 'to_list_title', type: 'varchar' })
  toListTitle: string;

  @Column({ name: 'moved_by', type: 'varchar', nullable: true })
  movedBy: string | null;

  @CreateDateColumn({ name: 'moved_at' })
  movedAt: Date;
}
