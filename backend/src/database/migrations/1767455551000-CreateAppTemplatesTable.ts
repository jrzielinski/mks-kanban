import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppTemplatesTable1767455551000 implements MigrationInterface {
  name = 'CreateAppTemplatesTable1767455551000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "app_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "components" jsonb NOT NULL DEFAULT '[]',
        "layout" jsonb,
        "theme" jsonb,
        "dataSources" jsonb NOT NULL DEFAULT '[]',
        "variables" jsonb NOT NULL DEFAULT '[]',
        "isActive" boolean NOT NULL DEFAULT true,
        "isPublic" boolean NOT NULL DEFAULT false,
        "thumbnailUrl" character varying,
        "tenantId" character varying NOT NULL,
        "ownerId" character varying,
        "folderId" character varying,
        "permissions" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "publishedAt" TIMESTAMP,
        "version" integer,
        CONSTRAINT "PK_app_templates" PRIMARY KEY ("id")
      )
    `);

    // Criar índices
    await queryRunner.query(`
      CREATE INDEX "IDX_app_templates_name" ON "app_templates" ("name")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_app_templates_tenantId" ON "app_templates" ("tenantId")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_app_templates_name_tenant" ON "app_templates" ("name", "tenantId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_app_templates_folderId" ON "app_templates" ("folderId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_app_templates_isActive" ON "app_templates" ("isActive")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_app_templates_isPublic" ON "app_templates" ("isPublic")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_app_templates_isPublic"`);
    await queryRunner.query(`DROP INDEX "IDX_app_templates_isActive"`);
    await queryRunner.query(`DROP INDEX "IDX_app_templates_folderId"`);
    await queryRunner.query(`DROP INDEX "IDX_app_templates_name_tenant"`);
    await queryRunner.query(`DROP INDEX "IDX_app_templates_tenantId"`);
    await queryRunner.query(`DROP INDEX "IDX_app_templates_name"`);
    await queryRunner.query(`DROP TABLE "app_templates"`);
  }
}
