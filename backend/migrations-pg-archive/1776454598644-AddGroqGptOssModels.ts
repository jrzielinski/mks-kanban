import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGroqGptOssModels1776454598644 implements MigrationInterface {
  name = 'AddGroqGptOssModels1776454598644';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add GPT OSS models (production) and activate Llama 4 Scout + Qwen3 32B
    // which are now listed on Groq's LLMs production page.
    await queryRunner.query(`
      INSERT INTO ai_models (provider, model_id, name, description, context_window, max_tokens, is_active, supports_streaming, supports_function_calling) VALUES
      ('groq', 'openai/gpt-oss-20b',           'GPT OSS 20B',            'PRODUCAO - 128k context, 1000 TPS',  128000, 8192, true, true, true),
      ('groq', 'openai/gpt-oss-safeguard-20b', 'GPT OSS Safeguard 20B',  'PRODUCAO - Safety-aligned 20B model', 128000, 8192, true, true, true),
      ('groq', 'openai/gpt-oss-120b',          'GPT OSS 120B',           'PRODUCAO - 128k context, 500 TPS',   128000, 8192, true, true, true)
      ON CONFLICT DO NOTHING;
    `);

    // Activate Llama 4 Scout + Qwen3 32B (previously flagged preview only)
    await queryRunner.query(`
      UPDATE ai_models
      SET is_active = true,
          description = REPLACE(description, 'PREVIEW', 'PRODUCAO')
      WHERE provider = 'groq'
        AND model_id IN ('meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM ai_models
      WHERE provider = 'groq'
        AND model_id IN (
          'openai/gpt-oss-20b',
          'openai/gpt-oss-safeguard-20b',
          'openai/gpt-oss-120b'
        );
    `);
    await queryRunner.query(`
      UPDATE ai_models
      SET is_active = false,
          description = REPLACE(description, 'PRODUCAO', 'PREVIEW')
      WHERE provider = 'groq'
        AND model_id IN ('meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b');
    `);
  }
}
