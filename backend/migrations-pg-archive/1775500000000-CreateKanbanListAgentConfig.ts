import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKanbanListAgentConfig1775500000000 implements MigrationInterface {
  name = 'CreateKanbanListAgentConfig1775500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_list_agent_config" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "list_id" VARCHAR NOT NULL UNIQUE,
        "board_id" VARCHAR NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT false,
        "default_exec_type" VARCHAR,
        "default_repo_id" UUID,
        "default_branch" VARCHAR,
        "prompt_prefix" TEXT,
        "move_on_complete_list_id" VARCHAR,
        "move_on_fail_list_id" VARCHAR,
        "tenant_id" VARCHAR NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_list_agent_config_list_id" ON "kanban_list_agent_config"("list_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_list_agent_config_tenant_id" ON "kanban_list_agent_config"("tenant_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_list_agent_config"`);
  }
}
