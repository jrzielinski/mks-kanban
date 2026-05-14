import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequirementTagColumn1769200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_requirements"
      ADD COLUMN IF NOT EXISTS "tag" varchar
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_requirements_tag"
      ON "dark_factory_requirements" ("tag")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_dark_factory_requirements_tag"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_requirements" DROP COLUMN IF EXISTS "tag"`,
    );
  }
}
