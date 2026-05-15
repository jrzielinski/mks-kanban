import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDebugStateToFlowExecutions1762707062211 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_executions"
            ADD COLUMN IF NOT EXISTS "debug_state" jsonb NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_executions"
            DROP COLUMN IF EXISTS "debug_state"
        `);
    }

}
