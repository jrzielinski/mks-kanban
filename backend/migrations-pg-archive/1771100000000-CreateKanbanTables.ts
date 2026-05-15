import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKanbanTables1771100000000 implements MigrationInterface {
  name = 'CreateKanbanTables1771100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_boards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying NOT NULL,
        "description" text,
        "color" character varying NOT NULL DEFAULT '#3b82f6',
        "tenant_id" character varying NOT NULL,
        "owner_id" character varying,
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kanban_boards" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_kanban_boards_tenant_id" ON "kanban_boards" ("tenant_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_lists" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "board_id" character varying NOT NULL,
        "title" character varying NOT NULL,
        "color" character varying NOT NULL DEFAULT '#e2e8f0',
        "position" integer NOT NULL DEFAULT 0,
        "is_archived" boolean NOT NULL DEFAULT false,
        "tenant_id" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kanban_lists" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_kanban_lists_board_id" ON "kanban_lists" ("board_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_kanban_lists_tenant_id" ON "kanban_lists" ("tenant_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_cards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "list_id" character varying NOT NULL,
        "board_id" character varying NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "position" integer NOT NULL DEFAULT 0,
        "labels" jsonb NOT NULL DEFAULT '[]',
        "checklist" jsonb NOT NULL DEFAULT '[]',
        "due_date" TIMESTAMP,
        "cover_color" character varying NOT NULL DEFAULT '#ffffff',
        "is_archived" boolean NOT NULL DEFAULT false,
        "tenant_id" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kanban_cards" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_kanban_cards_list_id" ON "kanban_cards" ("list_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_kanban_cards_board_id" ON "kanban_cards" ("board_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_kanban_cards_tenant_id" ON "kanban_cards" ("tenant_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_cards"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_lists"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_boards"`);
  }
}
