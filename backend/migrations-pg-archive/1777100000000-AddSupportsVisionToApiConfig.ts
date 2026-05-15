import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSupportsVisionToApiConfig1777100000000 implements MigrationInterface {
  name = 'AddSupportsVisionToApiConfig1777100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_config" ADD COLUMN IF NOT EXISTS "supportsVision" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_config" DROP COLUMN IF EXISTS "supportsVision"`,
    );
  }
}
