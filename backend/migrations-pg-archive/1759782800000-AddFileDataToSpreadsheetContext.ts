import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddFileDataToSpreadsheetContext1759782800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'chat_spreadsheet_context',
      new TableColumn({
        name: 'fileData',
        type: 'text',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('chat_spreadsheet_context', 'fileData');
  }
}
