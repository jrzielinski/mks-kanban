import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { FlowExecutionEntity } from '../../flow-engine/entities/flow-execution.entity';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ApprovalPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ApprovalStrategy = 'first_to_respond' | 'all_must_approve' | 'sequential';
export type TimeoutAction = 'auto-reject' | 'escalate' | 'notify';

export interface SequentialApprover {
  id: string;
  type: 'user' | 'group';
  order: number;
  name?: string;
}

export interface EscalationRule {
  after: number; // minutos após criação
  action: 'notify' | 'escalate' | 'auto-reject';
  targetUserId?: string; // para notify ou escalate
  targetGroupId?: string; // para notify ou escalate
  message?: string; // mensagem customizada para notificação
}

@Entity('approvals')
@Index(['flowExecutionId'])
@Index(['flowId'])
@Index(['status'])
@Index(['approverId', 'status'])
@Index(['approverGroupId', 'status'])
@Index(['tenantId', 'status'])
@Index(['expiresAt'])
export class ApprovalEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'flowExecutionId', nullable: true })
  flowExecutionId: string;

  @ManyToOne(() => FlowExecutionEntity, { nullable: true })
  @JoinColumn({ name: 'flowExecutionId' })
  flowExecution?: FlowExecutionEntity;

  @Column({ name: 'flowId', nullable: true })
  flowId: string;

  @Column({ name: 'nodeId', nullable: true })
  nodeId: string;

  @Column({
    type: 'varchar',
    enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
    default: 'pending',
  })
  status: ApprovalStatus;

  @Column({ name: 'requesterId', nullable: true })
  requesterId: string;

  @Column({ name: 'approverId', nullable: true })
  approverId: string;

  @Column({ name: 'approverGroupId', nullable: true })
  approverGroupId: string;

  @Column({ name: 'approvedById', nullable: true })
  approvedById: string;

  @Column({
    type: 'varchar',
    enum: ['first_to_respond', 'all_must_approve', 'sequential'],
    default: 'first_to_respond',
    name: 'approvalStrategy',
  })
  approvalStrategy: ApprovalStrategy;

  @Column({ type: 'jsonb', nullable: true, name: 'sequentialApprovers' })
  sequentialApprovers: SequentialApprover[];

  @Column({ name: 'currentApproverIndex', nullable: true, default: 0 })
  currentApproverIndex: number;

  @Column({ type: 'jsonb', nullable: true })
  requestData: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  responseData: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  comments: string;

  @Column({ name: 'expiresAt', type: 'timestamp', nullable: true })
  expiresAt: Date;

  @Column({ name: 'respondedAt', type: 'timestamp', nullable: true })
  respondedAt: Date;

  @Column({ name: 'escalationLevel', default: 0 })
  escalationLevel: number;

  // Timeout Action - Ação automática quando expirar
  @Column({
    type: 'varchar',
    enum: ['auto-reject', 'escalate', 'notify'],
    nullable: true,
    name: 'timeoutAction',
  })
  timeoutAction?: TimeoutAction;

  // Escalation Rules - Regras de escalação automática
  @Column({ type: 'jsonb', nullable: true, name: 'escalationRules' })
  escalationRules?: EscalationRule[];

  // Reassignment - Campos para reatribuição
  @Column({ name: 'reassignedFromId', nullable: true })
  reassignedFromId?: string;

  @Column({ type: 'text', nullable: true, name: 'reassignmentReason' })
  reassignmentReason?: string;

  @Column({ name: 'reassignedAt', type: 'timestamp', nullable: true })
  reassignedAt?: Date;

  // Delegation - Campos para delegação
  @Column({ name: 'delegatedToId', nullable: true })
  delegatedToId?: string;

  @Column({ name: 'delegatedById', nullable: true })
  delegatedById?: string;

  @Column({ name: 'delegatedAt', type: 'timestamp', nullable: true })
  delegatedAt?: Date;

  // Escalation Tracking - Rastreio de escalações
  @Column({ name: 'lastEscalatedAt', type: 'timestamp', nullable: true })
  lastEscalatedAt?: Date;

  // Notification Tracking - Rastreio de notificações
  @Column({ name: 'lastNotifiedAt', type: 'timestamp', nullable: true })
  lastNotifiedAt?: Date;

  @Column({ name: 'notificationCount', default: 0 })
  notificationCount: number;

  @Column({
    type: 'varchar',
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  })
  priority: ApprovalPriority;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ name: 'tenantId', nullable: true })
  tenantId: string;

  @CreateDateColumn({ name: 'createdAt' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updatedAt' })
  updatedAt: Date;

  @OneToMany('ApprovalVotesEntity', 'approval')
  votes: any[];

  @OneToMany('ApprovalHistoryEntity', 'approval')
  history: any[];

  @OneToMany('ApprovalReminderEntity', 'approval')
  reminders: any[];
}
