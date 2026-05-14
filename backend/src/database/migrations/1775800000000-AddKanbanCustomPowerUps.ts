// src/database/migrations/1775800000000-AddKanbanCustomPowerUps.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanCustomPowerUps1775800000000 implements MigrationInterface {
  name = 'AddKanbanCustomPowerUps1775800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. New templates table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_power_up_templates (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       VARCHAR NOT NULL,
        board_id        VARCHAR NOT NULL,
        created_by      VARCHAR NOT NULL,
        name            VARCHAR NOT NULL,
        icon            VARCHAR NOT NULL DEFAULT '⚡',
        description     TEXT,
        mode            VARCHAR NOT NULL,
        trigger_events  JSONB NOT NULL DEFAULT '[]',
        url             TEXT,
        headers_template JSONB,
        payload_template JSONB,
        config_schema   JSONB NOT NULL DEFAULT '[]',
        script          TEXT,
        response_mapping JSONB,
        status          VARCHAR NOT NULL DEFAULT 'draft',
        rejection_reason TEXT,
        created_at      TIMESTAMP NOT NULL DEFAULT now(),
        updated_at      TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kput_tenant ON kanban_power_up_templates(tenant_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kput_board  ON kanban_power_up_templates(board_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kput_status ON kanban_power_up_templates(status)`);

    // 2. Extend existing kanban_power_ups table
    await queryRunner.query(`
      ALTER TABLE kanban_power_ups
        ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES kanban_power_up_templates(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE kanban_power_ups
        ALTER COLUMN type DROP NOT NULL
    `);

    // 3. Execution logs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kanban_power_up_execution_logs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        installation_id UUID NOT NULL REFERENCES kanban_power_ups(id) ON DELETE CASCADE,
        board_id        VARCHAR NOT NULL,
        tenant_id       VARCHAR NOT NULL,
        event_type      VARCHAR NOT NULL,
        status_code     INT,
        error           TEXT,
        response_snippet TEXT,
        executed_at     TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_kpel_installation ON kanban_power_up_execution_logs(installation_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_power_up_execution_logs`);
    await queryRunner.query(`ALTER TABLE kanban_power_ups DROP COLUMN IF EXISTS template_id`);
    await queryRunner.query(`ALTER TABLE kanban_power_ups ALTER COLUMN type SET NOT NULL`);
    await queryRunner.query(`DROP TABLE IF EXISTS kanban_power_up_templates`);
  }
}
