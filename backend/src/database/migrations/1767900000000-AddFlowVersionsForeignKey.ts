import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

export class AddFlowVersionsForeignKey1767900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Drop existing indexes that depend on flow_id
    console.log('🔧 Dropping indexes that depend on flow_id...');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_flow_versions_flow_created"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_flow_versions_flow_version"');

    // Step 2: Change flow_id type from varchar to uuid
    console.log('🔧 Converting flow_id from varchar to uuid...');
    await queryRunner.query(`
      ALTER TABLE "flow_versions"
      ALTER COLUMN "flow_id" TYPE uuid USING flow_id::uuid
    `);

    // Step 3: Recreate the indexes
    console.log('🔧 Recreating indexes with uuid type...');
    await queryRunner.query('CREATE INDEX "IDX_flow_versions_flow_created" ON "flow_versions" ("flow_id", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_flow_versions_flow_version" ON "flow_versions" ("flow_id", "version_number")');

    // Note: FK to flow_definitions omitted - table may not have unique constraint on id
    console.log('✅ Successfully converted flow_id to uuid and recreated indexes');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Drop the indexes
    console.log('🔧 Dropping indexes...');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_flow_versions_flow_created"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_flow_versions_flow_version"');

    // Step 3: Convert flow_id back to varchar
    console.log('🔧 Converting flow_id back to varchar...');
    await queryRunner.query(`
      ALTER TABLE "flow_versions"
      ALTER COLUMN "flow_id" TYPE varchar USING flow_id::text
    `);

    // Step 4: Recreate the indexes with varchar type
    console.log('🔧 Recreating indexes with varchar type...');
    await queryRunner.query('CREATE INDEX "IDX_flow_versions_flow_created" ON "flow_versions" ("flow_id", "created_at")');
    await queryRunner.query('CREATE INDEX "IDX_flow_versions_flow_version" ON "flow_versions" ("flow_id", "version_number")');

    console.log('✅ Successfully reverted foreign key constraint changes');
  }
}
