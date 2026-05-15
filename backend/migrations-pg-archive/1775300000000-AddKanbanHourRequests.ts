import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanHourRequests1775300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Make flowExecutionId, flowId, nodeId nullable in approvals table
    await queryRunner.query(`
      ALTER TABLE "approvals"
        ALTER COLUMN "flowExecutionId" DROP NOT NULL,
        ALTER COLUMN "flowId" DROP NOT NULL,
        ALTER COLUMN "nodeId" DROP NOT NULL
    `);

    // Add maxHours to kanban_cards
    await queryRunner.query(`
      ALTER TABLE "kanban_cards"
        ADD COLUMN IF NOT EXISTS "max_hours" FLOAT NULL
    `);

    // Create kanban_hour_requests table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_hour_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "card_id" VARCHAR NOT NULL,
        "board_id" VARCHAR NOT NULL,
        "tenant_id" VARCHAR NOT NULL,
        "user_id" VARCHAR NULL,
        "user_name" VARCHAR NULL,
        "hours" FLOAT NOT NULL,
        "description" TEXT NULL,
        "logged_date" DATE NOT NULL,
        "status" VARCHAR NOT NULL DEFAULT 'pending',
        "approval_id" VARCHAR NULL,
        "reviewed_by" VARCHAR NULL,
        "reviewed_at" TIMESTAMP NULL,
        "review_note" TEXT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kanban_hour_requests_card_id"
        ON "kanban_hour_requests" ("card_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kanban_hour_requests_tenant_id"
        ON "kanban_hour_requests" ("tenant_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kanban_hour_requests_approval_id"
        ON "kanban_hour_requests" ("approval_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_hour_requests"`);
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "max_hours"`);
    await queryRunner.query(`
      ALTER TABLE "approvals"
        ALTER COLUMN "flowExecutionId" SET NOT NULL,
        ALTER COLUMN "flowId" SET NOT NULL,
        ALTER COLUMN "nodeId" SET NOT NULL
    `);
  }
}
