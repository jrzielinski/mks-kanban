import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

export class CreateFlowExecutionLogsTable1767800000000 implements MigrationInterface {
  name = 'CreateFlowExecutionLogsTable1767800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'flow_execution_logs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'execution_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'flow_id',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'node_id',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'node_type',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'node_name',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'level',
            type: 'varchar',
            length: '10',
            default: "'info'",
          },
          {
            name: 'message',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'data',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'context',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'timestamp',
            type: 'timestamptz',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'tenant_id',
            type: 'varchar',
            length: '50',
            isNullable: true,
          },
        ],
      }),
      true,
    );

    // Índice principal: execution_id + timestamp (para buscar logs de uma execução em ordem)
    await queryRunner.createIndex(
      'flow_execution_logs',
      new TableIndex({
        name: 'IDX_flow_execution_logs_execution_timestamp',
        columnNames: ['execution_id', 'timestamp'],
      }),
    );

    // Índice para filtrar por level dentro de uma execução
    await queryRunner.createIndex(
      'flow_execution_logs',
      new TableIndex({
        name: 'IDX_flow_execution_logs_execution_level',
        columnNames: ['execution_id', 'level'],
      }),
    );

    // Índice para buscar logs de um nó específico
    await queryRunner.createIndex(
      'flow_execution_logs',
      new TableIndex({
        name: 'IDX_flow_execution_logs_node_id',
        columnNames: ['node_id'],
      }),
    );

    // Índice para buscar por tenant e timestamp (limpeza, analytics)
    await queryRunner.createIndex(
      'flow_execution_logs',
      new TableIndex({
        name: 'IDX_flow_execution_logs_tenant_timestamp',
        columnNames: ['tenant_id', 'timestamp'],
      }),
    );

    // Índice para buscar erros globais
    await queryRunner.createIndex(
      'flow_execution_logs',
      new TableIndex({
        name: 'IDX_flow_execution_logs_level_timestamp',
        columnNames: ['level', 'timestamp'],
      }),
    );

    // Note: FK to flow_instances omitted - flow_instances.id may not have a unique constraint
    // The execution_id column is indexed for performance
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('flow_execution_logs', 'IDX_flow_execution_logs_level_timestamp');
    await queryRunner.dropIndex('flow_execution_logs', 'IDX_flow_execution_logs_tenant_timestamp');
    await queryRunner.dropIndex('flow_execution_logs', 'IDX_flow_execution_logs_node_id');
    await queryRunner.dropIndex('flow_execution_logs', 'IDX_flow_execution_logs_execution_level');
    await queryRunner.dropIndex('flow_execution_logs', 'IDX_flow_execution_logs_execution_timestamp');
    await queryRunner.dropTable('flow_execution_logs');
  }
}
