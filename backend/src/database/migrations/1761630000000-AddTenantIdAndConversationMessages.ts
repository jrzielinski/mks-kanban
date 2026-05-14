import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTenantIdAndConversationMessages1761630000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add tenantId column to agent_handoff_queue
    await queryRunner.query(`
      ALTER TABLE agent_handoff_queue ADD COLUMN IF NOT EXISTS "tenantId" VARCHAR;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_handoff_tenantId_status"
      ON agent_handoff_queue ("tenantId", "status");
    `);

    // 2. Create sender enum type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE agent_conversation_sender_enum AS ENUM ('user', 'agent', 'system');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // 3. Create agent_conversation_messages table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_conversation_messages (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "handoffId" uuid NOT NULL,
        "sender" agent_conversation_sender_enum NOT NULL,
        "message" text NOT NULL,
        "media" jsonb,
        "timestamp" TIMESTAMP NOT NULL DEFAULT now(),
        "read" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_agent_conversation_messages" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_conv_msg_handoff_timestamp"
      ON agent_conversation_messages ("handoffId", "timestamp");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS agent_conversation_messages`);
    await queryRunner.query(`DROP TYPE IF EXISTS agent_conversation_sender_enum`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_handoff_tenantId_status"`);
    await queryRunner.query(`ALTER TABLE agent_handoff_queue DROP COLUMN IF EXISTS "tenantId"`);
  }
}
