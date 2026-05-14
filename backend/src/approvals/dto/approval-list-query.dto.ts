import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ApprovalListQueryDto {
  @ApiPropertyOptional({
    description: 'Filtrar por status',
    enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
    example: 'pending',
  })
  @IsString()
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'expired', 'cancelled'])
  status?: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

  @ApiPropertyOptional({
    description: 'Filtrar por ID do aprovador',
    example: 'user-123',
  })
  @IsString()
  @IsOptional()
  approverId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por ID do grupo de aprovadores',
    example: 'group-456',
  })
  @IsString()
  @IsOptional()
  approverGroupId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por ID do fluxo',
    example: 'flow-789',
  })
  @IsString()
  @IsOptional()
  flowId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por prioridade',
    enum: ['low', 'medium', 'high', 'urgent'],
    example: 'high',
  })
  @IsString()
  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'urgent'])
  priority?: 'low' | 'medium' | 'high' | 'urgent';

  @ApiPropertyOptional({
    description: 'Número da página',
    example: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Itens por página',
    example: 20,
    default: 20,
  })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Campo para ordenação',
    example: 'createdAt',
    default: 'createdAt',
  })
  @IsString()
  @IsOptional()
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({
    description: 'Ordem de ordenação',
    enum: ['ASC', 'DESC'],
    example: 'DESC',
    default: 'DESC',
  })
  @IsString()
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}
