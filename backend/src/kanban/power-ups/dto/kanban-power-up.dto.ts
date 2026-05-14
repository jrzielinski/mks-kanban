// src/kanban/power-ups/dto/kanban-power-up.dto.ts
import { IsString, IsOptional, IsArray, IsEnum, IsObject } from 'class-validator';
import { KanbanEventKey } from '../types';
import { PowerUpMode } from '../kanban-power-up-template.entity';

export class CreatePowerUpTemplateDto {
  @IsString() name: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum(['simple', 'builder', 'script']) mode: PowerUpMode;
  @IsArray() triggerEvents: KanbanEventKey[];
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsObject() headersTemplate?: Record<string, string>;
  @IsOptional() @IsObject() payloadTemplate?: Record<string, unknown>;
  @IsOptional() @IsArray() configSchema?: any[];
  @IsOptional() @IsString() script?: string;
  @IsOptional() @IsArray() responseMapping?: any[];
}

export class UpdatePowerUpTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(['simple', 'builder', 'script']) mode?: PowerUpMode;
  @IsOptional() @IsArray() triggerEvents?: KanbanEventKey[];
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsObject() headersTemplate?: Record<string, string>;
  @IsOptional() @IsObject() payloadTemplate?: Record<string, unknown>;
  @IsOptional() @IsArray() configSchema?: any[];
  @IsOptional() @IsString() script?: string;
  @IsOptional() @IsArray() responseMapping?: any[];
}

export class ApproveTemplateDto {
  @IsEnum(['board', 'tenant', 'template']) scope: 'board' | 'tenant' | 'template';
}

export class RejectTemplateDto {
  @IsString() reason: string;
}

export class InstallPowerUpDto {
  @IsString() templateId: string;
  @IsOptional() @IsObject() config?: Record<string, string>;
}
