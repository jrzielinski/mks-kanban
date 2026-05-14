import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanCardHistoryAndLinks1775700000000 implements MigrationInterface {
  name = 'AddKanbanCardHistoryAndLinks1775700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // C2: Card movement history table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_card_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        card_id VARCHAR NOT NULL,
        board_id VARCHAR NOT NULL,
        tenant_id VARCHAR NOT NULL,
        from_list_id VARCHAR,
        from_list_title VARCHAR,
        to_list_id VARCHAR NOT NULL,
        to_list_title VARCHAR NOT NULL,
        moved_by VARCHAR,
        moved_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kch_card_id ON kanban_card_history(card_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kch_tenant_id ON kanban_card_history(tenant_id)`);

    // C3: Card links (linked_card_ids JSONB column)
    await queryRunner.query(`
      ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS linked_card_ids JSONB NOT NULL DEFAULT '[]'
    `);

    // C5: Board granular permissions
    await queryRunner.query(`
      ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS permissions`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS linked_card_ids`);
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_card_history`);
  }
}
