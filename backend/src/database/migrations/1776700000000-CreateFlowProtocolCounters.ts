import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFlowProtocolCounters1776700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "flow_protocol_counters" (
        "id"         UUID          NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id"  VARCHAR(100)  NOT NULL,
        "prefix"     VARCHAR(50)   NOT NULL,
        "counter"    INTEGER       NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flow_protocol_counters" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_flow_protocol_counters_tenant_prefix" UNIQUE ("tenant_id", "prefix")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_flow_protocol_counters_tenant" ON "flow_protocol_counters" ("tenant_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "flow_protocol_counters"`);
  }
}
