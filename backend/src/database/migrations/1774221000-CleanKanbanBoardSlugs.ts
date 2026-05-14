import { MigrationInterface, QueryRunner } from 'typeorm';

export class CleanKanbanBoardSlugs1774221000000 implements MigrationInterface {
  name = 'CleanKanbanBoardSlugs1774221000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rebuild slugs as clean title-only slugs (no short-id suffix)
    // Handle duplicates by appending -2, -3, etc. per tenant
    await queryRunner.query(`
      WITH slugs AS (
        SELECT
          id,
          tenant_id,
          REGEXP_REPLACE(
            LOWER(
              TRANSLATE(title,
                'àáâãäåæçèéêëìíîïðñòóôõöùúûüýþÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞ',
                'aaaaaaaceeeeiiiidnoooooouuuuytAAAAAAAACEEEEIIIIDNOOOOOUUUUYT'
              )
            ),
            '[^a-z0-9]+', '-', 'g'
          ) AS base_slug
        FROM kanban_boards
      ),
      ranked AS (
        SELECT
          id,
          base_slug,
          ROW_NUMBER() OVER (PARTITION BY tenant_id, base_slug ORDER BY id ASC) AS rn
        FROM slugs
      )
      UPDATE kanban_boards kb
      SET slug = CASE WHEN r.rn = 1 THEN r.base_slug ELSE r.base_slug || '-' || r.rn END
      FROM ranked r
      WHERE kb.id = r.id
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no revert needed
  }
}
