import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

export class CreateAuditLogs1762540000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'ai_audit_logs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'tenant_id',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'user_id',
            type: 'integer',
            isNullable: true,
          },
          {
            name: 'action',
            type: 'varchar',
            length: '100',
            isNullable: false,
            comment: 'AI action performed (ai_message_processed, document_analyzed, patient_history_accessed, etc)',
          },
          {
            name: 'resource_type',
            type: 'varchar',
            length: '50',
            isNullable: false,
            comment: 'message, document, patient_history, etc',
          },
          {
            name: 'resource_id',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'patient_id',
            type: 'varchar',
            length: '255',
            isNullable: true,
            comment: 'Patient affected by this action (for compliance)',
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'jsonb',
            isNullable: true,
            comment: 'Additional structured data (model used, tokens, etc)',
          },
          {
            name: 'ip_address',
            type: 'varchar',
            length: '45',
            isNullable: true,
          },
          {
            name: 'user_agent',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'timestamp',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'ai_audit_logs',
      new TableIndex({
        name: 'IDX_audit_tenant_timestamp',
        columnNames: ['tenant_id', 'timestamp'],
      }),
    );

    await queryRunner.createIndex(
      'ai_audit_logs',
      new TableIndex({
        name: 'IDX_audit_user_id',
        columnNames: ['user_id'],
      }),
    );

    await queryRunner.createIndex(
      'ai_audit_logs',
      new TableIndex({
        name: 'IDX_audit_patient_id',
        columnNames: ['patient_id'],
      }),
    );

    await queryRunner.createIndex(
      'ai_audit_logs',
      new TableIndex({
        name: 'IDX_audit_action',
        columnNames: ['action'],
      }),
    );

    await queryRunner.createIndex(
      'ai_audit_logs',
      new TableIndex({
        name: 'IDX_audit_resource',
        columnNames: ['resource_type', 'resource_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ai_audit_logs');
  }
}
