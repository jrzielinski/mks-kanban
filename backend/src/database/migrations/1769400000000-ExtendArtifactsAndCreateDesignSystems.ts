import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExtendArtifactsAndCreateDesignSystems1769400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Extend dark_factory_artifacts with Designer fields
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "dum_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "agent_role" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "title" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "phase" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "status" varchar DEFAULT 'draft'`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "description" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "png_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "source_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "html_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "client_feedback" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "requirement_ids" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "tenant_id" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" ADD "updated_at" TIMESTAMP DEFAULT now()`,
    );

    // FK to D.U.M
    await queryRunner.query(`
      ALTER TABLE "dark_factory_artifacts" ADD CONSTRAINT "FK_artifacts_dum"
        FOREIGN KEY ("dum_id") REFERENCES "dark_factory_dums"("id") ON DELETE SET NULL
    `);

    // Indexes
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_dum_id" ON "dark_factory_artifacts" ("dum_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_agent_role" ON "dark_factory_artifacts" ("agent_role")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_status" ON "dark_factory_artifacts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_phase" ON "dark_factory_artifacts" ("phase")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_tenant_id" ON "dark_factory_artifacts" ("tenant_id")`,
    );

    // 2. Create dark_factory_design_systems table (1 per project)
    await queryRunner.query(`
      CREATE TABLE "dark_factory_design_systems" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "colors" jsonb,
        "typography" jsonb,
        "components" jsonb,
        "spacing" jsonb,
        "borders" jsonb,
        "notes" text,
        "version" integer NOT NULL DEFAULT 1,
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_design_systems" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dark_factory_design_systems_project" UNIQUE ("project_id"),
        CONSTRAINT "FK_dark_factory_design_systems_project" FOREIGN KEY ("project_id")
          REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_design_systems_tenant" ON "dark_factory_design_systems" ("tenant_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop design systems table
    await queryRunner.query(
      `DROP TABLE IF EXISTS "dark_factory_design_systems"`,
    );

    // Remove indexes from artifacts
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_artifacts_tenant_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_artifacts_phase"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_artifacts_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_artifacts_agent_role"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_artifacts_dum_id"`);

    // Remove FK
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP CONSTRAINT IF EXISTS "FK_artifacts_dum"`,
    );

    // Remove columns from artifacts
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "updated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "requirement_ids"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "client_feedback"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "html_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "source_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "png_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "description"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "phase"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "title"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "agent_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_artifacts" DROP COLUMN IF EXISTS "dum_id"`,
    );
  }
}
