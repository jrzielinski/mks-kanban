import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLicenseToTenants1735360000000 implements MigrationInterface {
  name = 'AddLicenseToTenants1735360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_configs"
      ADD COLUMN "license_key" VARCHAR(50) NULL,
      ADD COLUMN "license_last_validation" TIMESTAMP NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tenant_configs_license_key"
      ON "tenant_configs" ("license_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_tenant_configs_license_key"
    `);

    await queryRunner.query(`
      ALTER TABLE "tenant_configs"
      DROP COLUMN "license_last_validation",
      DROP COLUMN "license_key"
    `);
  }
}
