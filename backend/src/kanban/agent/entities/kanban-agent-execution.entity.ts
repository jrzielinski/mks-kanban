import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { ExecType } from './kanban-list-agent-config.entity';

export type ExecStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

@Entity('kanban_agent_executions')
@Index(['cardId'])
@Index(['tenantId'])
@Index(['status'])
export class KanbanAgentExecutionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'card_id' })
  cardId: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column({ name: 'list_id' })
  listId: string;

  @Column({ name: 'exec_type', type: 'varchar' })
  execType: ExecType;

  @Column({ type: 'text' })
  prompt: string;

  @Column({ name: 'repo_url', type: 'varchar', nullable: true })
  repoUrl: string | null;

  @Column({ name: 'branch_created', type: 'varchar', nullable: true })
  branchCreated: string | null;

  @Column({ name: 'git_commits', type: 'int', nullable: true })
  gitCommits: number | null;

  @Column({ name: 'git_pushed', default: false })
  gitPushed: boolean;

  @Column({ type: 'varchar', default: 'pending' })
  status: ExecStatus;

  @Column({ type: 'text', nullable: true })
  result: string | null;

  @Column({ name: 'cost_usd', type: 'decimal', precision: 10, scale: 6, default: 0 })
  costUsd: string;

  @Column({ name: 'agent_socket_id', type: 'varchar', nullable: true })
  agentSocketId: string | null;

  @Column({ name: 'agent_machine', type: 'varchar', nullable: true })
  agentMachine: string | null;

  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'varchar', nullable: true })
  userId: string | null;
}
