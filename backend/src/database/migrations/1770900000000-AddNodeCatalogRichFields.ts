import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeCatalogRichFields1770900000000 implements MigrationInterface {
  name = 'AddNodeCatalogRichFields1770900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "node_catalog"
        ADD COLUMN IF NOT EXISTS "example_config" jsonb,
        ADD COLUMN IF NOT EXISTS "required_fields" jsonb,
        ADD COLUMN IF NOT EXISTS "documentation_path" varchar,
        ADD COLUMN IF NOT EXISTS "auto_discovered_at" timestamp
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "node_catalog"
        DROP COLUMN IF EXISTS "example_config",
        DROP COLUMN IF EXISTS "required_fields",
        DROP COLUMN IF EXISTS "documentation_path",
        DROP COLUMN IF EXISTS "auto_discovered_at"
    `);
  }
}
