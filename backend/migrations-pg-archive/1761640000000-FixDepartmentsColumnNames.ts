import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixDepartmentsColumnNames1761640000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix column names from lowercase to camelCase (PostgreSQL case-sensitive with quotes)
    // Check if columns need renaming (they may already be correct)
    const columns = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'departments' AND column_name IN ('sortorder', 'tenantid', 'createdat', 'updatedat')
    `);

    if (columns.length > 0) {
      for (const col of columns) {
        const oldName = col.column_name;
        const camelCase = oldName === 'sortorder' ? 'sortOrder'
          : oldName === 'tenantid' ? 'tenantId'
          : oldName === 'createdat' ? 'createdAt'
          : oldName === 'updatedat' ? 'updatedAt'
          : null;
        if (camelCase) {
          await queryRunner.query(`ALTER TABLE departments RENAME COLUMN ${oldName} TO "${camelCase}"`);
        }
      }
    }

    // Ensure PK exists
    const pk = await queryRunner.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'departments'::regclass AND contype = 'p'
    `);
    if (pk.length === 0) {
      await queryRunner.query(`ALTER TABLE departments ADD CONSTRAINT departments_pkey PRIMARY KEY (id)`);
    }

    // Ensure index exists
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_departments_tenantId_active" ON departments("tenantId", active)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op: reverting column names would break the application
  }
}
