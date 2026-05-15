import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKanbanBoardRepos1775400000000 implements MigrationInterface {
  name = 'CreateKanbanBoardRepos1775400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_board_repos" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "board_id" VARCHAR NOT NULL,
        "name" VARCHAR NOT NULL,
        "repo_url" VARCHAR NOT NULL,
        "default_branch" VARCHAR NOT NULL DEFAULT 'main',
        "git_token" TEXT,
        "tenant_id" VARCHAR NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_board_repos_board_id" ON "kanban_board_repos"("board_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_kanban_board_repos_tenant_id" ON "kanban_board_repos"("tenant_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_board_repos"`);
  }
}
