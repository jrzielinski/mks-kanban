import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDUMTables1769300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tabela principal de D.U.Ms
    await queryRunner.query(`
      CREATE TABLE "dark_factory_dums" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "dum_number" varchar NOT NULL,
        "title" varchar NOT NULL,
        "description" text,
        "level" integer NOT NULL DEFAULT 1,
        "type" varchar,
        "parent_dum_id" uuid,
        "stage" varchar NOT NULL DEFAULT 'design',
        "created_by" varchar NOT NULL,
        "doc_version" integer NOT NULL DEFAULT 1,
        "current_owner" varchar,
        "priority" varchar DEFAULT 'medium',
        "complexity" varchar DEFAULT 'medium',
        "criticality" varchar,
        "blast_radius" jsonb,
        "change_restriction" varchar DEFAULT 'free',
        "required_approvers" jsonb,
        "maintenance_window" varchar,
        "restriction_reason" text,
        "production_version" varchar,
        "active_environment" varchar,
        "estimated_effort" varchar,
        "progress" integer DEFAULT 0,
        "requirement_ids" jsonb,
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_dums" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dark_factory_dums_number" UNIQUE ("dum_number"),
        CONSTRAINT "FK_dark_factory_dums_project" FOREIGN KEY ("project_id")
          REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dark_factory_dums_parent" FOREIGN KEY ("parent_dum_id")
          REFERENCES "dark_factory_dums"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dums_project" ON "dark_factory_dums" ("project_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dums_tenant" ON "dark_factory_dums" ("tenant_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dums_stage" ON "dark_factory_dums" ("stage")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dums_parent" ON "dark_factory_dums" ("parent_dum_id")
    `);

    // 2. Tabela de entradas do D.U.M (histórico por seção)
    await queryRunner.query(`
      CREATE TABLE "dark_factory_dum_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "dum_id" uuid NOT NULL,
        "section" varchar NOT NULL,
        "entry_type" varchar NOT NULL,
        "content" text NOT NULL,
        "agent_role" varchar NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_dum_entries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_dum_entries_dum" FOREIGN KEY ("dum_id")
          REFERENCES "dark_factory_dums"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dum_entries_dum" ON "dark_factory_dum_entries" ("dum_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dum_entries_section" ON "dark_factory_dum_entries" ("section")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dum_entries_agent" ON "dark_factory_dum_entries" ("agent_role")
    `);

    // 3. Tabela de relações entre D.U.Ms (grafo de dependências)
    await queryRunner.query(`
      CREATE TABLE "dark_factory_dum_relations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "from_dum_id" uuid NOT NULL,
        "to_dum_id" uuid NOT NULL,
        "relation_type" varchar NOT NULL,
        "reason" text,
        "created_by" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_dum_relations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dark_factory_dum_relations" UNIQUE ("from_dum_id", "to_dum_id", "relation_type"),
        CONSTRAINT "FK_dark_factory_dum_relations_from" FOREIGN KEY ("from_dum_id")
          REFERENCES "dark_factory_dums"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dark_factory_dum_relations_to" FOREIGN KEY ("to_dum_id")
          REFERENCES "dark_factory_dums"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dum_relations_from" ON "dark_factory_dum_relations" ("from_dum_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dum_relations_to" ON "dark_factory_dum_relations" ("to_dum_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_dum_relations_type" ON "dark_factory_dum_relations" ("relation_type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_dum_relations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_dum_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_dums"`);
  }
}
