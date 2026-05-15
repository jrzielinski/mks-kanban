import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTaskAssigneesTable1770700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_task_assignees" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "task_id" varchar NOT NULL,
        "user_id" int NOT NULL,
        "user_name" varchar NOT NULL,
        "tenant_id" varchar NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "assigned_at" timestamp NOT NULL DEFAULT now(),
        "removed_at" timestamp,
        "removed_by" varchar,
        CONSTRAINT "PK_dark_factory_task_assignees" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_assignees_task_id" ON "dark_factory_task_assignees" ("task_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_assignees_user_id" ON "dark_factory_task_assignees" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_task_assignees"`);
  }
}
