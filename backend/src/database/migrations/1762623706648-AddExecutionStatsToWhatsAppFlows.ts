import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExecutionStatsToWhatsAppFlows1762623706648 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add execution statistics columns to whatsapp_flows table
        await queryRunner.query(`
            ALTER TABLE "whatsapp_flows"
            ADD COLUMN IF NOT EXISTS "execution_count" INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "success_count" INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "failure_count" INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "last_executed_at" TIMESTAMP
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Remove execution statistics columns
        await queryRunner.query(`
            ALTER TABLE "whatsapp_flows"
            DROP COLUMN IF EXISTS "last_executed_at",
            DROP COLUMN IF EXISTS "failure_count",
            DROP COLUMN IF EXISTS "success_count",
            DROP COLUMN IF EXISTS "execution_count"
        `);
    }

}
