import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectManager1770500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "manager_id" int,
      ADD COLUMN IF NOT EXISTS "manager_name" varchar
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "manager_id"`);
    await queryRunner.query(`ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "manager_name"`);
  }
}
