import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskAssigneeAndComments1770400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add assignee columns to tasks
    await queryRunner.query(`
      ALTER TABLE "dark_factory_kanban_tasks"
      ADD COLUMN IF NOT EXISTS "assignee_id" int,
      ADD COLUMN IF NOT EXISTS "assignee_name" varchar
    `);

    // Create task comments table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_task_comments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "task_id" varchar NOT NULL,
        "user_id" int NOT NULL,
        "user_name" varchar NOT NULL,
        "content" text NOT NULL,
        "tenant_id" varchar NOT NULL,
        "type" varchar NOT NULL DEFAULT 'comment',
        "metadata" jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_task_comments" PRIMARY KEY ("id")
      )
    `);

    // Index for fast lookup
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_comments_task_id" ON "dark_factory_task_comments" ("task_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tasks_assignee_id" ON "dark_factory_kanban_tasks" ("assignee_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tasks_assignee_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_comments_task_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_task_comments"`);
    await queryRunner.query(`ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "assignee_id"`);
    await queryRunner.query(`ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "assignee_name"`);
  }
}
