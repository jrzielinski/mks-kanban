import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectClassificationColumns1769700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "automation_level" varchar NOT NULL DEFAULT 'pending'
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "complexity_score" int
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "complexity_reasoning" text
    `);

    // Also add missing columns on decisions table
    await queryRunner.query(`
      ALTER TABLE "dark_factory_decisions"
      ADD COLUMN IF NOT EXISTS "category" varchar
    `);

    await queryRunner.query(`
      ALTER TABLE "dark_factory_decisions"
      ADD COLUMN IF NOT EXISTS "attachments" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_decisions" DROP COLUMN IF EXISTS "attachments"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_decisions" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "complexity_reasoning"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "complexity_score"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "automation_level"`,
    );
  }
}
