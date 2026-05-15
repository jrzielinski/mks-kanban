import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjectToolsTable1770800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_project_tools" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" varchar NOT NULL,
        "tenant_id" varchar NOT NULL,
        "tool_type" varchar NOT NULL,
        "resource_id" varchar,
        "name" varchar NOT NULL,
        "description" text,
        "config" jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_project_tools" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_project_tools_project_id" ON "dark_factory_project_tools" ("project_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_project_tools"`);
  }
}
