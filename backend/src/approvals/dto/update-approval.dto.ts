import { IsString, IsOptional, IsEnum, IsObject, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ApprovalStatus } from '../entities/approval.entity';

export class UpdateApprovalDto {
  @ApiProperty({
    description: 'Novo status da aprovação',
    enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
    required: false
  })
  @IsEnum(['pending', 'approved', 'rejected', 'expired', 'cancelled'])
  @IsOptional()
  status?: ApprovalStatus;

  @ApiProperty({ description: 'Comentários sobre a decisão', required: false })
  @IsString()
  @IsOptional()
  comments?: string;

  @ApiProperty({ description: 'Dados da resposta do aprovador', required: false })
  @IsObject()
  @IsOptional()
  responseData?: Record<string, any>;

  @ApiProperty({ description: 'ID de quem aprovou/rejeitou', required: false })
  @IsUUID()
  @IsOptional()
  approvedById?: string;
}
