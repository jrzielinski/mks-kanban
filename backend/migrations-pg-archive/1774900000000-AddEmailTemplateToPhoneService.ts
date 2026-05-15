import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmailTemplateToPhoneService1774900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "phone_services"
        ADD COLUMN IF NOT EXISTS "emailTemplateSubject" text,
        ADD COLUMN IF NOT EXISTS "emailTemplateHtml" text,
        ADD COLUMN IF NOT EXISTS "emailTemplateVariables" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "phone_services"
        DROP COLUMN IF EXISTS "emailTemplateSubject",
        DROP COLUMN IF EXISTS "emailTemplateHtml",
        DROP COLUMN IF EXISTS "emailTemplateVariables"
    `);
  }
}
