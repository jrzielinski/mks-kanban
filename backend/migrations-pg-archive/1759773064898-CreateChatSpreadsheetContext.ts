import { MigrationInterface, QueryRunner, Table, TableForeignKey } from "typeorm";

export class CreateChatSpreadsheetContext1759773064898 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'chat_spreadsheet_context',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    {
                        name: 'sessionId',
                        type: 'uuid',
                        isNullable: false,
                    },
                    {
                        name: 'fileName',
                        type: 'varchar',
                        isNullable: false,
                    },
                    {
                        name: 'fileType',
                        type: 'varchar',
                        isNullable: false,
                    },
                    {
                        name: 'filePath',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'dataProfile',
                        type: 'jsonb',
                        isNullable: true,
                    },
                    {
                        name: 'generatedQuestions',
                        type: 'jsonb',
                        isNullable: true,
                    },
                    {
                        name: 'summary',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'tenantId',
                        type: 'varchar',
                        length: '50',
                        default: "'staff'",
                    },
                    {
                        name: 'createdAt',
                        type: 'timestamp',
                        default: 'now()',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'chat_spreadsheet_context',
            new TableForeignKey({
                columnNames: ['sessionId'],
                referencedColumnNames: ['id'],
                referencedTableName: 'chat_session',
                onDelete: 'CASCADE',
            }),
        );

        // Create index for faster lookups
        await queryRunner.query(`
            CREATE INDEX "IDX_chat_spreadsheet_context_session" ON "chat_spreadsheet_context" ("sessionId");
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('chat_spreadsheet_context');
    }

}
