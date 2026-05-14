// src/database/migrations/1774600000000-AddKanbanActivitiesAndChecklists.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanActivitiesAndChecklists1774600000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    // Activity table for comments + auto-generated events
    await qr.query(`
      CREATE TABLE IF NOT EXISTS kanban_card_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        card_id VARCHAR NOT NULL,
        board_id VARCHAR NOT NULL,
        tenant_id VARCHAR NOT NULL,
        user_id VARCHAR,
        user_name VARCHAR,
        type VARCHAR NOT NULL DEFAULT 'comment',
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_kca_card_id ON kanban_card_activities (card_id)`);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_kca_tenant_id ON kanban_card_activities (tenant_id)`);

    // Multiple checklists column (replaces flat checklist array)
    await qr.query(`
      ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS checklists JSONB NOT NULL DEFAULT '[]'::jsonb
    `);

    // Migrate existing flat checklist items → checklists format (single group)
    await qr.query(`
      UPDATE kanban_cards
      SET checklists = jsonb_build_array(
        jsonb_build_object(
          'id', 'cl_default',
          'title', 'Checklist',
          'items', checklist
        )
      )
      WHERE jsonb_array_length(checklist) > 0
        AND jsonb_array_length(checklists) = 0
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS kanban_card_activities`);
    await qr.query(`ALTER TABLE kanban_cards DROP COLUMN IF EXISTS checklists`);
  }
}
