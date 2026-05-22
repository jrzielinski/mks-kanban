import Anthropic from '@anthropic-ai/sdk';
import { getProviderKey } from '../../../config/credentials';
import type { ContentBlock, ProviderResponse, StreamChunk } from '../providers';
import { CatalogEntry, DirectCallParams, PROVIDER_DEFAULT_BASE_URL } from './types';

function effortToMaxTokens(effort: string | undefined, cap: number): number {
  const base = cap || 8192;
  switch (effort) {
    case 'low': return Math.min(base, 2000);
    case 'high': return Math.min(base * 2, cap || base);
    case 'max': return cap || base;
    case 'medium':
    default: return Math.min(base, cap || base);
  }
}

function effortToTemperature(effort: string | undefined, baseTemp = 0.7): number {
  switch (effort) {
    case 'low': return 0.2;
    case 'high': return Math.min(1.0, baseTemp + 0.1);
    case 'max': return Math.min(1.0, baseTemp + 0.2);
    case 'medium':
    default: return baseTemp;
  }
}

/**
 * Normalize whatever message shape the REPL history carries into what
 * Anthropic's API accepts. Key concerns:
 *
 *  - Extended thinking: when a stored assistant message carries
 *    `reasoning_content` (+ optional `thinking_signature`), expand it
 *    into an array with a leading `{type:'thinking', thinking, signature}`
 *    block. Claude rejects assistant messages that don't replay the
 *    signature it issued on the previous turn — we can't drop it.
 *  - Tool calls: if the stored message uses OpenAI-style `tool_calls`,
 *    convert each into an Anthropic `{type:'tool_use', id, name, input}`
 *    block. Sibling text becomes a `{type:'text'}` block.
 *  - Tool results: `role: 'tool'` messages come from the REPL in
 *    OpenAI shape (`tool_call_id` + stringified content). Anthropic
 *    expects `role: 'user'` with a `{type:'tool_result', tool_use_id,
 *    content}` block — rewrite.
 *  - Plain string content stays plain.
 */
function convertMessages(messages: any[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    // Tool-result messages (OpenAI shape) → Anthropic tool_result block.
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }],
      });
      continue;
    }

    // Assistant with reasoning and/or tool_calls → build an Anthropic
    // content array. Ordering matters: thinking FIRST, then text, then
    // tool_use blocks — same order Claude emitted them, required for
    // signature verification to pass.
    if (m.role === 'assistant') {
      const needsArray =
        m.reasoning_content ||
        (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) ||
        Array.isArray(m.content);

      if (needsArray) {
        const blocks: any[] = [];
        if (m.reasoning_content) {
          const thinkingBlock: any = {
            type: 'thinking',
            thinking: String(m.reasoning_content),
          };
          if (m.thinking_signature) thinkingBlock.signature = m.thinking_signature;
          blocks.push(thinkingBlock);
        }
        if (typeof m.content === 'string' && m.content.length > 0) {
          blocks.push({ type: 'text', text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) blocks.push(b);
        }
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            let input: any = {};
            try {
              input = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || {};
            } catch { input = {}; }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
          }
        }
        out.push({ role: 'assistant', content: blocks });
        continue;
      }

      if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content });
        continue;
      }
      out.push(m);
      continue;
    }

    // User messages: array content (images + text) passes through; strings stay strings.
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    out.push(m);
  }
  return out;
}

export class AnthropicDirectProvider {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  readonly baseURL: string;
  readonly maxOutputTokens: number;

  constructor(entry: CatalogEntry) {
    this.model = entry.model;
    this.baseURL = entry.baseURL || PROVIDER_DEFAULT_BASE_URL.anthropic;
    this.maxOutputTokens = entry.maxOutputTokens || 8192;
  }

  private client(): Anthropic {
    // Pass baseURL — same disambiguation as direct-openai.
    const key = getProviderKey('anthropic', this.baseURL);
    if (!key) throw new Error(`Missing API key for provider 'anthropic'`);
    return new Anthropic({ apiKey: key, baseURL: this.baseURL });
  }

