import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanBoardSlug1774220000000 implements MigrationInterface {
  name = 'AddKanbanBoardSlug1774220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add slug column
    await queryRunner.query(`ALTER TABLE "kanban_boards" ADD COLUMN IF NOT EXISTS "slug" varchar NULL`);

    // Populate slug for existing boards: slugify(title) + '-' + first 8 chars of id
    await queryRunner.query(`
      UPDATE "kanban_boards"
      SET "slug" = CONCAT(
        REGEXP_REPLACE(
          LOWER(
            TRANSLATE(title,
              'àáâãäåæçèéêëìíîïðñòóôõöùúûüýþÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞ',
              'aaaaaaaceeeeiiiidnoooooouuuuytÿAAAAAAACEEEEIIIIDNOOOOOUUUUYT'
            )
          ),
          '[^a-z0-9]+', '-', 'g'
        ),
        '-',
        SUBSTRING(id::text, 1, 8)
      )
      WHERE "slug" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "kanban_boards" DROP COLUMN IF EXISTS "slug"`);
  }
}
