import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddUsersTable1800000000001 implements MigrationInterface {
  name = 'AddUsersTable1800000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          { name: 'email', type: 'varchar', isUnique: true },
          { name: 'password', type: 'varchar', isNullable: true },
          { name: 'firstName', type: 'varchar', isNullable: true },
          { name: 'lastName', type: 'varchar', isNullable: true },
          { name: 'avatar', type: 'varchar', isNullable: true },
          { name: 'syncedFromCloud', type: 'boolean', default: false },
          { name: 'cloudUserId', type: 'varchar', isNullable: true },
          { name: 'lastLicenseCheck', type: 'timestamp', isNullable: true },
          { name: 'licenseGraceDays', type: 'int', default: 0 },
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('users');
  }
}
