import { IsString, IsUUID, IsOptional, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReassignApprovalDto {
  @ApiProperty({ description: 'ID do novo aprovador', required: false })
  @IsUUID()
  @IsOptional()
  newApproverId?: string;

  @ApiProperty({ description: 'ID do novo grupo de aprovadores', required: false })
  @IsUUID()
  @IsOptional()
  newApproverGroupId?: string;

  @ApiProperty({ description: 'Motivo da reatribuição' })
  @IsString()
  @MinLength(3)
  reason: string;

  @ApiProperty({ description: 'ID do usuário que está reatribuindo' })
  @IsString()
  reassignedBy: string;
}

export class DelegateApprovalDto {
  @ApiProperty({ description: 'ID do usuário para quem delegar' })
  @IsUUID()
  delegateToId: string;

  @ApiProperty({ description: 'ID do usuário que está delegando' })
  @IsString()
  delegatedBy: string;

  @ApiProperty({ description: 'Motivo da delegação', required: false })
  @IsString()
  @IsOptional()
  reason?: string;
}
