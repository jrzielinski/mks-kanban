import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `agent_role` column to `kanban_lists` so each column can declare
 * which role the MakeStudio Bot plays when picking up cards from it:
 *
 *   implement | test | qa | review | deploy | NULL
 *
 * NULL means "no agent action — human-only column". The agent drain
 * reads this column to decide which prompt template to apply and only
 * touches cards in lists where the role is non-NULL.
 *
 * Free-form varchar instead of a Postgres enum: roles are conceptual
 * and we'll iterate on them. An enum would force a migration every time
 * we add a new role, which is overhead the column doesn't need.
 *
 * In the SQLite path (Electron embed), TypeORM synchronize handles the
 * schema delta automatically — this migration is the Postgres twin so
 * both drivers converge to the same column shape.
 */
export class AddKanbanListAgentRole1778000000000 implements MigrationInterface {
  name = 'AddKanbanListAgentRole1778000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "kanban_lists" ADD COLUMN IF NOT EXISTS "agent_role" varchar NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "kanban_lists" DROP COLUMN IF EXISTS "agent_role"`,
    );
  }
}
