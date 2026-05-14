import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionExpiresAt1776800000000 implements MigrationInterface {
  name = 'AddSessionExpiresAt1776800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "session" ADD "expiresAt" TIMESTAMP`);
    await queryRunner.query(`CREATE INDEX "IDX_session_expiresAt" ON "session" ("expiresAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_session_expiresAt"`);
    await queryRunner.query(`ALTER TABLE "session" DROP COLUMN "expiresAt"`);
  }
}
