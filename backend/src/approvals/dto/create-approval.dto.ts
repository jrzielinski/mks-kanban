import { IsString, IsOptional, IsEnum, IsUUID, IsObject, IsDateString, IsNumber, IsArray, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ApprovalPriority, ApprovalStatus, ApprovalStrategy, SequentialApprover, TimeoutAction, EscalationRule } from '../entities/approval.entity';

export class CreateApprovalDto {
  @ApiProperty({ description: 'ID da execução do fluxo' })
  @IsUUID()
  flowExecutionId: string;

  @ApiProperty({ description: 'ID do fluxo' })
  @IsUUID()
  flowId: string;

  @ApiProperty({ description: 'ID do node de aprovação no fluxo' })
  @IsString()
  nodeId: string;

  @ApiProperty({ description: 'Título da aprovação' })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  title: string;

  @ApiProperty({ description: 'Descrição detalhada', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Prioridade da aprovação',
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  })
  @IsEnum(['low', 'medium', 'high', 'urgent'])
  @IsOptional()
  priority?: ApprovalPriority;

  @ApiProperty({ description: 'ID do solicitante', required: false })
  @IsUUID()
  @IsOptional()
  requesterId?: string;

  @ApiProperty({ description: 'ID do aprovador específico', required: false })
  @IsUUID()
  @IsOptional()
  approverId?: string;

  @ApiProperty({ description: 'ID do grupo de aprovadores', required: false })
  @IsUUID()
  @IsOptional()
  approverGroupId?: string;

  @ApiProperty({
    description: 'Estratégia de aprovação',
    enum: ['first_to_respond', 'all_must_approve', 'sequential'],
    default: 'first_to_respond',
    required: false,
  })
  @IsEnum(['first_to_respond', 'all_must_approve', 'sequential'])
  @IsOptional()
  approvalStrategy?: ApprovalStrategy;

  @ApiProperty({
    description: 'Lista de aprovadores para aprovação sequencial',
    required: false,
    isArray: true,
  })
  @IsArray()
  @IsOptional()
  sequentialApprovers?: SequentialApprover[];

  @ApiProperty({ description: 'Dados da solicitação (formulário, variáveis, etc)', required: false })
  @IsObject()
  @IsOptional()
  requestData?: Record<string, any>;

  @ApiProperty({ description: 'Data/hora de expiração', required: false })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  @ApiProperty({ description: 'Nível de escalação', required: false, default: 0 })
  @IsNumber()
  @IsOptional()
  escalationLevel?: number;

  @ApiProperty({ description: 'Tenant ID', required: false })
  @IsString()
  @IsOptional()
  tenantId?: string;

  @ApiProperty({
    description: 'Ação automática quando a aprovação expirar',
    enum: ['auto-reject', 'escalate', 'notify'],
    required: false,
  })
  @IsEnum(['auto-reject', 'escalate', 'notify'])
  @IsOptional()
  timeoutAction?: TimeoutAction;

  @ApiProperty({
    description: 'Regras de escalação automática',
    required: false,
    isArray: true,
    example: [
      { after: 1440, action: 'notify', targetUserId: 'supervisor-id' },
      { after: 2880, action: 'escalate', targetUserId: 'manager-id' },
      { after: 4320, action: 'auto-reject' }
    ]
  })
  @IsArray()
  @IsOptional()
  escalationRules?: EscalationRule[];
}
