import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDarkFactoryAnalystTables1769100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tabela de requisitos
    await queryRunner.query(`
      CREATE TABLE "dark_factory_requirements" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" varchar NOT NULL,
        "description" text,
        "type" varchar NOT NULL DEFAULT 'functional',
        "priority" varchar NOT NULL DEFAULT 'medium',
        "status" varchar NOT NULL DEFAULT 'identified',
        "source" varchar,
        "acceptance_criteria" jsonb,
        "dependencies" jsonb,
        "notes" text,
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_requirements" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_requirements_project" FOREIGN KEY ("project_id")
          REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_requirements_project" ON "dark_factory_requirements" ("project_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_requirements_tenant" ON "dark_factory_requirements" ("tenant_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_requirements_status" ON "dark_factory_requirements" ("status")
    `);

    // 2. Tabela de decisões
    await queryRunner.query(`
      CREATE TABLE "dark_factory_decisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" varchar NOT NULL,
        "decision" text NOT NULL,
        "rationale" text,
        "alternatives" jsonb,
        "impact" jsonb,
        "decided_by" varchar,
        "status" varchar NOT NULL DEFAULT 'proposed',
        "related_requirement_ids" jsonb,
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_decisions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_decisions_project" FOREIGN KEY ("project_id")
          REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_decisions_project" ON "dark_factory_decisions" ("project_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_decisions_tenant" ON "dark_factory_decisions" ("tenant_id")
    `);

    // 3. Permitir promptId nullable em chat_session (Dark Factory não usa prompt do registry)
    await queryRunner.query(`
      ALTER TABLE "chat_session" ALTER COLUMN "promptId" DROP NOT NULL
    `);

    // 4. Estender tabela de projetos
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "current_phase" varchar DEFAULT 'analyst_understanding'
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "phase_summaries" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "phase_summaries"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "current_phase"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_decisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_requirements"`);
  }
}
