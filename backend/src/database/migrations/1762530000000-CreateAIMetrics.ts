import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAIMetrics1762530000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'ai_usage_metrics',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'tenant_id',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'date',
            type: 'date',
            isNullable: false,
          },
          {
            name: 'provider',
            type: 'varchar',
            length: '50',
            isNullable: false,
            comment: 'openai, anthropic, groq, gemini',
          },
          {
            name: 'model',
            type: 'varchar',
            length: '100',
            isNullable: false,
          },
          {
            name: 'messages_processed',
            type: 'integer',
            default: 0,
          },
          {
            name: 'tokens_input',
            type: 'integer',
            default: 0,
          },
          {
            name: 'tokens_output',
            type: 'integer',
            default: 0,
          },
          {
            name: 'tokens_total',
            type: 'integer',
            default: 0,
          },
          {
            name: 'cost_usd',
            type: 'decimal',
            precision: 10,
            scale: 4,
            default: 0,
          },
          {
            name: 'avg_latency_ms',
            type: 'integer',
            default: 0,
            comment: 'Average processing time in milliseconds',
          },
          {
            name: 'success_count',
            type: 'integer',
            default: 0,
          },
          {
            name: 'error_count',
            type: 'integer',
            default: 0,
          },
          {
            name: 'success_rate',
            type: 'decimal',
            precision: 5,
            scale: 2,
            default: 0,
            comment: 'Percentage (0-100)',
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'ai_usage_metrics',
      new TableIndex({
        name: 'IDX_ai_metrics_tenant_date',
        columnNames: ['tenant_id', 'date'],
      }),
    );

    await queryRunner.createIndex(
      'ai_usage_metrics',
      new TableIndex({
        name: 'IDX_ai_metrics_provider',
        columnNames: ['provider'],
      }),
    );

    await queryRunner.createIndex(
      'ai_usage_metrics',
      new TableIndex({
        name: 'IDX_ai_metrics_date',
        columnNames: ['date'],
      }),
    );

    // Create unique constraint for tenant + date + provider + model
    await queryRunner.createIndex(
      'ai_usage_metrics',
      new TableIndex({
        name: 'UQ_ai_metrics_tenant_date_provider_model',
        columnNames: ['tenant_id', 'date', 'provider', 'model'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ai_usage_metrics');
  }
}
