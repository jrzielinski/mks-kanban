import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameAgentConnectionsTable1775300000000 implements MigrationInterface {
  name = 'RenameAgentConnectionsTable1775300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE IF EXISTS dark_factory_agent_connections RENAME TO agent_connections`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE IF EXISTS agent_connections RENAME TO dark_factory_agent_connections`);
  }
}
