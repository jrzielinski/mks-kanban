// src/kanban/dto/kanban.dto.ts
import { IsString, IsOptional, IsBoolean, IsInt, IsUUID, IsArray, IsDateString, IsIn, IsObject } from 'class-validator';
import { KanbanBoardMember, KanbanBoardLabel, KanbanAutomationRule, KanbanCustomFieldDef } from '../entities/kanban-board.entity';
import { KanbanAttachment, KanbanChecklistGroup, KanbanRecurrence, KanbanCardLocation } from '../entities/kanban-card.entity';
import { KanbanPowerUpType } from '../entities/kanban-power-up.entity';

export class CreateBoardDto {
  @IsString() title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsString() templateId?: string;
}

export class UpdateBoardDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() backgroundColor?: string;
  @IsOptional() @IsString() backgroundImage?: string;
  @IsOptional() @IsArray() customFieldDefs?: KanbanCustomFieldDef[];
  @IsOptional() @IsArray() members?: KanbanBoardMember[];
  @IsOptional() @IsArray() boardLabels?: KanbanBoardLabel[];
  @IsOptional() @IsArray() automationRules?: KanbanAutomationRule[];
  @IsOptional() @IsBoolean() isArchived?: boolean;
  @IsOptional() @IsString() visibility?: 'private' | 'workspace' | 'public';
  @IsOptional() @IsString() workspaceId?: string | null;
  @IsOptional() @IsBoolean() isTemplate?: boolean;
}

export class CreateListDto {
  @IsString() title: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsInt() position?: number;
}

export class UpdateListDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() isArchived?: boolean;
  @IsOptional() @IsInt() wipLimit?: number;
}

export class ReorderListsDto {
  @IsArray() listIds: string[]; // ordered array of IDs
}

export class CreateCardDto {
  @IsString() title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() position?: number;
  @IsOptional() @IsDateString() dueDate?: string;
}

export class UpdateCardDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() labels?: { text: string; color: string }[];
  @IsOptional() @IsArray() checklist?: { text: string; done: boolean }[];
  @IsOptional() @IsArray() checklists?: KanbanChecklistGroup[];
  @IsOptional() @IsArray() attachments?: KanbanAttachment[];
  @IsOptional() @IsArray() memberIds?: string[];
  @IsOptional() dueDate?: string | null;
  @IsOptional() startDate?: string | null;
  @IsOptional() @IsArray() votes?: string[];
  @IsOptional() @IsArray() stickers?: string[];
  @IsOptional() @IsObject() customFields?: Record<string, string | number | boolean | null>;
  @IsOptional() recurrence?: KanbanRecurrence | null;
  @IsOptional() @IsString() coverColor?: string;
  @IsOptional() @IsString() coverImageUrl?: string | null;
  @IsOptional() @IsString() coverAttachmentId?: string | null;
  @IsOptional() @IsBoolean() isArchived?: boolean;
  @IsOptional() location?: KanbanCardLocation | null;
  @IsOptional() @IsArray() blockedBy?: string[];
}

export class CreateWorkspaceDto {
  @IsString() name: string;
  @IsOptional() @IsString() color?: string;
}

export class UpdateWorkspaceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() color?: string;
}

export class CreatePowerUpDto {
  @IsString() type: KanbanPowerUpType;
  @IsObject() config: Record<string, any>;
}

export class UpdatePowerUpDto {
  @IsOptional() @IsObject() config?: Record<string, any>;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class AdvancedSearchDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() boardId?: string;
  @IsOptional() @IsString() listId?: string;
  @IsOptional() @IsString() memberId?: string;
  @IsOptional() @IsString() labelColor?: string;
  @IsOptional() @IsString() dueBefore?: string;
  @IsOptional() @IsString() dueAfter?: string;
  @IsOptional() @IsBoolean() hasAttachment?: boolean;
  @IsOptional() @IsBoolean() isOverdue?: boolean;
  @IsOptional() @IsString() workspaceId?: string;
}

export class InviteByEmailDto {
  @IsString() email: string;
  @IsOptional() @IsString() inviterName?: string;
}

export class MoveCardDto {
  @IsUUID() targetListId: string;
  @IsInt() position: number;
}

export class MoveCardToBoardDto {
  @IsUUID() targetBoardId: string;
  @IsUUID() targetListId: string;
  @IsInt() position: number;
}

export class CreateActivityDto {
  @IsString() text: string;
  @IsOptional() @IsString() userName?: string;
  @IsOptional() @IsIn(['comment', 'event']) type?: 'comment' | 'event';
}

export class UpdateActivityDto {
  @IsString() text: string;
}

export class SearchCardsDto {
  @IsString() q: string;
}

export class CreateTimeLogDto {
  @IsOptional() hours: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() loggedDate?: string;
  @IsOptional() @IsString() userName?: string;
}

export class UpdateTimeLogDto {
  @IsOptional() hours?: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() loggedDate?: string;
}

export class CreateHourRequestDto {
  hours: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() loggedDate?: string;
  @IsOptional() @IsString() userName?: string;
  @IsOptional() @IsString() userId?: string;
}
