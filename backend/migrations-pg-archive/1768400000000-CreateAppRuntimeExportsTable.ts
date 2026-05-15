import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAppRuntimeExportsTable1768400000000 implements MigrationInterface {
  name = 'CreateAppRuntimeExportsTable1768400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_runtime_exports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "appId" uuid NOT NULL,
        "tenantId" character varying NOT NULL,
        "target" character varying NOT NULL,
        "mode" character varying NOT NULL,
        "format" character varying NOT NULL,
        "platform" character varying,
        "manifestVersion" character varying NOT NULL,
        "hash" character varying NOT NULL,
        "artifactUrl" character varying,
        "metadata" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_runtime_exports_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_runtime_exports_appId" ON "app_runtime_exports" ("appId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_runtime_exports_tenantId" ON "app_runtime_exports" ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_app_runtime_exports_tenantId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_app_runtime_exports_appId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "app_runtime_exports"`);
  }
}
