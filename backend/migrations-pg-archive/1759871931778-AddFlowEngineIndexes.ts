import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFlowEngineIndexes1759871931778 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Índices para flow_definitions
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_flow_definitions_tenant_user"
            ON "flow_definitions" ("tenant_id", "created_by_id", "updated_at" DESC)
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_flow_definitions_status"
            ON "flow_definitions" ("status")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_flow_definitions_category"
            ON "flow_definitions" ("category")
        `);

        // Índices para flow_instances
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_flow_instances_flow_created"
            ON "flow_instances" ("flow_definition_id", "created_at" DESC)
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_flow_instances_status"
            ON "flow_instances" ("status")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_flow_instances_tenant"
            ON "flow_instances" ("tenant_id", "created_at" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_flow_definitions_tenant_user"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_flow_definitions_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_flow_definitions_category"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_flow_instances_flow_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_flow_instances_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_flow_instances_tenant"`);
    }

}
