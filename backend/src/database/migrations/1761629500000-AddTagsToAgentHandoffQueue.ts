import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddTagsToAgentHandoffQueue1761629500000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add tags column to agent_handoff_queue table
    await queryRunner.addColumn(
      'agent_handoff_queue',
      new TableColumn({
        name: 'tags',
        type: 'text',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove tags column
    await queryRunner.dropColumn('agent_handoff_queue', 'tags');
  }
}
