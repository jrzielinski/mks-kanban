import { ApiProperty } from '@nestjs/swagger';

export class ApprovalStatsDto {
  @ApiProperty({
    description: 'Total de aprovações pendentes',
    example: 15,
  })
  pending: number;

  @ApiProperty({
    description: 'Total de aprovações aprovadas',
    example: 120,
  })
  approved: number;

  @ApiProperty({
    description: 'Total de aprovações rejeitadas',
    example: 8,
  })
  rejected: number;

  @ApiProperty({
    description: 'Total de aprovações expiradas',
    example: 3,
  })
  expired: number;

  @ApiProperty({
    description: 'Total de aprovações canceladas',
    example: 2,
  })
  cancelled: number;

  @ApiProperty({
    description: 'Total geral de aprovações',
    example: 148,
  })
  total: number;

  @ApiProperty({
    description: 'Tempo médio de resposta em minutos',
    example: 45.5,
    required: false,
  })
  averageResponseTimeMinutes?: number;
}
