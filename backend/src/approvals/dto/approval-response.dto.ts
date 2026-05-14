import { ApiProperty } from '@nestjs/swagger';
import { ApprovalStatus, ApprovalPriority, ApprovalStrategy, SequentialApprover } from '../entities/approval.entity';

export class ApprovalVoteResponseDto {
  @ApiProperty({ description: 'ID do voto' })
  id: string;

  @ApiProperty({ description: 'ID do votante' })
  voterId: string;

  @ApiProperty({ description: 'Decisão', enum: ['approved', 'rejected'] })
  decision: 'approved' | 'rejected';

  @ApiProperty({ description: 'Comentários', required: false })
  comments?: string;

  @ApiProperty({ description: 'Dados da resposta', required: false })
  responseData?: Record<string, any>;

  @ApiProperty({ description: 'Data do voto' })
  votedAt: Date;
}

export class ApprovalResponseDto {
  @ApiProperty({ description: 'ID da aprovação' })
  id: string;

  @ApiProperty({ description: 'ID da execução do fluxo' })
  flowExecutionId: string;

  @ApiProperty({ description: 'ID do fluxo' })
  flowId: string;

  @ApiProperty({ description: 'ID do node' })
  nodeId: string;

  @ApiProperty({
    description: 'Status da aprovação',
    enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
  })
  status: ApprovalStatus;

  @ApiProperty({ description: 'ID do solicitante', required: false })
  requesterId?: string;

  @ApiProperty({ description: 'ID do aprovador', required: false })
  approverId?: string;

  @ApiProperty({ description: 'ID do grupo de aprovadores', required: false })
  approverGroupId?: string;

  @ApiProperty({ description: 'ID de quem aprovou/rejeitou', required: false })
  approvedById?: string;

  @ApiProperty({
    description: 'Estratégia de aprovação',
    enum: ['first_to_respond', 'all_must_approve', 'sequential'],
    required: false,
  })
  approvalStrategy?: ApprovalStrategy;

  @ApiProperty({ description: 'Lista de aprovadores sequenciais', required: false, isArray: true })
  sequentialApprovers?: SequentialApprover[];

  @ApiProperty({ description: 'Índice do aprovador atual (para sequencial)', required: false })
  currentApproverIndex?: number;

  @ApiProperty({ description: 'Dados da solicitação', required: false })
  requestData?: Record<string, any>;

  @ApiProperty({ description: 'Dados da resposta', required: false })
  responseData?: Record<string, any>;

  @ApiProperty({ description: 'Comentários', required: false })
  comments?: string;

  @ApiProperty({ description: 'Data de expiração', required: false })
  expiresAt?: Date;

  @ApiProperty({ description: 'Data da resposta', required: false })
  respondedAt?: Date;

  @ApiProperty({ description: 'Nível de escalação' })
  escalationLevel: number;

  @ApiProperty({
    description: 'Prioridade',
    enum: ['low', 'medium', 'high', 'urgent'],
  })
  priority: ApprovalPriority;

  @ApiProperty({ description: 'Título' })
  title: string;

  @ApiProperty({ description: 'Descrição', required: false })
  description?: string;

  @ApiProperty({ description: 'Tenant ID', required: false })
  tenantId?: string;

  @ApiProperty({ description: 'Data de criação' })
  createdAt: Date;

  @ApiProperty({ description: 'Data de atualização' })
  updatedAt: Date;

  @ApiProperty({ description: 'Votos registrados', required: false, isArray: true })
  votes?: ApprovalVoteResponseDto[];

  @ApiProperty({ description: 'Histórico de ações', required: false, isArray: true })
  history?: ApprovalHistoryResponseDto[];

  @ApiProperty({ description: 'Lembretes enviados', required: false, isArray: true })
  reminders?: ApprovalReminderResponseDto[];
}

export class ApprovalHistoryResponseDto {
  @ApiProperty({ description: 'ID do histórico' })
  id: string;

  @ApiProperty({ description: 'Ação realizada' })
  action: string;

  @ApiProperty({ description: 'ID de quem realizou', required: false })
  performedById?: string;

  @ApiProperty({ description: 'Email de quem realizou', required: false })
  performedByEmail?: string;

  @ApiProperty({ description: 'Nome de quem realizou', required: false })
  performedByName?: string;

  @ApiProperty({ description: 'Status anterior', required: false })
  previousStatus?: string;

  @ApiProperty({ description: 'Novo status', required: false })
  newStatus?: string;

  @ApiProperty({ description: 'Comentários', required: false })
  comments?: string;

  @ApiProperty({ description: 'Metadados adicionais', required: false })
  metadata?: Record<string, any>;

  @ApiProperty({ description: 'Data da ação' })
  createdAt: Date;
}

export class ApprovalReminderResponseDto {
  @ApiProperty({ description: 'ID do lembrete' })
  id: string;

  @ApiProperty({
    description: 'Tipo de lembrete',
    enum: ['initial', 'reminder', 'escalation', 'expiration'],
  })
  reminderType: string;

  @ApiProperty({ description: 'Data de envio' })
  sentAt: Date;

  @ApiProperty({ description: 'ID do destinatário', required: false })
  recipientId?: string;

  @ApiProperty({ description: 'Email do destinatário', required: false })
  recipientEmail?: string;

  @ApiProperty({ description: 'Telefone do destinatário', required: false })
  recipientPhone?: string;

  @ApiProperty({
    description: 'Canal utilizado',
    enum: ['email', 'whatsapp', 'sms'],
  })
  channel: string;

  @ApiProperty({ description: 'Data de criação' })
  createdAt: Date;
}
