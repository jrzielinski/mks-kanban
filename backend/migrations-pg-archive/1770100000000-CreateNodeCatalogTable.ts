import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNodeCatalogTable1770100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "node_catalog" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "node_type" varchar NOT NULL,
        "display_name" varchar NOT NULL,
        "category" varchar NOT NULL,
        "short_description" text NOT NULL,
        "detailed_description" text,
        "operations" jsonb,
        "tags" jsonb,
        "is_no_code" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_node_catalog" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_node_catalog_node_type" UNIQUE ("node_type")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_node_catalog_category"
      ON "node_catalog" ("category")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_node_catalog_is_active"
      ON "node_catalog" ("is_active")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_node_catalog_tags"
      ON "node_catalog" USING GIN ("tags")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_node_catalog_tags"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_node_catalog_is_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_node_catalog_category"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "node_catalog"`);
  }
}
