import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanAdvancedFeatures1774800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Card: start date
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ`);

    // Card: votes (array of user IDs)
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS votes JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Card: stickers (array of emoji strings)
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS stickers JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Board: background color + background image + custom field defs
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS background_color VARCHAR`);
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS background_image VARCHAR`);
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS custom_field_defs JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Card: custom fields values
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb`);

    // Card: recurrence
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS recurrence JSONB`);

    // Notifications table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        board_id VARCHAR,
        card_id VARCHAR,
        card_title VARCHAR,
        type VARCHAR NOT NULL,
        text TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kanban_notif_user ON kanban_notifications(user_id, tenant_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kanban_notif_tenant ON kanban_notifications(tenant_id)`);

    // Activity: allow text updates (add updated_at if missing)
    await queryRunner.query(`ALTER TABLE kanban_card_activities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS start_date`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS votes`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS stickers`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS background_color`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS background_image`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS custom_field_defs`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS custom_fields`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS recurrence`);
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_notifications`);
    await queryRunner.query(`ALTER TABLE kanban_card_activities DROP COLUMN IF EXISTS updated_at`);
  }
}
