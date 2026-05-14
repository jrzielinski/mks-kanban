import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface CompletionOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string;
  private readonly defaultModel = 'claude-sonnet-4-6';

  constructor(private readonly cfg: ConfigService) {
    this.apiKey = cfg.get<string>('ANTHROPIC_API_KEY') || '';
  }

  async complete(
    messages: Message[],
    opts: CompletionOptions = {},
  ): Promise<string> {
    const {
      model = this.defaultModel,
      maxTokens = 4096,
      systemPrompt,
    } = opts;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
    };
    if (systemPrompt) body.system = systemPrompt;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Anthropic API error: ${res.status} ${err}`);
      throw new Error(`AI request failed: ${res.status}`);
    }

    const data = (await res.json()) as { content: Array<{ text: string }> };
    return data.content[0]?.text ?? '';
  }
}
