import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddMissingFieldsToMedications1762811224524 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add duration column
        await queryRunner.addColumn('message_medications', new TableColumn({
            name: 'duration',
            type: 'varchar',
            length: '100',
            isNullable: true,
        }));

        // Add prescribed_by_doctor column
        await queryRunner.addColumn('message_medications', new TableColumn({
            name: 'prescribed_by_doctor',
            type: 'boolean',
            default: false,
            isNullable: false,
        }));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('message_medications', 'duration');
        await queryRunner.dropColumn('message_medications', 'prescribed_by_doctor');
    }

}
