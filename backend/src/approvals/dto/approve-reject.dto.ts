import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsObject } from 'class-validator';

export class ApproveRejectDto {
  @ApiProperty({
    description: 'Ação a ser tomada',
    enum: ['approve', 'reject'],
    example: 'approve',
  })
  @IsString()
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @ApiProperty({
    description: 'Comentários da aprovação/rejeição',
    required: false,
    example: 'Aprovado conforme solicitado',
  })
  @IsString()
  @IsOptional()
  comments?: string;

  @ApiProperty({
    description: 'Dados de resposta adicionais',
    required: false,
    example: { approvedAmount: 1000, notes: 'Valor ajustado' },
  })
  @IsObject()
  @IsOptional()
  responseData?: Record<string, any>;

  @ApiProperty({
    description: 'ID do usuário que está aprovando/rejeitando',
    required: false,
  })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiProperty({
    description: 'Email do usuário que está aprovando/rejeitando',
    required: false,
  })
  @IsString()
  @IsOptional()
  userEmail?: string;

  @ApiProperty({
    description: 'Nome do usuário que está aprovando/rejeitando',
    required: false,
  })
  @IsString()
  @IsOptional()
  userName?: string;
}
