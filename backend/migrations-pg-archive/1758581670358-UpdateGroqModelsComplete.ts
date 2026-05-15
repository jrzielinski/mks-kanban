import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateGroqModelsComplete1758581670358 implements MigrationInterface {
  name = 'UpdateGroqModelsComplete1758581670358';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Remove old incomplete Groq models
    await queryRunner.query(`
      DELETE FROM ai_models WHERE provider = 'groq';
    `);

    // Insert ALL Groq models (COMPLETE LIST FROM SCREENSHOT)
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove all Groq models
    await queryRunner.query(`
      DELETE FROM ai_models WHERE provider = 'groq';
    `);
  }
}