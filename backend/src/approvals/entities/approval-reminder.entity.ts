import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type ReminderType = 'initial' | 'reminder' | 'escalation' | 'expiration';
export type ReminderChannel = 'email' | 'whatsapp' | 'sms';

@Entity('approval_reminders')
@Index(['approvalId'])
export class ApprovalReminderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'approvalId' })
  approvalId: string;

  @ManyToOne('ApprovalEntity', 'reminders', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'approvalId' })
  approval: any;

  @Column({
    name: 'reminderType',
    type: 'varchar',
    enum: ['initial', 'reminder', 'escalation', 'expiration'],
  })
  reminderType: ReminderType;

  @Column({ name: 'sentAt', type: 'timestamp', default: () => 'NOW()' })
  sentAt: Date;

  @Column({ name: 'recipientId', nullable: true })
  recipientId: string;

  @Column({ name: 'recipientEmail', nullable: true })
  recipientEmail: string;

  @Column({ name: 'recipientPhone', nullable: true })
  recipientPhone: string;

  @Column({
    type: 'varchar',
    enum: ['email', 'whatsapp', 'sms'],
  })
  channel: ReminderChannel;

  @CreateDateColumn({ name: 'createdAt' })
  createdAt: Date;
}
