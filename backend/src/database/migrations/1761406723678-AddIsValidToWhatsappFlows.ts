import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddIsValidToWhatsappFlows1761406723678 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add isValid column to whatsapp_flows table
    await queryRunner.addColumn(
      'whatsapp_flows',
      new TableColumn({
        name: 'isValid',
        type: 'boolean',
        default: true,
        isNullable: false,
        comment: 'Indicates if the flow has been validated and has no errors. Flows with errors cannot be executed.',
      })
    );

    // Add validationErrors column to store validation error messages
    await queryRunner.addColumn(
      'whatsapp_flows',
      new TableColumn({
        name: 'validationErrors',
        type: 'jsonb',
        isNullable: true,
        comment: 'Array of validation errors found in the flow. Format: [{ nodeId: string, field: string, message: string }]',
      })
    );

    // Add lastValidatedAt timestamp
    await queryRunner.addColumn(
      'whatsapp_flows',
      new TableColumn({
        name: 'lastValidatedAt',
        type: 'timestamp',
        isNullable: true,
        comment: 'Timestamp of the last validation check',
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('whatsapp_flows', 'lastValidatedAt');
    await queryRunner.dropColumn('whatsapp_flows', 'validationErrors');
    await queryRunner.dropColumn('whatsapp_flows', 'isValid');
  }
}
