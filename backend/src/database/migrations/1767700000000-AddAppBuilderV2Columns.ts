import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppBuilderV2Columns1767700000000 implements MigrationInterface {
  name = 'AddAppBuilderV2Columns1767700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Adicionar colunas V2 na tabela app_templates
    await queryRunner.query(`
      ALTER TABLE "app_templates"
      ADD COLUMN IF NOT EXISTS "pages" jsonb DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "navigation" jsonb,
      ADD COLUMN IF NOT EXISTS "themeV2" jsonb,
      ADD COLUMN IF NOT EXISTS "dataSourcesV2" jsonb DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_templates"
      DROP COLUMN IF EXISTS "pages",
      DROP COLUMN IF EXISTS "navigation",
      DROP COLUMN IF EXISTS "themeV2",
      DROP COLUMN IF EXISTS "dataSourcesV2"
    `);
  }
}