  async send(params: DirectCallParams): Promise<ProviderResponse> {
    const client = this.client();
    const body: any = {
      model: this.model,
      max_tokens: params.maxTokens || effortToMaxTokens(params.effort, this.maxOutputTokens),
      temperature: effortToTemperature(params.effort),
      messages: convertMessages(params.messages),
    };
    if (params.system) {
      body.system = [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }];
    }
    if (params.tools?.length) {
      body.tools = params.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || t.input_schema,
      }));
    }

    const res: any = await (client as any).messages.create(body, { signal: params.signal });

    const content: ContentBlock[] = [];
    for (const block of res.content || []) {
      if (block.type === 'thinking') {
        // Extended thinking block. `signature` is required on the next
        // request if the assistant message is replayed, so it travels
        // with the thinking text through our ContentBlock shape.
        content.push({
          type: 'thinking',
          thinking: block.thinking || '',
          signature: block.signature,
        });
      } else if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return {
      content,
      stopReason: res.stop_reason || 'stop',
      usage: {
        promptTokens: res.usage?.input_tokens || 0,
        completionTokens: res.usage?.output_tokens || 0,
        totalTokens: (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0),
        cacheReads: res.usage?.cache_read_input_tokens || 0,
        cacheWrites: res.usage?.cache_creation_input_tokens || 0,
      },
    };
  }

  async *stream(params: DirectCallParams): AsyncGenerator<StreamChunk, void, unknown> {
    yield { type: 'start', provider: this.provider, model: this.model };
    let client: Anthropic;
    try { client = this.client(); }
    catch (err: any) {
      yield { type: 'error', error: err.message };
      yield { type: 'end' };
      return;
    }

    const body: any = {
      model: this.model,
      max_tokens: params.maxTokens || effortToMaxTokens(params.effort, this.maxOutputTokens),
      temperature: effortToTemperature(params.effort),
      messages: convertMessages(params.messages),
      stream: true,
    };
    if (params.system) {
      body.system = [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }];
    }
    if (params.tools?.length) {
      body.tools = params.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || t.input_schema,
      }));
    }

    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
    let usage: any = null;
    let finishReason: string | undefined;

    try {
      const s = (client as any).messages.stream(body, { signal: params.signal });
      for await (const ev of s) {
        if (ev.type === 'content_block_start') {
          const block = ev.content_block;
          if (block?.type === 'tool_use') {
            toolAcc.set(ev.index, { id: block.id, name: block.name, args: '' });
          }
          // Thinking blocks have no payload at start — the text arrives
          // via thinking_delta events and the signature via
          // signature_delta (both handled below). No index tracking
          // needed because the chat layer concatenates thinking globally.
        } else if (ev.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
            yield { type: 'thinking_delta', thinking: delta.thinking };
          } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature.length > 0) {
            yield { type: 'thinking_signature', signature: delta.signature };
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const acc = toolAcc.get(ev.index);
            if (acc) acc.args += delta.partial_json;
          }
        } else if (ev.type === 'message_delta') {
          if (ev.usage) usage = { ...(usage || {}), ...ev.usage };
          if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
        } else if (ev.type === 'message_start') {
          if (ev.message?.usage) usage = { ...(usage || {}), ...ev.message.usage };
        }
      }
    } catch (err: any) {
      yield { type: 'error', error: err.message || String(err) };
      yield { type: 'end' };
      return;
    }

    for (const [, acc] of toolAcc) {
      if (!acc.name) continue;
      let input: any = {};
      try { input = acc.args ? JSON.parse(acc.args) : {}; } catch { input = {}; }
      yield { type: 'tool_use', id: acc.id, name: acc.name, input };
    }

    if (usage) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: usage.input_tokens || 0,
          completionTokens: usage.output_tokens || 0,
          totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          cacheReads: usage.cache_read_input_tokens || 0,
          cacheWrites: usage.cache_creation_input_tokens || 0,
        },
      };
    }
    yield { type: 'done', finishReason: finishReason || 'stop' };
    yield { type: 'end' };
  }
}
