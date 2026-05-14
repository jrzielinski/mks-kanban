import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateFlowExecutionHistoryTable1764275000000 implements MigrationInterface {
  name = 'CreateFlowExecutionHistoryTable1764275000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'flow_execution_history',
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
            name: 'execution_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'snapshot',
            type: 'jsonb',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'duration',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'error_count',
            type: 'integer',
            default: 0,
          },
          {
            name: 'executed_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'tenant_id',
            type: 'varchar',
            length: '50',
            default: "'staff'",
          },
        ],
      }),
      true,
    );

    // Criar índices
    await queryRunner.createIndex(
      'flow_execution_history',
      new TableIndex({
        name: 'IDX_flow_execution_history_flow_executed',
        columnNames: ['flow_id', 'executed_at'],
      }),
    );

    await queryRunner.createIndex(
      'flow_execution_history',
      new TableIndex({
        name: 'IDX_flow_execution_history_status_executed',
        columnNames: ['status', 'executed_at'],
      }),
    );

    await queryRunner.createIndex(
      'flow_execution_history',
      new TableIndex({
        name: 'IDX_flow_execution_history_tenant_executed',
        columnNames: ['tenant_id', 'executed_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('flow_execution_history', 'IDX_flow_execution_history_tenant_executed');
    await queryRunner.dropIndex('flow_execution_history', 'IDX_flow_execution_history_status_executed');
    await queryRunner.dropIndex('flow_execution_history', 'IDX_flow_execution_history_flow_executed');
    await queryRunner.dropTable('flow_execution_history');
  }
}
