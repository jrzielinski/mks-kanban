import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('kanban_board_repos')
@Index(['boardId'])
@Index(['tenantId'])
export class KanbanBoardRepoEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column()
  name: string;

  @Column({ name: 'repo_url' })
  repoUrl: string;

  @Column({ name: 'default_branch', default: 'main' })
  defaultBranch: string;

  @Column({ type: 'text', nullable: true, name: 'git_token' })
  gitToken: string | null;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
