import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveFlowExecutionsWhatsappFlowsFK1762698760603 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Remove foreign key constraint from flow_executions.flow_id -> whatsapp_flows.id
        // This allows flow_executions to store flows from both whatsapp_flows and flow_definitions
        await queryRunner.query(`
            ALTER TABLE "flow_executions"
            DROP CONSTRAINT IF EXISTS "FK_c88b525120ae8a8c7a3c6c93858"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restore foreign key constraint (only if all flow_id values reference existing whatsapp_flows)
        // Note: This may fail if there are flow_executions referencing flow_definitions
        await queryRunner.query(`
            ALTER TABLE "flow_executions"
            ADD CONSTRAINT "FK_c88b525120ae8a8c7a3c6c93858"
            FOREIGN KEY ("flow_id") REFERENCES "whatsapp_flows"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

}
