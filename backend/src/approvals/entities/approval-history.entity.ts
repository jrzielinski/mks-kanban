import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('approval_history')
@Index(['approvalId'])
@Index(['createdAt'])
export class ApprovalHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'approvalId' })
  approvalId: string;

  @ManyToOne('ApprovalEntity', 'history', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'approvalId' })
  approval: any;

  @Column()
  action: string;

  @Column({ name: 'performedById', nullable: true })
  performedById: string;

  @Column({ name: 'performedByEmail', nullable: true })
  performedByEmail: string;

  @Column({ name: 'performedByName', nullable: true })
  performedByName: string;

  @Column({ name: 'previousStatus', nullable: true })
  previousStatus: string;

  @Column({ name: 'newStatus', nullable: true })
  newStatus: string;

  @Column({ type: 'text', nullable: true })
  comments: string;

  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn({ name: 'createdAt' })
  createdAt: Date;
}
