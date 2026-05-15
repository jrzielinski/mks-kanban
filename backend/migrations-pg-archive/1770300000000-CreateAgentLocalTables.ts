import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAgentLocalTables1770300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Licenses
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_licenses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" varchar NOT NULL,
        "plan" varchar NOT NULL DEFAULT 'free',
        "max_seats" int NOT NULL DEFAULT 1,
        "used_seats" int NOT NULL DEFAULT 0,
        "additional_seats" int NOT NULL DEFAULT 0,
        "max_tasks_per_month" int NOT NULL DEFAULT 20,
        "tasks_used_this_month" int NOT NULL DEFAULT 0,
        "billing_cycle_start" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_licenses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dark_factory_licenses_tenant" UNIQUE ("tenant_id")
      )
    `);

    // 2. Team members
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_team_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" int NOT NULL,
        "project_id" varchar,
        "tenant_id" varchar NOT NULL,
        "role" varchar NOT NULL DEFAULT 'mid',
        "specialties" jsonb DEFAULT '[]',
        "status" varchar NOT NULL DEFAULT 'active',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_team_members" PRIMARY KEY ("id")
      )
    `);

    // 3. Agent connections
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_agent_connections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" int NOT NULL,
        "tenant_id" varchar NOT NULL,
        "agent_id" varchar NOT NULL,
        "hostname" varchar,
        "available_clis" jsonb DEFAULT '[]',
        "repo_path" varchar,
        "connected_at" timestamp,
        "disconnected_at" timestamp,
        "status" varchar NOT NULL DEFAULT 'online',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_agent_connections" PRIMARY KEY ("id")
      )
    `);

    // 4. Active sessions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_active_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" int NOT NULL,
        "tenant_id" varchar NOT NULL,
        "session_id" varchar NOT NULL,
        "device_info" varchar,
        "connected_at" timestamp NOT NULL DEFAULT now(),
        "disconnected_at" timestamp,
        "invalidated" boolean NOT NULL DEFAULT false,
        "invalidated_reason" varchar,
        "last_heartbeat" timestamp,
        CONSTRAINT "PK_dark_factory_active_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dark_factory_active_sessions_session" UNIQUE ("session_id")
      )
    `);

    // 5. Timesheet
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_timesheet" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" int NOT NULL,
        "tenant_id" varchar NOT NULL,
        "project_id" varchar,
        "task_id" varchar,
        "hours" float NOT NULL,
        "description" text,
        "logged_date" date NOT NULL,
        "is_automatic" boolean NOT NULL DEFAULT false,
        "timer_start" timestamp,
        "timer_stop" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_timesheet" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_timesheet"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_active_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_agent_connections"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_team_members"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_licenses"`);
  }
}
