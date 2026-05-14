// src/kanban/entities/kanban-board.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export interface KanbanBoardMember {
  id: string;
  name: string;
  avatarColor?: string;
  email?: string;
}

export interface KanbanBoardLabel {
  id: string;
  text: string;
  color: string;
}

export interface KanbanCustomFieldDef {
  id: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'dropdown';
  options?: string[]; // for dropdown
}

export interface KanbanAutomationAction {
  type: 'add_label' | 'remove_label' | 'assign_member' | 'set_due_offset' | 'move_card' | 'archive_card' | 'send_webhook' | 'execute_flow' | 'open_app';
  labelColor?: string;
  labelText?: string;
  memberId?: string;
  daysOffset?: number;
  targetListId?: string;
  webhookUrl?: string;
  // execute_flow
  flowId?: string;
  flowName?: string;
  flowVariables?: Record<string, string>; // mapping: variableName -> card field (e.g., "cardTitle" -> "title")
  // open_app
  appId?: string;
  appName?: string;
  appPageSlug?: string;
  openMode?: 'dialog' | 'new_tab' | 'sidebar';
  appParams?: Record<string, string>; // params passed to the app (e.g., "cardId" -> card.id)
}

export interface KanbanAutomationTrigger {
  type: 'card_moved_to_list' | 'card_created' | 'due_date_approaching' | 'checklist_completed' | 'label_added' | 'member_assigned' | 'card_archived';
  listId?: string;
  listTitle?: string;
  daysBeforeDue?: number;
  labelColor?: string;
  memberId?: string;
}

export interface KanbanAutomationRule {
  id: string;
  enabled: boolean;
  trigger: KanbanAutomationTrigger;
  action: KanbanAutomationAction;
  description?: string;
}

@Entity('kanban_boards')
@Index(['tenantId'])
export class KanbanBoardEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column({ nullable: true, type: 'text' })
  description: string | null;

  @Column({ default: '#3b82f6' })
  color: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'owner_id', nullable: true, type: 'varchar' })
  ownerId: string | null;

  @Column({ type: 'jsonb', default: '[]' })
  members: KanbanBoardMember[];

  @Column({ name: 'board_labels', type: 'jsonb', default: '[]' })
  boardLabels: KanbanBoardLabel[];

  @Column({ name: 'automation_rules', type: 'jsonb', default: '[]' })
  automationRules: KanbanAutomationRule[];

  @Column({ nullable: true, type: 'varchar' })
  slug: string | null;

  @Column({ name: 'background_color', nullable: true, type: 'varchar' })
  backgroundColor: string | null;

  @Column({ name: 'background_image', nullable: true, type: 'varchar' })
  backgroundImage: string | null;

  @Column({ name: 'custom_field_defs', type: 'jsonb', default: '[]' })
  customFieldDefs: KanbanCustomFieldDef[];

  @Column({ name: 'is_archived', default: false })
  isArchived: boolean;

  // #35 visibility
  @Column({ default: 'private', type: 'varchar' })
  visibility: 'private' | 'workspace' | 'public';

  // #36 invite token
  @Column({ name: 'invite_token', nullable: true, type: 'varchar' })
  inviteToken: string | null;

  // #34 workspace
  @Column({ name: 'workspace_id', nullable: true, type: 'varchar' })
  workspaceId: string | null;

  // #39 board templates
  @Column({ name: 'is_template', default: false })
  isTemplate: boolean;

  // #37 watched by (user IDs)
  @Column({ name: 'watched_by', type: 'jsonb', default: '[]' })
  watchedBy: string[];

  // C5: Granular permissions
  @Column({ type: 'jsonb', default: '{}' })
  permissions: {
    membersCanComment?: boolean;
    membersCanEditCards?: boolean;
    observersCanView?: boolean;
    votingLimit?: number; // 0 = unlimited
  };

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
