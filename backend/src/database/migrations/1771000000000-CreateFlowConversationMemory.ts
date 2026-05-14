import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFlowConversationMemory1771000000000 implements MigrationInterface {
  name = 'CreateFlowConversationMemory1771000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flow_conversation_memory" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" character varying NOT NULL,
        "tenant_id" character varying NOT NULL,
        "user_id" character varying,
        "messages" jsonb NOT NULL DEFAULT '[]',
        "window_size" integer NOT NULL DEFAULT 10,
        "expires_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flow_conversation_memory" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_flow_conv_mem_session_id"
      ON "flow_conversation_memory" ("session_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_flow_conv_mem_tenant_id"
      ON "flow_conversation_memory" ("tenant_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "flow_conversation_memory"`);
  }
}
