import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAttachmentsBase64ToMessage1758921542927 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add attachments column to store base64 data directly in database
        await queryRunner.query(`
            ALTER TABLE "message"
            ADD COLUMN "attachments" jsonb NULL
        `);

        // Add comment explaining the structure
        await queryRunner.query(`
            COMMENT ON COLUMN "message"."attachments" IS 'Array of attachment objects with id, filename, mimetype, base64Data, and size'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "message"
            DROP COLUMN "attachments"
        `);
    }

}
