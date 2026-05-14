import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKanbanMembersAndAttachments1771200000000 implements MigrationInterface {
  name = 'AddKanbanMembersAndAttachments1771200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add members to kanban_boards
    await queryRunner.query(`
      ALTER TABLE "kanban_boards"
      ADD COLUMN IF NOT EXISTS "members" jsonb NOT NULL DEFAULT '[]'
    `);

    // Add attachments, member_ids, cover_image_url, cover_attachment_id to kanban_cards
    await queryRunner.query(`
      ALTER TABLE "kanban_cards"
      ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'
    `);
    await queryRunner.query(`
      ALTER TABLE "kanban_cards"
      ADD COLUMN IF NOT EXISTS "member_ids" jsonb NOT NULL DEFAULT '[]'
    `);
    await queryRunner.query(`
      ALTER TABLE "kanban_cards"
      ADD COLUMN IF NOT EXISTS "cover_image_url" text
    `);
    await queryRunner.query(`
      ALTER TABLE "kanban_cards"
      ADD COLUMN IF NOT EXISTS "cover_attachment_id" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "cover_attachment_id"`);
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "cover_image_url"`);
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "member_ids"`);
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "attachments"`);
    await queryRunner.query(`ALTER TABLE "kanban_boards" DROP COLUMN IF EXISTS "members"`);
  }
}
