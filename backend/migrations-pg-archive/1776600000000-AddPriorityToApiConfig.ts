import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPriorityToApiConfig1776600000000 implements MigrationInterface {
  name = 'AddPriorityToApiConfig1776600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "api_config"
      ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 0
    `);

    // Set default priorities: Groq=1, OpenAI=2, Google=3, Together=4, Anthropic=5
    await queryRunner.query(`UPDATE "api_config" SET "priority" = 1 WHERE "provider" = 'groq'`);
    await queryRunner.query(`UPDATE "api_config" SET "priority" = 2 WHERE "provider" = 'openai'`);
    await queryRunner.query(`UPDATE "api_config" SET "priority" = 3 WHERE "provider" = 'google'`);
    await queryRunner.query(`UPDATE "api_config" SET "priority" = 4 WHERE "provider" = 'together'`);
    await queryRunner.query(`UPDATE "api_config" SET "priority" = 5 WHERE "provider" = 'anthropic'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "api_config" DROP COLUMN IF EXISTS "priority"`);
  }
}
