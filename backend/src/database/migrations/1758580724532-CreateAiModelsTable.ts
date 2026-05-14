import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateAiModelsTable1758580724532 implements MigrationInterface {
  name = 'CreateAiModelsTable1758580724532';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'ai_models',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'provider',
            type: 'varchar',
            length: '50',
            isNullable: false,
          },
          {
            name: 'model_id',
            type: 'varchar',
            length: '100',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '200',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'context_window',
            type: 'integer',
            isNullable: true,
          },
          {
            name: 'max_tokens',
            type: 'integer',
            isNullable: true,
          },
          {
            name: 'input_cost_per_token',
            type: 'decimal',
            precision: 10,
            scale: 8,
            isNullable: true,
          },
          {
            name: 'output_cost_per_token',
            type: 'decimal',
            precision: 10,
            scale: 8,
            isNullable: true,
          },
          {
            name: 'is_active',
            type: 'boolean',
            default: true,
          },
          {
            name: 'is_deprecated',
            type: 'boolean',
            default: false,
          },
          {
            name: 'deprecated_reason',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'replacement_model_id',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'supports_vision',
            type: 'boolean',
            default: false,
          },
          {
            name: 'supports_function_calling',
            type: 'boolean',
            default: false,
          },
          {
            name: 'supports_streaming',
            type: 'boolean',
            default: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    // Create indexes
    await queryRunner.createIndex(
      'ai_models',
      new TableIndex({
        name: 'IDX_ai_models_provider',
        columnNames: ['provider']
      })
    );

    await queryRunner.createIndex(
      'ai_models',
      new TableIndex({
        name: 'IDX_ai_models_model_id',
        columnNames: ['model_id']
      })
    );

    await queryRunner.createIndex(
      'ai_models',
      new TableIndex({
        name: 'IDX_ai_models_provider_model',
        columnNames: ['provider', 'model_id']
      })
    );

    await queryRunner.createIndex(
      'ai_models',
      new TableIndex({
        name: 'IDX_ai_models_active',
        columnNames: ['is_active']
      })
    );

    /* Insert ALL Groq models (COMPLETE LIST FROM SCREENSHOT) */
    await queryRunner.query(`
      INSERT INTO ai_models (provider, model_id, name, description, context_window, max_tokens, is_active, supports_streaming, supports_function_calling) VALUES
      /* Production models */
      ('groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', '🟢 PRODUÇÃO - 128k context, rápido', 128000, 8192, true, true, true),
      ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', '🟢 PRODUÇÃO - 128k context, mais capaz', 128000, 8192, true, true, true),
      ('groq', 'whisper-large-v3', 'Whisper Large v3', '🟢 PRODUÇÃO - Speech to text', 128000, 4096, true, false, false),
      ('groq', 'whisper-large-v3-turbo', 'Whisper Large v3 Turbo', '🟢 PRODUÇÃO - Speech to text turbo', 128000, 4096, true, false, false),
      ('groq', 'groq/compound', 'Groq Compound', '🟢 PRODUÇÃO - Compound system', 128000, 8192, true, true, true),
      ('groq', 'groq/compound-mini', 'Groq Compound Mini', '🟢 PRODUÇÃO - Compound mini system', 128000, 8192, true, true, true),
      /* Preview models - evaluation only */
      ('groq', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick 17B', '🔶 PREVIEW - Evaluation only', 131072, 8192, false, true, true),
      ('groq', 'meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B', '🔶 PREVIEW - Evaluation only', 131072, 8192, false, true, true),
      ('groq', 'meta-llama/llama-prompt-guard-2-22m', 'Llama Prompt Guard 2 22M', '🔶 PREVIEW - Safety guard', 512, 512, false, false, false),
      ('groq', 'meta-llama/llama-prompt-guard-2-86m', 'Llama Prompt Guard 2 86M', '🔶 PREVIEW - Safety guard', 512, 512, false, false, false),
      ('groq', 'moonshot/kimi-k2-instruct-0905', 'Kimi K2 Instruct', '🔶 PREVIEW - Moonshot AI model', 262144, 16384, false, true, true),
      ('groq', 'playai-tts', 'PlayAI TTS', '🔶 PREVIEW - Text to speech', 8192, 8192, false, false, false),
      ('groq', 'playai-tts-arabic', 'PlayAI TTS Arabic', '🔶 PREVIEW - Text to speech Arabic', 8192, 8192, false, false, false),
      ('groq', 'qwen/qwen3-32b', 'Qwen 3 32B', '🔶 PREVIEW - Alibaba Cloud model', 131072, 40960, false, true, true);
    `);

    /* Insert OpenAI models (SEPTEMBER 2025 - LATEST) */
    await queryRunner.query(`
      INSERT INTO ai_models (provider, model_id, name, description, context_window, max_tokens, is_active, supports_vision, supports_function_calling, supports_streaming) VALUES
      ('openai', 'gpt-5', 'GPT-5', '🟢 NOVO 2025 - Modelo mais avançado, padrão no ChatGPT', 1000000, 8192, true, true, true, true),
      ('openai', 'gpt-5-pro', 'GPT-5 Pro', '🟢 NOVO 2025 - Máxima qualidade e capacidade', 1000000, 8192, true, true, true, true),
      ('openai', 'gpt-4.1', 'GPT-4.1', '🟢 NOVO 2025 - Superior ao GPT-4o', 1000000, 8192, true, true, true, true),
      ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', '🟢 NOVO 2025 - Versão econômica 4.1', 1000000, 8192, true, true, true, true),
      ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', '🟢 NOVO 2025 - Ultra econômico', 1000000, 8192, true, true, true, true),
      ('openai', 'o3', 'OpenAI o3', '🟢 NOVO 2025 - Raciocínio avançado', 128000, 4096, true, true, true, false),
      ('openai', 'o3-pro', 'OpenAI o3 Pro', '🟢 NOVO 2025 - Máximo raciocínio', 128000, 4096, true, true, true, false),
      ('openai', 'o4-mini', 'OpenAI o4 Mini', '🟢 NOVO 2025 - Raciocínio rápido e econômico', 128000, 4096, true, true, true, false),
      ('openai', 'gpt-4o', 'GPT-4o', 'Modelo anterior (2024)', 128000, 4096, false, true, true, true),
      ('openai', 'gpt-4o-mini', 'GPT-4o Mini', 'Modelo anterior (2024)', 128000, 4096, false, true, true, true);
    `);

    /* Insert Anthropic models (SEPTEMBER 2025 - LATEST) */
    await queryRunner.query(`
      INSERT INTO ai_models (provider, model_id, name, description, context_window, max_tokens, is_active, supports_vision, supports_function_calling, supports_streaming) VALUES
      ('anthropic', 'claude-4-opus', 'Claude 4 Opus', '🟢 NOVO 2025 - Modelo mais inteligente e capaz', 200000, 8192, true, true, true, true),
      ('anthropic', 'claude-4-opus-4.1', 'Claude Opus 4.1', '🟢 NOVO 2025 - Raciocínio complexo e coding avançado', 200000, 8192, true, true, true, true),
      ('anthropic', 'claude-4-sonnet', 'Claude 4 Sonnet', '🟢 NOVO 2025 - Performance prática e coding', 200000, 8192, true, true, true, true),
      ('anthropic', 'claude-3-5-sonnet-20241222', 'Claude 3.5 Sonnet (Dec 2024)', '🔶 ATUALIZADO - Melhorado em coding', 200000, 4096, true, true, true, true),
      ('anthropic', 'claude-3-5-haiku', 'Claude 3.5 Haiku', '🟢 NOVO 2024 - Rápido e superou Claude 3 Opus', 200000, 4096, true, true, true, true),
      ('anthropic', 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet (Oct 2024)', 'Versão anterior', 200000, 4096, false, true, true, true),
      ('anthropic', 'claude-3-opus-20240229', 'Claude 3 Opus', 'Modelo anterior (2024)', 200000, 4096, false, true, true, true);
    `);

    // Insert Google models
    await queryRunner.query(`
      INSERT INTO ai_models (provider, model_id, name, description, context_window, max_tokens, is_active, supports_vision, supports_function_calling, supports_streaming) VALUES
      ('google', 'gemini-1.5-pro', 'Gemini 1.5 Pro', 'Modelo Pro atualizado', 2000000, 8192, true, true, true, true),
      ('google', 'gemini-1.5-flash', 'Gemini 1.5 Flash', 'Rápido e eficiente', 1000000, 8192, true, true, true, true),
      ('google', 'gemini-pro', 'Gemini Pro', 'Modelo balanceado', 30720, 2048, true, false, true, true);
    `);

    // Insert other providers
    await queryRunner.query(`
      INSERT INTO ai_models (provider, model_id, name, description, context_window, max_tokens, is_active, supports_function_calling, supports_streaming) VALUES
      ('mistral', 'mistral-large', 'Mistral Large', 'Modelo mais poderoso', 128000, 4096, true, true, true),
      ('mistral', 'mistral-medium', 'Mistral Medium', 'Balanceado', 32768, 4096, true, true, true),
      ('mistral', 'mistral-small', 'Mistral Small', 'Rápido e econômico', 32768, 4096, true, true, true),
      ('mistral', 'codestral-latest', 'Codestral', 'Especializado em código', 32768, 4096, true, true, true),
      ('cohere', 'command-r-plus', 'Command R+', 'Modelo mais avançado', 128000, 4096, true, true, true),
      ('cohere', 'command-r', 'Command R', 'Modelo padrão', 128000, 4096, true, true, true),
      ('cohere', 'command', 'Command', 'Modelo base', 4096, 4096, true, true, true),
      ('cohere', 'command-light', 'Command Light', 'Modelo leve', 4096, 4096, true, true, true);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ai_models');
  }
}