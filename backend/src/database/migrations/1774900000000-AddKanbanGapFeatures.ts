import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanGapFeatures1774900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // #34 Workspaces table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_workspaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR NOT NULL,
        color VARCHAR NOT NULL DEFAULT '#6366f1',
        tenant_id VARCHAR NOT NULL,
        owner_id VARCHAR,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kanban_workspaces_tenant ON kanban_workspaces(tenant_id)`);

    // #34 workspace_id on boards
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS workspace_id VARCHAR`);

    // #35 visibility
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS visibility VARCHAR NOT NULL DEFAULT 'private'`);

    // #36 invite token
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS invite_token VARCHAR`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kanban_board_invite_token ON kanban_boards(invite_token) WHERE invite_token IS NOT NULL`);

    // #39 is_template
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false`);

    // #37 watched_by on boards and cards
    await queryRunner.query(`ALTER TABLE kanban_boards ADD COLUMN IF NOT EXISTS watched_by JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS watched_by JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // #43 location on cards
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS location JSONB`);

    // #38 last_due_notified_at on cards
    await queryRunner.query(`ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS last_due_notified_at TIMESTAMPTZ`);

    // #40 Board stars table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_board_stars (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        tenant_id VARCHAR NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE(board_id, user_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kanban_stars_user ON kanban_board_stars(user_id, tenant_id)`);

    // #44 Power-ups table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_power_ups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id VARCHAR NOT NULL,
        tenant_id VARCHAR NOT NULL,
        type VARCHAR NOT NULL,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kanban_powerups_board ON kanban_power_ups(board_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_power_ups`);
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_board_stars`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS last_due_notified_at`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS location`);
    await queryRunner.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS watched_by`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS watched_by`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS is_template`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_kanban_board_invite_token`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS invite_token`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS visibility`);
    await queryRunner.query(`ALTER TABLE kanban_boards DROP COLUMN IF EXISTS workspace_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_workspaces`);
  }
}
