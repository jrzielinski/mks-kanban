import { Injectable } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Compatibility shim — emulates the MultiProviderAiService response shape
// used throughout KanbanService so existing callers need no changes.
@Injectable()
export class MultiProviderAiService {
  constructor(private readonly ai: AiService) {}

  async chat(
    _apiConfig: unknown,
    messages: ChatMessage[],
  ): Promise<{ choices: Array<{ message: { content: string } }> }> {
    const system = messages.find((m) => m.role === 'system')?.content;
    const rest = messages.filter((m) => m.role !== 'system') as Array<{
      role: 'user' | 'assistant';
      content: string;
    }>;

    const content = await this.ai.complete(rest, { systemPrompt: system });
    return { choices: [{ message: { content } }] };
  }
}
