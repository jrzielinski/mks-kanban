import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKanbanAgentExecutions1775600000000 implements MigrationInterface {
  name = 'CreateKanbanAgentExecutions1775600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_agent_executions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "card_id" VARCHAR NOT NULL,
        "board_id" VARCHAR NOT NULL,
        "list_id" VARCHAR NOT NULL,
        "exec_type" VARCHAR NOT NULL,
        "prompt" TEXT NOT NULL,
        "repo_url" VARCHAR,
        "branch_created" VARCHAR,
        "git_commits" INTEGER,
        "git_pushed" BOOLEAN NOT NULL DEFAULT false,
        "status" VARCHAR NOT NULL DEFAULT 'pending',
        "result" TEXT,
        "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
        "agent_socket_id" VARCHAR,
        "agent_machine" VARCHAR,
        "started_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "tenant_id" VARCHAR NOT NULL,
        "user_id" VARCHAR
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_agent_executions_card_id" ON "kanban_agent_executions"("card_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_agent_executions_tenant_id" ON "kanban_agent_executions"("tenant_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_agent_executions_status" ON "kanban_agent_executions"("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_agent_executions"`);
  }
}
