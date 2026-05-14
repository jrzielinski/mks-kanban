import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanWipAndBoardFeatures1774700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE kanban_lists ADD COLUMN IF NOT EXISTS wip_limit INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS board_labels JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS automation_rules JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE kanban_lists DROP COLUMN IF EXISTS wip_limit`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS board_labels`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS automation_rules`);
  }
}
