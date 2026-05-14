import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateCredentialsTable1762863184000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'credentials',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'name',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'encryptedData',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'isShared',
            type: 'boolean',
            default: false,
          },
          {
            name: 'allowedTenants',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'ownerId',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'credentials',
      new TableIndex({
        name: 'IDX_credentials_name',
        columnNames: ['name'],
      }),
    );

    await queryRunner.createIndex(
      'credentials',
      new TableIndex({
        name: 'IDX_credentials_type',
        columnNames: ['type'],
      }),
    );

    await queryRunner.createIndex(
      'credentials',
      new TableIndex({
        name: 'IDX_credentials_ownerId',
        columnNames: ['ownerId'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('credentials');
  }
}
