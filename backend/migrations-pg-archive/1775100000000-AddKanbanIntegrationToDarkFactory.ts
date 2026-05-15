import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanIntegrationToDarkFactory1775100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE dark_factory_projects
        ADD COLUMN IF NOT EXISTS kanban_board_id VARCHAR
    `);
    await queryRunner.query(`
      ALTER TABLE dark_factory_kanban_tasks
        ADD COLUMN IF NOT EXISTS kanban_card_id VARCHAR
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_df_projects_kanban_board
        ON dark_factory_projects (kanban_board_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_df_tasks_kanban_card
        ON dark_factory_kanban_tasks (kanban_card_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE dark_factory_projects DROP COLUMN IF EXISTS kanban_board_id`);
    await queryRunner.query(`ALTER TABLE dark_factory_kanban_tasks DROP COLUMN IF EXISTS kanban_card_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_df_projects_kanban_board`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_df_tasks_kanban_card`);
  }
}
