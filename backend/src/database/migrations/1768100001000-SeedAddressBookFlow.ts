import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedAddressBookFlow1768100001000 implements MigrationInterface {
  name = 'SeedAddressBookFlow1768100001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Get admin user ID and tenant
    const adminUser = await queryRunner.query(`
      SELECT id, "tenantId" FROM "user" WHERE email = 'admin@zielinski.dev.br' LIMIT 1
    `);

    if (!adminUser || adminUser.length === 0) {
      console.log('Admin user not found, skipping address book flow seed');
      return;
    }

    const userId = adminUser[0].id;
    const tenantId = adminUser[0].tenantId;

    // Check if flow already exists
    const existing = await queryRunner.query(`
      SELECT id FROM flow_definitions WHERE name = 'Agenda de Endereços - Backend' AND tenant_id = $1 LIMIT 1
    `, [tenantId]);

    if (existing && existing.length > 0) {
      console.log('Address book flow already exists, skipping');
      return;
    }

    // Get database connection info from current connection
    const dbOptions = queryRunner.connection.options as any;
    const pgConfig = {
      host: dbOptions.host || 'zielinski-postgres',
      port: dbOptions.port || 5432,
      database: dbOptions.database || 'zielinski',
      user: dbOptions.username || 'zielinski',
      password: dbOptions.password || '',
    };

    const flowData = {
      nodes: [
        // ===== WEBHOOK TRIGGERS =====
        {
          id: 'addr-list',
          type: 'webhook_trigger',
          position: { x: 100, y: 0 },
          data: {
            label: 'Listar Endereços',
            path: 'addr-list',
            webhookPath: 'addr-list',
            acceptedMethods: ['POST'],
            active: true,
            outputVariable: 'webhook_data',
          },
        },
        {
          id: 'addr-create',
          type: 'webhook_trigger',
          position: { x: 100, y: 200 },
          data: {
            label: 'Criar Endereço',
            path: 'addr-create',
            webhookPath: 'addr-create',
            acceptedMethods: ['POST'],
            active: true,
            outputVariable: 'webhook_data',
          },
        },
        {
          id: 'addr-update',
          type: 'webhook_trigger',
          position: { x: 100, y: 400 },
          data: {
            label: 'Atualizar Endereço',
            path: 'addr-update',
            webhookPath: 'addr-update',
            acceptedMethods: ['POST'],
            active: true,
            outputVariable: 'webhook_data',
          },
        },
        {
          id: 'addr-delete',
          type: 'webhook_trigger',
          position: { x: 100, y: 600 },
          data: {
            label: 'Deletar Endereço',
            path: 'addr-delete',
            webhookPath: 'addr-delete',
            acceptedMethods: ['POST'],
            active: true,
            outputVariable: 'webhook_data',
          },
        },
        {
          id: 'addr-get',
          type: 'webhook_trigger',
          position: { x: 100, y: 800 },
          data: {
            label: 'Buscar Endereço',
            path: 'addr-get',
            webhookPath: 'addr-get',
            acceptedMethods: ['POST'],
            active: true,
            outputVariable: 'webhook_data',
          },
        },
        {
          id: 'addr-cep',
          type: 'webhook_trigger',
          position: { x: 100, y: 1000 },
          data: {
            label: 'Buscar CEP',
            path: 'addr-cep',
            webhookPath: 'addr-cep',
            acceptedMethods: ['POST'],
            active: true,
            outputVariable: 'webhook_data',
          },
        },

        // ===== POSTGRESQL EXECUTOR NODES =====
        {
          id: 'pg-list',
          type: 'postgresql',
          position: { x: 500, y: 0 },
          data: {
            label: 'SELECT Endereços',
            operation: 'executeQuery',
            config: pgConfig,
            query: `SELECT *, (SELECT COUNT(*) FROM addresses WHERE tenant_id = '{{tenantId}}' AND is_active = true AND (COALESCE('{{search}}', '') = '' OR nome ILIKE '%' || '{{search}}' || '%' OR cidade ILIKE '%' || '{{search}}' || '%' OR email ILIKE '%' || '{{search}}' || '%')) as total_count FROM addresses WHERE tenant_id = '{{tenantId}}' AND is_active = true AND (COALESCE('{{search}}', '') = '' OR nome ILIKE '%' || '{{search}}' || '%' OR cidade ILIKE '%' || '{{search}}' || '%' OR email ILIKE '%' || '{{search}}' || '%') ORDER BY nome LIMIT COALESCE(NULLIF('{{limit}}', ''), '20')::int OFFSET COALESCE(NULLIF('{{offset}}', ''), '0')::int`,
            responseVariable: 'postgres_result',
          },
        },
        {
          id: 'pg-create',
          type: 'postgresql',
          position: { x: 500, y: 200 },
          data: {
            label: 'INSERT Endereço',
            operation: 'insert',
            config: pgConfig,
            table: 'addresses',
            fields: ['tenant_id', 'nome', 'telefone', 'email', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'estado', 'pais', 'observacoes'],
            values: {
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
            },
            responseVariable: 'postgres_result',
          },
        },
        {
          id: 'pg-update',
          type: 'postgresql',
          position: { x: 500, y: 400 },
          data: {
            label: 'UPDATE Endereço',
            operation: 'update',
            config: pgConfig,
            table: 'addresses',
            fields: ['nome', 'telefone', 'email', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'estado', 'pais', 'observacoes', 'updated_at'],
            values: {
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
            },
            conditions: {
              id: '{{id}}',
              tenant_id: '{{tenantId}}',
            },
            responseVariable: 'postgres_result',
          },
        },
        {
          id: 'pg-delete',
          type: 'postgresql',
          position: { x: 500, y: 600 },
          data: {
            label: 'SOFT DELETE Endereço',
            operation: 'update',
            config: pgConfig,
            table: 'addresses',
            fields: ['is_active', 'updated_at'],
            values: {
              is_active: 'false',
              updated_at: 'NOW()',
            },
            conditions: {
              id: '{{id}}',
              tenant_id: '{{tenantId}}',
            },
            responseVariable: 'postgres_result',
          },
        },
        {
          id: 'pg-get',
          type: 'postgresql',
          position: { x: 500, y: 800 },
          data: {
            label: 'SELECT Endereço por ID',
            operation: 'executeQuery',
            config: pgConfig,
            query: `SELECT * FROM addresses WHERE id = '{{id}}' AND tenant_id = '{{tenantId}}' AND is_active = true LIMIT 1`,
            responseVariable: 'postgres_result',
          },
        },
        {
          id: 'http-cep',
          type: 'http_request',
          position: { x: 500, y: 1000 },
          data: {
            label: 'Buscar CEP - ViaCEP',
            method: 'GET',
            url: 'https://viacep.com.br/ws/{{cep}}/json/',
            responseVariable: 'cep_result',
            headers: {},
          },
        },
      ],
      edges: [
        { id: 'e-list', source: 'addr-list', target: 'pg-list' },
        { id: 'e-create', source: 'addr-create', target: 'pg-create' },
        { id: 'e-update', source: 'addr-update', target: 'pg-update' },
        { id: 'e-delete', source: 'addr-delete', target: 'pg-delete' },
        { id: 'e-get', source: 'addr-get', target: 'pg-get' },
        { id: 'e-cep', source: 'addr-cep', target: 'http-cep' },
      ],
      startNodeId: 'addr-list',
    };

    const metadata = {
      version: '1.0.0',
      tags: ['agenda', 'enderecos', 'crud', 'address-book'],
      icon: 'MapPin',
      color: '#3b82f6',
    };

    await queryRunner.query(`
      INSERT INTO flow_definitions (
        name, description, category, status, flow_data, metadata,
        is_public, is_template, chat_public_active,
        execution_count, success_count, failure_count,
        created_by_id, tenant_id, created_at, updated_at
      ) VALUES (
        'Agenda de Endereços - Backend',
        'Flow backend com webhooks para CRUD de endereços. Cada webhook_trigger é um endpoint da API.',
        'webhook',
        'active',
        $1::jsonb,
        $2::jsonb,
        true,
        false,
        false,
        0, 0, 0,
        $3,
        $4,
        NOW(),
        NOW()
      )
    `, [JSON.stringify(flowData), JSON.stringify(metadata), userId, tenantId]);

    console.log('Address book flow seeded successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM flow_definitions WHERE name = 'Agenda de Endereços - Backend'
    `);
  }
}
