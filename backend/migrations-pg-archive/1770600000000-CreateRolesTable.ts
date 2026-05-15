import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRolesTable1770600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dark_factory_roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" varchar NOT NULL,
        "color" varchar,
        "tenant_id" varchar NOT NULL,
        "sort_order" int NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dark_factory_roles" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "dark_factory_roles" ("name", "color", "tenant_id", "sort_order") VALUES
        ('Gestor/PM', 'bg-purple-100 text-purple-700', 'staff', 0),
        ('Tech Lead', 'bg-violet-100 text-violet-700', 'staff', 1),
        ('Sênior', 'bg-blue-100 text-blue-700', 'staff', 2),
        ('Pleno', 'bg-cyan-100 text-cyan-700', 'staff', 3),
        ('Júnior', 'bg-green-100 text-green-700', 'staff', 4),
        ('Estagiário', 'bg-lime-100 text-lime-700', 'staff', 5),
        ('QA', 'bg-amber-100 text-amber-700', 'staff', 6),
        ('Designer', 'bg-pink-100 text-pink-700', 'staff', 7),
        ('DevOps', 'bg-orange-100 text-orange-700', 'staff', 8)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dark_factory_roles"`);
  }
}
