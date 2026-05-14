import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase C — per-requirement decomposition tracking.
 *
 * Adds `decomposed_at` to `dark_factory_requirements`. The per-requirement
 * agentic loop sets this when a DUM is successfully saved + gated for the
 * requirement. The next loop run filters out requirements where
 * decomposed_at IS NOT NULL — so a crashed or cancelled run resumes
 * where it stopped instead of re-decomposing already-done requirements.
 *
 * Indexed because the loop's first action is "give me requirements WHERE
 * decomposed_at IS NULL" — at scale (1000-DUM projects) this needs to be
 * fast.
 */
export class AddDecomposedAtToRequirements1777500000000 implements MigrationInterface {
  name = 'AddDecomposedAtToRequirements1777500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dark_factory_requirements" ADD COLUMN IF NOT EXISTS "decomposed_at" timestamp`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_requirements_decomposed_at"
       ON "dark_factory_requirements" ("project_id", "decomposed_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_requirements_decomposed_at"`);
    await queryRunner.query(
      `ALTER TABLE "dark_factory_requirements" DROP COLUMN IF EXISTS "decomposed_at"`,
    );
  }
}
