import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookNodeOperations1768100007000 implements MigrationInterface {
  name = 'FixAddressBookNodeOperations1768100007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const flows = await queryRunner.query(
      `SELECT id, flow_data FROM flow_definitions WHERE flow_data::text LIKE '%addr-list%' LIMIT 1`
    );
    if (!flows || flows.length === 0) return;

    const flowData = flows[0].flow_data;

    for (const node of flowData.nodes) {
      // Fix pg-create: should be INSERT, not UPDATE
      if (node.id === 'pg-create') {
        node.data.operation = 'insert';
        node.data.table = 'addresses';
        delete node.data.conditions;
        node.data.fields = [
          'tenant_id', 'nome', 'telefone', 'email', 'cep',
          'logradouro', 'numero', 'complemento', 'bairro',
          'cidade', 'estado', 'pais', 'observacoes',
        ];
        node.data.values = {
          tenant_id: '{{tenantId}}',
          nome: '{{nome}}',
          telefone: '{{telefone}}',
          email: '{{email}}',
          cep: '{{cep}}',
          logradouro: '{{logradouro}}',
          numero: '{{numero}}',
          complemento: '{{complemento}}',
          bairro: '{{bairro}}',
          cidade: '{{cidade}}',
          estado: '{{estado}}',
          pais: '{{pais}}',
          observacoes: '{{observacoes}}',
        };
        node.data.label = 'INSERT Endereço';
      }

      // Fix pg-get: should be executeQuery with SELECT, not update
      if (node.id === 'pg-get') {
        node.data.operation = 'executeQuery';
        node.data.query = "SELECT * FROM addresses WHERE id = '{{id}}' AND tenant_id = '{{tenantId}}' AND is_active = true LIMIT 1";
        delete node.data.conditions;
        delete node.data.fields;
        delete node.data.values;
        delete node.data.table;
        node.data.label = 'SELECT Endereço por ID';
      }

      // Fix pg-delete: ensure is_active = false in values
      if (node.id === 'pg-delete') {
        node.data.operation = 'update';
        node.data.table = 'addresses';
        node.data.fields = ['is_active', 'updated_at'];
        node.data.values = {
          is_active: 'false',
          updated_at: 'NOW()',
        };
        node.data.conditions = {
          id: '{{id}}',
          tenant_id: '{{tenantId}}',
        };
        node.data.label = 'SOFT DELETE Endereço';
      }

      // Fix pg-update: ensure proper update with tenant isolation
      if (node.id === 'pg-update') {
        node.data.operation = 'update';
        node.data.table = 'addresses';
        node.data.fields = [
          'nome', 'telefone', 'email', 'cep',
          'logradouro', 'numero', 'complemento', 'bairro',
          'cidade', 'estado', 'pais', 'observacoes', 'updated_at',
        ];
        node.data.values = {
          nome: '{{nome}}',
          telefone: '{{telefone}}',
          email: '{{email}}',
          cep: '{{cep}}',
          logradouro: '{{logradouro}}',
          numero: '{{numero}}',
          complemento: '{{complemento}}',
          bairro: '{{bairro}}',
          cidade: '{{cidade}}',
          estado: '{{estado}}',
          pais: '{{pais}}',
          observacoes: '{{observacoes}}',
          updated_at: 'NOW()',
        };
        node.data.conditions = {
          id: '{{id}}',
          tenant_id: '{{tenantId}}',
        };
        node.data.label = 'UPDATE Endereço';
      }
    }

    await queryRunner.query(
      `UPDATE flow_definitions SET flow_data = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(flowData), flows[0].id]
    );

    console.log('Fixed address book node operations (insert/select/update/delete)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed
  }
}
