import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDarkFactoryClarificationRequests1769600000000
  implements MigrationInterface
{
  name = 'CreateDarkFactoryClarificationRequests1769600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_clarification_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid,
        "dum_id" uuid,
        "request_type" varchar NOT NULL,
        "from_agent" varchar NOT NULL,
        "to_agent" varchar NOT NULL,
        "message" text NOT NULL,
        "context" text,
        "questions" jsonb,
        "artifact_ids" jsonb,
        "status" varchar NOT NULL DEFAULT 'pending',
        "response" text,
        "responded_by" varchar,
        "responded_at" TIMESTAMP,
        "metadata" jsonb,
        "tenant_id" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_clarification_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dark_factory_clarification_requests_project" FOREIGN KEY ("project_id") REFERENCES "dark_factory_projects"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_dark_factory_clarification_requests_dum" FOREIGN KEY ("dum_id") REFERENCES "dark_factory_dums"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_clarification_requests_project" ON "dark_factory_clarification_requests" ("project_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_clarification_requests_status" ON "dark_factory_clarification_requests" ("status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dark_factory_clarification_requests_to_agent" ON "dark_factory_clarification_requests" ("to_agent")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_clarification_requests"`);
  }
}
