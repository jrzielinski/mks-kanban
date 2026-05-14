import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixCredentialsAllowedTenantsType1762863326000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change allowedTenants from text to text[] (array)
    await queryRunner.query(`
      ALTER TABLE "credentials"
      ALTER COLUMN "allowedTenants"
      TYPE text[]
      USING CASE
        WHEN "allowedTenants" IS NULL THEN NULL
        WHEN "allowedTenants" = '' THEN ARRAY[]::text[]
        ELSE string_to_array("allowedTenants", ',')
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert back to text
    await queryRunner.query(`
      ALTER TABLE "credentials"
      ALTER COLUMN "allowedTenants"
      TYPE text
      USING CASE
        WHEN "allowedTenants" IS NULL THEN NULL
        ELSE array_to_string("allowedTenants", ',')
      END
    `);
  }
}
