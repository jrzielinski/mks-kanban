import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateFormSubmissions1762001000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'form_submissions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'tenantId', type: 'varchar', isNullable: false },
          { name: 'flowId', type: 'varchar', isNullable: false },
          { name: 'formName', type: 'varchar', isNullable: false },
          { name: 'data', type: 'jsonb', isNullable: false },
          { name: 'meta', type: 'jsonb', isNullable: true },
          {
            name: 'submittedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex('form_submissions', new TableIndex({
      name: 'IDX_form_submissions_tenant_flow',
      columnNames: ['tenantId', 'flowId'],
    }));

    await queryRunner.createIndex('form_submissions', new TableIndex({
      name: 'IDX_form_submissions_tenant_name',
      columnNames: ['tenantId', 'formName'],
    }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('form_submissions');
  }
}
