import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAgentHandoffQueue1761629000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create agent_handoff_queue table
    await queryRunner.createTable(
      new Table({
        name: 'agent_handoff_queue',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'instanceId',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'contactPhone',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'contactName',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'flowId',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'nodeId',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['waiting', 'in_progress', 'completed', 'abandoned'],
            default: "'waiting'",
            isNullable: false,
          },
          {
            name: 'agentId',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'agentName',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'department',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'queueReason',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'priority',
            type: 'int',
            default: 0,
            isNullable: false,
          },
          {
            name: 'context',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'waitingMessage',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'queuedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'pickedAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'completedAt',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'finalNotes',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'agent_handoff_queue',
      new TableIndex({
        name: 'IDX_agent_handoff_queue_instance_contact',
        columnNames: ['instanceId', 'contactPhone'],
      }),
    );

    await queryRunner.createIndex(
      'agent_handoff_queue',
      new TableIndex({
        name: 'IDX_agent_handoff_queue_status_priority',
        columnNames: ['status', 'priority'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('agent_handoff_queue');
  }
}
