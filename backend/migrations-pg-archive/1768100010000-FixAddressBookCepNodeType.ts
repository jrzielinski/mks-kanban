import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookCepNodeType1768100010000 implements MigrationInterface {
  name = 'FixAddressBookCepNodeType1768100010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const flows = await queryRunner.query(
      `SELECT id, flow_data FROM flow_definitions WHERE flow_data::text LIKE '%addr-cep%' LIMIT 1`
    );
    if (!flows || flows.length === 0) return;

    const flowData = flows[0].flow_data;

    // Fix http-cep node: change type from http_request to api_call
    const cepNode = flowData.nodes.find((n: any) => n.id === 'http-cep');
    if (cepNode) {
      cepNode.type = 'api_call';
      // api_call uses same fields: url, method, headers, responseVariable
    }

    await queryRunner.query(
      `UPDATE flow_definitions SET flow_data = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(flowData), flows[0].id]
    );

    console.log('Changed http-cep node type from http_request to api_call');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed
  }
}
