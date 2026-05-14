import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMetadataToDarkFactoryProjects1770200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "metadata"`,
    );
  }
}
