import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppTemplatePermissionsAndRefreshHistory1774800000000
  implements MigrationInterface
{
  name = 'AddAppTemplatePermissionsAndRefreshHistory1774800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_templates"
      ADD COLUMN IF NOT EXISTS "ownerEmail" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "app_templates"
      ADD COLUMN IF NOT EXISTS "workspaceMembers" jsonb NOT NULL DEFAULT '[]'
    `);

    await queryRunner.query(`
      ALTER TABLE "app_templates"
      ADD COLUMN IF NOT EXISTS "refreshHistory" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_templates"
      DROP COLUMN IF EXISTS "refreshHistory"
    `);

    await queryRunner.query(`
      ALTER TABLE "app_templates"
      DROP COLUMN IF EXISTS "workspaceMembers"
    `);

    await queryRunner.query(`
      ALTER TABLE "app_templates"
      DROP COLUMN IF EXISTS "ownerEmail"
    `);
  }
}
