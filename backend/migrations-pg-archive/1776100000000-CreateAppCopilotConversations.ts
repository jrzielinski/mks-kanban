import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppCopilotConversations1776100000000 implements MigrationInterface {
  name = 'CreateAppCopilotConversations1776100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_copilot_conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "appId" character varying,
        "summary" text,
        "turns" jsonb NOT NULL DEFAULT '[]',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_copilot_conversations_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_copilot_conversations_tenantId"
        ON "app_copilot_conversations" ("tenantId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_copilot_conversations_userId"
        ON "app_copilot_conversations" ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_copilot_conversations_appId"
        ON "app_copilot_conversations" ("appId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "app_copilot_conversations"`);
  }
}
