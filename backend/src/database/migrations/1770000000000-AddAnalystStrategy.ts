import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnalystStrategy1770000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "analyst_strategy" varchar DEFAULT 'llm-api'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "analyst_strategy"`,
    );
  }
}
