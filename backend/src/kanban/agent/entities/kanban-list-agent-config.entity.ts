import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type ExecType = 'code' | 'analysis' | 'mockup' | 'tests' | 'review' | 'custom';

@Entity('kanban_list_agent_config')
@Index(['tenantId'])
export class KanbanListAgentConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'list_id', unique: true })
  listId: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({ name: 'default_exec_type', type: 'varchar', nullable: true })
  defaultExecType: ExecType | null;

  @Column({ name: 'default_repo_id', type: 'uuid', nullable: true })
  defaultRepoId: string | null;

  @Column({ name: 'default_branch', type: 'varchar', nullable: true })
  defaultBranch: string | null;

  @Column({ name: 'prompt_prefix', type: 'text', nullable: true })
  promptPrefix: string | null;

  @Column({ name: 'move_on_complete_list_id', type: 'varchar', nullable: true })
  moveOnCompleteListId: string | null;

  @Column({ name: 'move_on_fail_list_id', type: 'varchar', nullable: true })
  moveOnFailListId: string | null;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
