import { MigrationInterface, QueryRunner } from "typeorm";

export class FixBase64AttachmentsFormat1758926000000 implements MigrationInterface {
    name = 'FixBase64AttachmentsFormat1758926000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Fix any existing attachments that might have double data: prefix
        await queryRunner.query(`
            UPDATE message
            SET attachments = (
                SELECT jsonb_agg(
                    CASE
                        WHEN elem->>'base64Data' LIKE 'data:data:%' THEN
                            jsonb_set(elem, '{base64Data}', to_jsonb(substring(elem->>'base64Data' FROM 6)))
                        ELSE elem
                    END
                )
                FROM jsonb_array_elements(attachments) AS elem
            )
            WHERE attachments IS NOT NULL
            AND jsonb_typeof(attachments) = 'array'
            AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(attachments) AS elem
                WHERE elem->>'base64Data' LIKE 'data:data:%'
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // No need to revert this fix
    }
}