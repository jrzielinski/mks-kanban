import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanTimeLogs1775200000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS kanban_time_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        card_id VARCHAR NOT NULL,
        board_id VARCHAR NOT NULL,
        tenant_id VARCHAR NOT NULL,
        user_id VARCHAR,
        user_name VARCHAR,
        hours FLOAT NOT NULL,
        description TEXT,
        logged_date DATE NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_kanban_time_logs_card_id ON kanban_time_logs(card_id)`);
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_kanban_time_logs_tenant_id ON kanban_time_logs(tenant_id)`);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS kanban_time_logs`);
  }
}
