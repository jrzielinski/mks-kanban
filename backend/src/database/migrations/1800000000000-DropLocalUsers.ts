import { MigrationInterface, QueryRunner } from 'typeorm';

/** Run AFTER mks-identity is live and all kanban consumers validate JWKS.
 *  Removes the local users table — user identity is now owned by mks-identity. */
export class DropLocalUsers1800000000000 implements MigrationInterface {
  name = 'DropLocalUsers1800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
        "email"                  VARCHAR NOT NULL,
        "password_hash"          VARCHAR NOT NULL,
        "first_name"             VARCHAR,
        "last_name"              VARCHAR,
        "tenant_id"              VARCHAR NOT NULL DEFAULT 'staff',
        "role"                   VARCHAR NOT NULL DEFAULT 'user',
        "is_banned"              BOOLEAN NOT NULL DEFAULT FALSE,
        "locked_until"           TIMESTAMP,
        "failed_login_attempts"  INT NOT NULL DEFAULT 0,
        "created_at"             TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"             TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);
  }
}
