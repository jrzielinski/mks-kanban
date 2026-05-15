import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserConsentTable1776800200000 implements MigrationInterface {
  name = 'CreateUserConsentTable1776800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_consent" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" varchar NOT NULL,
        "tenantId" varchar(50) NOT NULL,
        "purpose" varchar(100) NOT NULL,
        "granted" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_consent_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_consent_user_tenant_purpose" UNIQUE ("userId", "tenantId", "purpose")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_user_consent_userId" ON "user_consent" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_user_consent_tenantId" ON "user_consent" ("tenantId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_consent"`);
  }
}
