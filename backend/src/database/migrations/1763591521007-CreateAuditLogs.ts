import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateAuditLogs1763591521007 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create audit_logs table
        await queryRunner.createTable(
            new Table({
                name: 'audit_logs',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        default: 'uuid_generate_v4()',
                    },
                    {
                        name: 'timestamp',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                    {
                        name: 'tenantId',
                        type: 'varchar',
                        length: '100',
                    },
                    {
                        name: 'userId',
                        type: 'uuid',
                        isNullable: true,
                    },
                    {
                        name: 'userType',
                        type: 'varchar',
                        length: '50',
                        isNullable: true,
                        comment: 'doctor, patient, staff, system',
                    },
                    {
                        name: 'action',
                        type: 'varchar',
                        length: '200',
                        comment: 'Action performed (e.g., prescription_created, ai_suggestion_accepted)',
                    },
                    {
                        name: 'resource',
                        type: 'varchar',
                        length: '100',
                        comment: 'Resource type (e.g., consultation, patient, prescription)',
                    },
                    {
                        name: 'resourceId',
                        type: 'varchar',
                        length: '100',
                        isNullable: true,
                        comment: 'ID of the affected resource',
                    },
                    {
                        name: 'before',
                        type: 'jsonb',
                        isNullable: true,
                        comment: 'State before action (for updates/deletes)',
                    },
                    {
                        name: 'after',
                        type: 'jsonb',
                        isNullable: true,
                        comment: 'State after action (for creates/updates)',
                    },
                    {
                        name: 'ipAddress',
                        type: 'varchar',
                        length: '45',
                        isNullable: true,
                        comment: 'IPv4 or IPv6 address',
                    },
                    {
                        name: 'userAgent',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'sessionId',
                        type: 'varchar',
                        length: '100',
                        isNullable: true,
                    },
                    {
                        name: 'success',
                        type: 'boolean',
                        default: true,
                    },
                    {
                        name: 'errorMessage',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'errorStack',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'metadata',
                        type: 'jsonb',
                        isNullable: true,
                        comment: 'Additional data (AI model info, request params, etc.)',
                    },
                    {
                        name: 'duration',
                        type: 'integer',
                        isNullable: true,
                        comment: 'Request duration in milliseconds',
                    },
                    {
                        name: 'httpMethod',
                        type: 'varchar',
                        length: '10',
                        isNullable: true,
                    },
                    {
                        name: 'httpPath',
                        type: 'varchar',
                        length: '500',
                        isNullable: true,
                    },
                    {
                        name: 'httpStatusCode',
                        type: 'integer',
                        isNullable: true,
                    },
                ],
            }),
            true,
        );

        // Create indexes for efficient querying
        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_timestamp',
                columnNames: ['timestamp'],
            }),
        );

        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_userId',
                columnNames: ['userId'],
            }),
        );

        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_tenantId',
                columnNames: ['tenantId'],
            }),
        );

        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_action',
                columnNames: ['action'],
            }),
        );

        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_resource',
                columnNames: ['resource', 'resourceId'],
            }),
        );

        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_success',
                columnNames: ['success'],
            }),
        );

        // Composite index for common queries
        await queryRunner.createIndex(
            'audit_logs',
            new TableIndex({
                name: 'IDX_audit_logs_tenant_user_timestamp',
                columnNames: ['tenantId', 'userId', 'timestamp'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('audit_logs');
    }

}
