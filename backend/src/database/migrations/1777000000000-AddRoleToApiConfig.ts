import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `role` column to api_config.
 *
 * Purpose: distinguish the primary chat model from auxiliary "fast" models
 * used for side tasks (away-summary, agent-summary, suggestion, SessionMemory).
 * Enables the /api-configs/by-role/:role endpoint the agent calls to discover
 * which config to route auxiliary traffic to.
 *
 * Values: 'primary' | 'fast' (nullable — existing rows stay as implicit primary).
 */
export class AddRoleToApiConfig1777000000000 implements MigrationInterface {
  name = 'AddRoleToApiConfig1777000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "api_config"
      ADD COLUMN IF NOT EXISTS "role" varchar(20) NULL
    `);
    // Partial index: most queries filter by role='fast' to resolve the
    // auxiliary config; a partial index keeps cost low since most rows
    // will have role NULL.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_config_role_active"
      ON "api_config" ("role", "isActive")
      WHERE "role" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_api_config_role_active"`);
    await queryRunner.query(`ALTER TABLE "api_config" DROP COLUMN IF EXISTS "role"`);
  }
}
