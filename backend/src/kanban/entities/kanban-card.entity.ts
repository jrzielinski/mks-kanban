// src/kanban/entities/kanban-card.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface KanbanLabel {
  text: string;
  color: string;
}

export interface KanbanChecklist {
  text: string;
  done: boolean;
}

export interface KanbanChecklistItem {
  id?: string;
  text: string;
  done: boolean;
  dueDate?: string | null;
  assignedTo?: string | null;
}

export interface KanbanChecklistGroup {
  id: string;
  title: string;
  items: KanbanChecklistItem[];
}

export interface KanbanRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  dayOfWeek?: number; // 0-6 for weekly
  dayOfMonth?: number; // 1-31 for monthly
  nextRun?: string; // ISO date string
}

export interface KanbanAttachment {
  id: string;
  name: string;
  url: string;
  isImage: boolean;
  addedAt: string;
}

export interface KanbanCardLocation {
  lat: number;
  lng: number;
  address?: string;
}

@Entity('kanban_cards')
@Index(['listId'])
@Index(['boardId'])
@Index(['tenantId'])
export class KanbanCardEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'list_id' })
  listId: string;

  @Column({ name: 'board_id' })
  boardId: string;

  @Column()
  title: string;

  @Column({ nullable: true, type: 'text' })
  description: string | null;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'jsonb', default: '[]' })
  labels: KanbanLabel[];

  @Column({ type: 'jsonb', default: '[]' })
  checklist: KanbanChecklist[];

  @Column({ type: 'jsonb', default: '[]' })
  checklists: KanbanChecklistGroup[];

  @Column({ type: 'jsonb', default: '[]' })
  attachments: KanbanAttachment[];

  @Column({ name: 'member_ids', type: 'jsonb', default: '[]' })
  memberIds: string[];

  @Column({ name: 'start_date', nullable: true, type: 'timestamp' })
  startDate: Date | null;

  @Column({ name: 'due_date', nullable: true, type: 'timestamp' })
  dueDate: Date | null;

  @Column({ name: 'votes', type: 'jsonb', default: '[]' })
  votes: string[];

  @Column({ type: 'jsonb', default: '[]' })
  stickers: string[];

  @Column({ name: 'custom_fields', type: 'jsonb', default: '{}' })
  customFields: Record<string, string | number | boolean | null>;

  @Column({ type: 'jsonb', nullable: true })
  recurrence: KanbanRecurrence | null;

  @Column({ name: 'cover_color', default: '#ffffff' })
  coverColor: string;

  @Column({ name: 'cover_image_url', nullable: true, type: 'text' })
  coverImageUrl: string | null;

  @Column({ name: 'cover_attachment_id', nullable: true, type: 'varchar' })
  coverAttachmentId: string | null;

  @Column({ name: 'is_archived', default: false })
  isArchived: boolean;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  // #37 watch card
  @Column({ name: 'watched_by', type: 'jsonb', default: '[]' })
  watchedBy: string[];

  // #43 location
  @Column({ type: 'jsonb', nullable: true })
  location: KanbanCardLocation | null;

  // #38 due date notification tracking
  @Column({ name: 'last_due_notified_at', nullable: true, type: 'timestamp' })
  lastDueNotifiedAt: Date | null;

  // Hour budget (manager sets max hours allowed)
  @Column({ name: 'max_hours', nullable: true, type: 'float' })
  maxHours: number | null;

  // C3: Linked cards
  @Column({ name: 'linked_card_ids', type: 'jsonb', default: '[]' })
  linkedCardIds: string[];

  // C4: Blocked by (dependency blocking)
  @Column({ name: 'blocked_by', type: 'jsonb', default: '[]' })
  blockedBy: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
