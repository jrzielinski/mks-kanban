import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookPostgresSSL1768100006000 implements MigrationInterface {
  name = 'FixAddressBookPostgresSSL1768100006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Read the address book flow
    const flows = await queryRunner.query(
      `SELECT id, flow_data FROM flow_definitions WHERE flow_data::text LIKE '%addr-list%' LIMIT 1`
    );
    if (!flows || flows.length === 0) return;

    const flowData = flows[0].flow_data;

    // Remove ssl: true from all postgresql nodes
    let changed = false;
    for (const node of flowData.nodes) {
      if (node.type === 'postgresql' && node.data?.config?.ssl) {
        delete node.data.config.ssl;
        changed = true;
      }
    }

    if (changed) {
      await queryRunner.query(
        `UPDATE flow_definitions SET flow_data = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(flowData), flows[0].id]
      );
      console.log('Removed SSL from PostgreSQL nodes in address book flow');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed
  }
}
