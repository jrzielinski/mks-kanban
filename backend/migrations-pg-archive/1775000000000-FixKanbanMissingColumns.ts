import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixKanbanMissingColumns1775000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Board: missing columns
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS background_image VARCHAR`);
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS custom_field_defs JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Card: missing columns (should have been added by AddKanbanAdvancedFeatures)
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS stickers JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS recurrence JSONB`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS background_image`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS custom_field_defs`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS stickers`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS custom_fields`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS recurrence`);
  }
}
