import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanCardBlockedBy1776000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kanban_cards"
      ADD COLUMN IF NOT EXISTS "blocked_by" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "blocked_by"
    `);
  }
}
