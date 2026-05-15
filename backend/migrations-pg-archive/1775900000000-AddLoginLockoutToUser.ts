import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLoginLockoutToUser1775900000000 implements MigrationInterface {
  name = 'AddLoginLockoutToUser1775900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user"
        ADD COLUMN IF NOT EXISTS "failed_login_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP NULL,
        ADD COLUMN IF NOT EXISTS "is_banned" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user"
        DROP COLUMN IF EXISTS "failed_login_attempts",
        DROP COLUMN IF EXISTS "locked_until",
        DROP COLUMN IF EXISTS "is_banned"
    `);
  }
}
