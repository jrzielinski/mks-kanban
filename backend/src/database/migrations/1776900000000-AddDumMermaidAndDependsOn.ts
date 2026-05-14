import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDumMermaidAndDependsOn1776900000000 implements MigrationInterface {
  name = 'AddDumMermaidAndDependsOn1776900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // mermaid_diagram: stores the raw Mermaid code for the DUM (text, nullable)
    await queryRunner.query(`
      ALTER TABLE "dark_factory_dums"
      ADD COLUMN IF NOT EXISTS "mermaid_diagram" text NULL
    `);

    // depends_on: stores DUM numbers this DUM depends on (e.g. ["DUM-002", "DUM-005"])
    await queryRunner.query(`
      ALTER TABLE "dark_factory_dums"
      ADD COLUMN IF NOT EXISTS "depends_on" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dark_factory_dums"
      DROP COLUMN IF EXISTS "depends_on"
    `);
    await queryRunner.query(`
      ALTER TABLE "dark_factory_dums"
      DROP COLUMN IF EXISTS "mermaid_diagram"
    `);
  }
}
