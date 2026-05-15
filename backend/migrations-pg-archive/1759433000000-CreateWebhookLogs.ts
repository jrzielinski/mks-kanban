import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateWebhookLogs1759433000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'webhook_logs',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'webhook_id',
            type: 'varchar',
            isNullable: true,
            comment: 'ID do webhook enviado pelo Mercado Pago',
          },
          {
            name: 'type',
            type: 'varchar',
            length: '100',
            comment: 'Tipo do evento (payment, chargebacks, merchant_order, etc)',
          },
          {
            name: 'action',
            type: 'varchar',
            length: '100',
            isNullable: true,
            comment: 'Ação específica (payment.created, payment.updated, etc)',
          },
          {
            name: 'resource_id',
            type: 'varchar',
            isNullable: true,
            comment: 'ID do recurso afetado (payment_id, order_id, etc)',
          },
          {
            name: 'user_id',
            type: 'varchar',
            isNullable: true,
            comment: 'User ID do Mercado Pago',
          },
          {
            name: 'live_mode',
            type: 'boolean',
            default: true,
            comment: 'Se é ambiente de produção',
          },
          {
            name: 'api_version',
            type: 'varchar',
            length: '20',
            isNullable: true,
          },
          {
            name: 'raw_payload',
            type: 'jsonb',
            comment: 'Payload completo recebido',
          },
          {
            name: 'resource_data',
            type: 'jsonb',
            isNullable: true,
            comment: 'Dados completos buscados da API do MP',
          },
          {
            name: 'processed',
            type: 'boolean',
            default: false,
            comment: 'Se o webhook foi processado com sucesso',
          },
          {
            name: 'processed_at',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'error',
            type: 'text',
            isNullable: true,
            comment: 'Erro durante processamento, se houver',
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Índices para performance
    await queryRunner.createIndex(
      'webhook_logs',
      new TableIndex({
        name: 'idx_webhook_logs_type',
        columnNames: ['type'],
      }),
    );

    await queryRunner.createIndex(
      'webhook_logs',
      new TableIndex({
        name: 'idx_webhook_logs_resource_id',
        columnNames: ['resource_id'],
      }),
    );

    await queryRunner.createIndex(
      'webhook_logs',
      new TableIndex({
        name: 'idx_webhook_logs_webhook_id',
        columnNames: ['webhook_id'],
      }),
    );

    await queryRunner.createIndex(
      'webhook_logs',
      new TableIndex({
        name: 'idx_webhook_logs_processed',
        columnNames: ['processed'],
      }),
    );

    await queryRunner.createIndex(
      'webhook_logs',
      new TableIndex({
        name: 'idx_webhook_logs_created_at',
        columnNames: ['created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('webhook_logs');
  }
}
