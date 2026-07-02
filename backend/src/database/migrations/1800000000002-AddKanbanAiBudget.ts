import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddKanbanAiBudget1800000000002 implements MigrationInterface {
  name = 'AddKanbanAiBudget1800000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'kanban_ai_budgets',
        columns: [
          { name: 'tenant_id', type: 'varchar', isPrimary: true },
          { name: 'balance_usd', type: 'decimal', precision: 12, scale: 6, default: 0 },
          { name: 'byok_provider', type: 'varchar', isNullable: true },
          { name: 'byok_api_key', type: 'text', isNullable: true },
          { name: 'updated_at', type: 'timestamp', default: 'now()' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('kanban_ai_budgets');
  }
}
