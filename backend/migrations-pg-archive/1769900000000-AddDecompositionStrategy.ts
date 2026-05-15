import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDecompositionStrategy1769900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "decomposition_strategy" varchar DEFAULT 'llm-api'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "decomposition_strategy"`,
    );
  }
}
