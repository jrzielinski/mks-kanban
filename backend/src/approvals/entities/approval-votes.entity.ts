import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ApprovalEntity } from './approval.entity';

export type VoteDecision = 'approved' | 'rejected';

@Entity('approval_votes')
@Index(['approvalId'])
@Index(['voterId'])
@Index(['approvalId', 'voterId'], { unique: true })
export class ApprovalVotesEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'approvalId' })
  approvalId: string;

  @ManyToOne(() => ApprovalEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'approvalId' })
  approval: ApprovalEntity;

  @Column({ name: 'voterId' })
  voterId: string;

  @Column({
    type: 'varchar',
    enum: ['approved', 'rejected'],
  })
  decision: VoteDecision;

  @Column({ type: 'text', nullable: true })
  comments: string;

  @Column({ type: 'simple-json', nullable: true })
  responseData: Record<string, any>;

  @CreateDateColumn({ name: 'votedAt' })
  votedAt: Date;
}
