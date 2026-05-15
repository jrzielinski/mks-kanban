import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateFlowVersionsTable1765000000000 implements MigrationInterface {
  name = 'CreateFlowVersionsTable1765000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'flow_versions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'flow_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'version_number',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'snapshot',
            type: 'jsonb',
            isNullable: false,
          },
          {
            name: 'changes_summary',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'changes_detail',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'created_by_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'tenant_id',
            type: 'varchar',
            length: '50',
            default: "'staff'",
          },
          {
            name: 'is_auto_save',
            type: 'boolean',
            default: false,
          },
          {
            name: 'restore_point',
            type: 'boolean',
            default: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Criar índices
    await queryRunner.createIndex(
      'flow_versions',
      new TableIndex({
        name: 'IDX_flow_versions_flow_created',
        columnNames: ['flow_id', 'created_at'],
      }),
    );

    await queryRunner.createIndex(
      'flow_versions',
      new TableIndex({
        name: 'IDX_flow_versions_flow_version',
        columnNames: ['flow_id', 'version_number'],
      }),
    );

    await queryRunner.createIndex(
      'flow_versions',
      new TableIndex({
        name: 'IDX_flow_versions_tenant_created',
        columnNames: ['tenant_id', 'created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('flow_versions', 'IDX_flow_versions_tenant_created');
    await queryRunner.dropIndex('flow_versions', 'IDX_flow_versions_flow_version');
    await queryRunner.dropIndex('flow_versions', 'IDX_flow_versions_flow_created');
    await queryRunner.dropTable('flow_versions');
  }
}
