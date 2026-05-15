import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 0 — Decomposition telemetry baseline.
 *
 * Creates `dark_factory_telemetry_events` to receive JSONL events emitted
 * by the local agent's `per-requirement-loop`. Append-only; queried by
 * dashboards and the `makestudio telemetry` command's aggregated view.
 *
 * Two composite indexes cover the typical access patterns:
 *   - (tenant_id, project_id, event_ts) for project-scoped time queries
 *   - (tenant_id, cli, event_ts) for "how slow is gemini vs claude?"
 */
export class AddTelemetryEvents1777600000000 implements MigrationInterface {
  name = 'AddTelemetryEvents1777600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_telemetry_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" varchar NOT NULL,
        "run_id" varchar NOT NULL,
        "project_id" varchar NOT NULL,
        "event_type" varchar NOT NULL,
        "cli" varchar NOT NULL,
        "event_ts" timestamp with time zone NOT NULL,
        "req_id" varchar,
        "temp_id" varchar,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_telemetry_tenant_project_ts"
      ON "dark_factory_telemetry_events" ("tenant_id", "project_id", "event_ts")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_telemetry_tenant_cli_ts"
      ON "dark_factory_telemetry_events" ("tenant_id", "cli", "event_ts")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_tenant_cli_ts"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_tenant_project_ts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_telemetry_events"`);
  }
}
