import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectReposAndBoilerplate1776500000000 implements MigrationInterface {
  name = 'AddProjectReposAndBoilerplate1776500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      ADD COLUMN IF NOT EXISTS "repos" jsonb,
      ADD COLUMN IF NOT EXISTS "boilerplate_id" varchar
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_projects"
      DROP COLUMN IF EXISTS "repos",
      DROP COLUMN IF EXISTS "boilerplate_id"
    `);
  }
}
