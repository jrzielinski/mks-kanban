import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDarkFactoryTables1769000000000
  implements MigrationInterface
{
  name = 'CreateDarkFactoryTables1769000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. dark_factory_projects
    await queryRunner.query(`
      CREATE TABLE "dark_factory_projects" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" varchar NOT NULL,
        "description" text,
        "client_contact" jsonb,
        "status" varchar NOT NULL DEFAULT 'intake',
        "repo_url" varchar,
        "repo_branch" varchar,
        "stack" jsonb,
        "spec_document" jsonb,
        "total_tasks" int NOT NULL DEFAULT 0,
        "completed_tasks" int NOT NULL DEFAULT 0,
        "total_cost_usd" float NOT NULL DEFAULT 0,
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_projects" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_projects_tenant" ON "dark_factory_projects" ("tenant_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_projects_status" ON "dark_factory_projects" ("status")
    `);

    // 2. dark_factory_tasks
    await queryRunner.query(`
      CREATE TABLE "dark_factory_tasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" varchar NOT NULL,
        "description" text,
        "acceptance_criteria" jsonb,
        "type" varchar NOT NULL DEFAULT 'feature',
        "agent_role" varchar,
        "status" varchar NOT NULL DEFAULT 'pending',
        "branch_name" varchar,
        "pr_url" varchar,
        "pr_number" int,
        "artifacts" jsonb,
        "test_results" jsonb,
        "cost_usd" float NOT NULL DEFAULT 0,
        "tokens_used" int NOT NULL DEFAULT 0,
        "priority" int NOT NULL DEFAULT 0,
        "parent_task_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_tasks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_tasks_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dark_factory_tasks_parent" FOREIGN KEY ("parent_task_id") REFERENCES "dark_factory_tasks"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_tasks_project" ON "dark_factory_tasks" ("project_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_tasks_status" ON "dark_factory_tasks" ("status")
    `);

    // 3. dark_factory_artifacts
    await queryRunner.query(`
      CREATE TABLE "dark_factory_artifacts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "task_id" uuid,
        "type" varchar NOT NULL DEFAULT 'code',
        "file_path" varchar,
        "content" text,
        "version" int NOT NULL DEFAULT 1,
        "commit_hash" varchar,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_artifacts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_artifacts_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dark_factory_artifacts_task" FOREIGN KEY ("task_id") REFERENCES "dark_factory_tasks"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_artifacts_project" ON "dark_factory_artifacts" ("project_id")
    `);

    // 4. dark_factory_conversations
    await queryRunner.query(`
      CREATE TABLE "dark_factory_conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid,
        "channel" varchar NOT NULL DEFAULT 'web',
        "client_identifier" varchar NOT NULL,
        "agent_role" varchar,
        "phase" varchar NOT NULL DEFAULT 'intake',
        "status" varchar NOT NULL DEFAULT 'active',
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_conversations_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_conversations_tenant" ON "dark_factory_conversations" ("tenant_id")
    `);

    // 5. dark_factory_conversation_messages
    await queryRunner.query(`
      CREATE TABLE "dark_factory_conversation_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "role" varchar NOT NULL DEFAULT 'agent',
        "content" text NOT NULL,
        "content_type" varchar NOT NULL DEFAULT 'text',
        "approval_data" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_conversation_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_conv_messages_conv" FOREIGN KEY ("conversation_id") REFERENCES "dark_factory_conversations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_conv_messages_conv" ON "dark_factory_conversation_messages" ("conversation_id")
    `);

    // 6. dark_factory_agent_logs
    await queryRunner.query(`
      CREATE TABLE "dark_factory_agent_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid,
        "task_id" uuid,
        "agent_role" varchar NOT NULL,
        "operation" varchar NOT NULL,
        "input_prompt" text,
        "output_result" text,
        "status" varchar NOT NULL DEFAULT 'running',
        "duration_ms" int,
        "tokens_input" int NOT NULL DEFAULT 0,
        "tokens_output" int NOT NULL DEFAULT 0,
        "cost_usd" float NOT NULL DEFAULT 0,
        "model_used" varchar,
        "tools_used" jsonb,
        "files_modified" jsonb,
        "tenant_id" varchar,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_agent_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_agent_logs_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_dark_factory_agent_logs_task" FOREIGN KEY ("task_id") REFERENCES "dark_factory_tasks"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_agent_logs_project" ON "dark_factory_agent_logs" ("project_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_dark_factory_agent_logs_status" ON "dark_factory_agent_logs" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_agent_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_conversation_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_conversations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_artifacts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_tasks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_projects"`);
  }
}
