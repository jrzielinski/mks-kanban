import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserMfaFields1776800100000 implements MigrationInterface {
  name = 'AddUserMfaFields1776800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD "mfa_enabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "user" ADD "mfa_secret" varchar NULL`);
    await queryRunner.query(`ALTER TABLE "user" ADD "mfa_backup_codes" text NULL`);
    await queryRunner.query(`ALTER TABLE "user" ADD "mfa_verified_at" TIMESTAMP NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "mfa_verified_at"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "mfa_backup_codes"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "mfa_secret"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "mfa_enabled"`);
  }
}
