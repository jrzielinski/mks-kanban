import { IsString, IsOptional, IsBoolean, IsUUID, IsEnum } from 'class-validator';

export type ExecType = 'code' | 'analysis' | 'mockup' | 'tests' | 'review' | 'custom';

export class CreateBoardRepoDto {
  @IsString() name: string;
  @IsString() repoUrl: string;
  @IsOptional() @IsString() defaultBranch?: string;
  @IsOptional() @IsString() gitToken?: string;
}

export class UpdateBoardRepoDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() repoUrl?: string;
  @IsOptional() @IsString() defaultBranch?: string;
  @IsOptional() @IsString() gitToken?: string;
}

export class UpsertListAgentConfigDto {
  @IsString() boardId: string;  // required — which board this list belongs to
  @IsBoolean() enabled: boolean;
  @IsOptional() @IsEnum(['code', 'analysis', 'mockup', 'tests', 'review', 'custom']) defaultExecType?: ExecType;
  @IsOptional() @IsUUID() defaultRepoId?: string;
  @IsOptional() @IsString() defaultBranch?: string;
  @IsOptional() @IsString() promptPrefix?: string;
  @IsOptional() @IsString() moveOnCompleteListId?: string;
  @IsOptional() @IsString() moveOnFailListId?: string;
}

export class ExecuteCardDto {
  @IsEnum(['code', 'analysis', 'mockup', 'tests', 'review', 'custom'])
  execType: ExecType;

  @IsOptional() @IsUUID() repoId?: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsString() customPrompt?: string;
}
