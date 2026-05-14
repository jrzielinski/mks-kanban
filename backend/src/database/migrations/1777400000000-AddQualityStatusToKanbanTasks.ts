import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quality Gate state on dark_factory_kanban_tasks.
 *
 * Adds:
 *   - quality_status: lifecycle state machine for the gate's verdict
 *       passed                — gate clean, may advance to designer/executor
 *       held                  — gate failed BLOCKER/MAJOR after retries; awaiting human review
 *       rewriting             — auto-retry in progress (CLI-rewrite or escalation to opus)
 *       passed_override       — held but human force-passed it (audit-logged)
 *       archived              — split/replaced — kept for traceability
 *   - quality_issues: jsonb array of Issue from the last gate run
 *   - quality_attempts: jsonb array of {timestamp, attempt, cli, costUsd, issuesBefore, issuesAfter} — full retry history
 *   - quality_force_pass_meta: { userId, timestamp, justification, ignoredIssues } when status = passed_override
 *   - quality_locked_until: timestamp; while non-null and in future, blocks concurrent reanalyze (409 Conflict guard)
 *   - quality_locked_by: user/agent that owns the current rewrite session
 *
 * Indexes:
 *   - btree on quality_status for cheap "list held" queries
 *   - partial btree on (project_id, quality_status) WHERE quality_status='held' for the Quality Hold tab
 */
export class AddQualityStatusToKanbanTasks1777400000000 implements MigrationInterface {
  name = 'AddQualityStatusToKanbanTasks1777400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" ADD COLUMN IF NOT EXISTS "quality_status" varchar NOT NULL DEFAULT 'unchecked'`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" ADD COLUMN IF NOT EXISTS "quality_issues" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" ADD COLUMN IF NOT EXISTS "quality_attempts" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" ADD COLUMN IF NOT EXISTS "quality_force_pass_meta" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" ADD COLUMN IF NOT EXISTS "quality_locked_until" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" ADD COLUMN IF NOT EXISTS "quality_locked_by" varchar`,
    );

    // CHECK constraint to keep the state machine honest at the DB level.
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks"
       ADD CONSTRAINT "CHK_kanban_tasks_quality_status"
       CHECK ("quality_status" IN ('unchecked','passed','held','rewriting','passed_override','archived'))`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_kanban_tasks_quality_status"
       ON "dark_factory_kanban_tasks" ("quality_status")`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_kanban_tasks_held"
       ON "dark_factory_kanban_tasks" ("project_id", "quality_status")
       WHERE "quality_status" = 'held'`,
    );

    // Aggregate column on the project — fast "any held tasks?" check used by the
    // pipeline gate that blocks advance to designer/executor.
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" ADD COLUMN IF NOT EXISTS "quality_hold_count" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_kanban_tasks_held"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_kanban_tasks_quality_status"`);
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP CONSTRAINT IF EXISTS "CHK_kanban_tasks_quality_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "quality_locked_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "quality_locked_until"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "quality_force_pass_meta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "quality_attempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "quality_issues"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_kanban_tasks" DROP COLUMN IF EXISTS "quality_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dark_factory_projects" DROP COLUMN IF EXISTS "quality_hold_count"`,
    );
  }
}
