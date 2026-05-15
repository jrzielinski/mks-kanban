import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDarkFactoryKanbanTables1769500000000
  implements MigrationInterface
{
  name = 'CreateDarkFactoryKanbanTables1769500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_kanban_tasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" varchar NOT NULL,
        "description" text,
        "acceptance_criteria" jsonb,
        "type" varchar NOT NULL DEFAULT 'feature',
        "agent_role" varchar,
        "status" varchar NOT NULL DEFAULT 'pending',
        "branch_name" varchar,
        "pr_url" varchar,
        "pr_number" int,
        "artifacts" jsonb,
        "test_results" jsonb,
        "cost_usd" float NOT NULL DEFAULT 0,
        "tokens_used" int NOT NULL DEFAULT 0,
        "priority" int NOT NULL DEFAULT 0,
        "parent_task_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_kanban_tasks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_kanban_tasks_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dark_factory_kanban_tasks_parent" FOREIGN KEY ("parent_task_id") REFERENCES "dark_factory_kanban_tasks"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_kanban_tasks_project" ON "dark_factory_kanban_tasks" ("project_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_kanban_tasks_status" ON "dark_factory_kanban_tasks" ("status")
    `);

    await queryRunner.query(`
      INSERT INTO "dark_factory_kanban_tasks" (
        "id",
        "project_id",
        "title",
        "description",
        "acceptance_criteria",
        "type",
        "agent_role",
        "status",
        "branch_name",
        "pr_url",
        "pr_number",
        "artifacts",
        "test_results",
        "cost_usd",
        "tokens_used",
        "priority",
        "parent_task_id",
        "created_at",
        "updated_at"
      )
      SELECT
        t."id",
        t."project_id",
        t."title",
        t."description",
        t."acceptance_criteria",
        t."type",
        t."agent_role",
        t."status",
        t."branch_name",
        t."pr_url",
        t."pr_number",
        t."artifacts",
        t."test_results",
        t."cost_usd",
        t."tokens_used",
        t."priority",
        t."parent_task_id",
        t."created_at",
        t."updated_at"
      FROM "dark_factory_tasks" t
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_kanban_subtasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "task_id" uuid NOT NULL,
        "title" varchar NOT NULL,
        "description" text,
        "agent_role" varchar,
        "status" varchar NOT NULL DEFAULT 'pending',
        "priority" int NOT NULL DEFAULT 0,
        "position" int NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_kanban_subtasks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_kanban_subtasks_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dark_factory_kanban_subtasks_task" FOREIGN KEY ("task_id") REFERENCES "dark_factory_kanban_tasks"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_kanban_subtasks_task" ON "dark_factory_kanban_subtasks" ("task_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_kanban_subtasks_project" ON "dark_factory_kanban_subtasks" ("project_id")
    `);

    await queryRunner.query(`
      INSERT INTO "dark_factory_kanban_subtasks" (
        "id",
        "project_id",
        "task_id",
        "title",
        "description",
        "agent_role",
        "status",
        "priority",
        "position",
        "created_at",
        "updated_at"
      )
      SELECT
        t."id",
        t."project_id",
        t."parent_task_id",
        t."title",
        t."description",
        t."agent_role",
        t."status",
        t."priority",
        0,
        t."created_at",
        t."updated_at"
      FROM "dark_factory_kanban_tasks" t
      WHERE t."parent_task_id" IS NOT NULL
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_artifacts"
      DROP CONSTRAINT IF EXISTS "FK_dark_factory_artifacts_task"
    `);
    await queryRunner.query(`
      ALTER TABLE "dark_factory_artifacts"
      ADD CONSTRAINT "FK_dark_factory_artifacts_task"
      FOREIGN KEY ("task_id") REFERENCES "dark_factory_kanban_tasks"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_agent_logs"
      DROP CONSTRAINT IF EXISTS "FK_dark_factory_agent_logs_task"
    `);
    await queryRunner.query(`
      ALTER TABLE "dark_factory_agent_logs"
      ADD CONSTRAINT "FK_dark_factory_agent_logs_task"
      FOREIGN KEY ("task_id") REFERENCES "dark_factory_kanban_tasks"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_artifacts"
      DROP CONSTRAINT IF EXISTS "FK_dark_factory_artifacts_task"
    `);
    await queryRunner.query(`
      ALTER TABLE "dark_factory_artifacts"
      ADD CONSTRAINT "FK_dark_factory_artifacts_task"
      FOREIGN KEY ("task_id") REFERENCES "dark_factory_tasks"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_agent_logs"
      DROP CONSTRAINT IF EXISTS "FK_dark_factory_agent_logs_task"
    `);
    await queryRunner.query(`
      ALTER TABLE "dark_factory_agent_logs"
      ADD CONSTRAINT "FK_dark_factory_agent_logs_task"
      FOREIGN KEY ("task_id") REFERENCES "dark_factory_tasks"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_kanban_subtasks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_kanban_tasks"`);
  }
}
