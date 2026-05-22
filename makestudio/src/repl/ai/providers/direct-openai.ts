import type { DirectProviderName } from '../../../config/credentials';
import { getProviderKey } from '../../../config/credentials';
import type { ContentBlock, ProviderResponse, StreamChunk } from '../providers';
import {
  CatalogEntry,
  DirectCallParams,
  PROVIDER_DEFAULT_BASE_URL,
} from './types';

import { swallow } from '../../../utils/log';
function effortToMaxTokens(effort: string | undefined, cap: number): number {
  const base = cap || 4096;
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

function buildOpenAIMessages(system: string, messages: any[]): any[] {
  const out: any[] = [];
  const hasSystem = messages.some((m) => m.role === 'system');
  if (system && !hasSystem) out.push({ role: 'system', content: system });
  for (const m of messages) out.push(m);
  return out;
}

function buildOpenAITools(tools: any[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function extractContentFromChoice(choice: any): ContentBlock[] {
  const content: ContentBlock[] = [];
  const msg = choice?.message || {};
  // Reasoning-model chain-of-thought (DeepSeek R1, Qwen QwQ, etc). Emitted
  // BEFORE the visible text so downstream UIs can render it collapsed
  // above the answer. Missing on plain-chat responses — only reasoning
  // models populate this field.
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(msg.reasoning_content) });
  }
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input: any = {};
      try {
        input = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || {};
      } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
  }
  return content;
}

export class OpenAICompatProvider {
  readonly provider: DirectProviderName;
  readonly model: string;
  readonly baseURL: string;
  readonly maxOutputTokens: number;

  constructor(entry: CatalogEntry) {
    this.provider = entry.provider;
    this.model = entry.model;
    this.baseURL = entry.baseURL || PROVIDER_DEFAULT_BASE_URL[entry.provider];
    this.maxOutputTokens = entry.maxOutputTokens || 4096;
  }

  private headers(): Record<string, string> {
    // Pass baseURL so the lookup picks the key bound to THIS endpoint
    // (e.g. deepseek vs openai both with provider='openai').
    const key = getProviderKey(this.provider, this.baseURL);
    if (!key) throw new Error(`Missing API key for provider '${this.provider}'`);
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    };
  }

  async send(params: DirectCallParams): Promise<ProviderResponse> {
    const body: any = {
      model: this.model,
      messages: buildOpenAIMessages(params.system, params.messages),
      temperature: effortToTemperature(params.effort),
      max_tokens: params.maxTokens || effortToMaxTokens(params.effort, this.maxOutputTokens),
    };
    const tools = buildOpenAITools(params.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await (globalThis as any).fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${this.provider} HTTP ${res.status}: ${txt.slice(0, 400)}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0] || {};
    const usage = data.usage || {};
    return {
      content: extractContentFromChoice(choice),
      stopReason: choice.finish_reason || 'stop',
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        cacheReads: usage.prompt_tokens_details?.cached_tokens || 0,
      },
    };
  }

  async *stream(params: DirectCallParams): AsyncGenerator<StreamChunk, void, unknown> {
    const body: any = {
      model: this.model,
      messages: buildOpenAIMessages(params.system, params.messages),
      temperature: effortToTemperature(params.effort),
      max_tokens: params.maxTokens || effortToMaxTokens(params.effort, this.maxOutputTokens),
      stream: true,
      stream_options: { include_usage: true },
    };
    const tools = buildOpenAITools(params.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    // Forensic snapshot of what we're about to ship — without this, when a
    // user reports "the model thinks forever after the tool", we have no
    // way to see whether reasoning_content is sneaking back into the
    // history or whether some other field is triggering reasoning mode.
    // Truncated message bodies so the log doesn't balloon.
    try {
      const dbg = require('../../debug-log');
      const msgsSummary = body.messages.map((m: any) => {
        const out: any = { role: m.role };
        if (typeof m.content === 'string') out.content_len = m.content.length;
        if (Array.isArray(m.content)) out.content_blocks = m.content.length;
        if (m.reasoning_content !== undefined) out.has_reasoning = true;
        if (typeof m.reasoning_content === 'string') out.reasoning_len = m.reasoning_content.length;
        if (m.tool_calls) out.tool_calls = m.tool_calls.length;
        if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id).slice(0, 12);
        return out;
      });
      dbg.dbgInfo('openai_compat_stream_request', {
        provider: this.provider,
        model: this.model,
        baseURL: this.baseURL,
        msgs: msgsSummary,
        tools_count: tools?.length || 0,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
      });
    } catch (err) { swallow(err); }

    yield { type: 'start', provider: this.provider, model: this.model };

    let response: Response;
    try {
      response = await (globalThis as any).fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err: any) {
      yield { type: 'error', error: err.message || String(err) };
      yield { type: 'end' };
      return;
    }
    if (!response.ok || !response.body) {
      const txt = await response.text().catch(() => '');
      yield { type: 'error', error: `${this.provider} HTTP ${response.status}: ${txt.slice(0, 400)}` };
      yield { type: 'end' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
    let finishReason: string | undefined;
    let usage: any = null;
    const streamStart = Date.now();
    let firstChunkLogged = false;

    // Idle-watchdog: small models (DeepSeek-Flash) sometimes loop in
    // thinking tokens after a tool error and never emit `[DONE]`. Without
    // a timeout the turn hangs forever — `turnInflight` stays true in the
    // Electron main and silently rejects every subsequent submit. 90s of
    // total silence (no chunk at all) is way longer than any legitimate
    // server-side think; abort on hit so the upper loop can retry/recover.
    const IDLE_TIMEOUT_MS = 90_000;

    while (true) {
      let chunk: { done: boolean; value?: Uint8Array };
      let idleTimer: NodeJS.Timeout | null = null;
      try {
        const idlePromise = new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            try { reader.cancel('idle-timeout').catch(() => { /* */ }); } catch (err) { swallow(err); }
            reject(new Error(`stream idle for ${IDLE_TIMEOUT_MS}ms — provider stopped sending chunks`));
          }, IDLE_TIMEOUT_MS);
          try { (idleTimer as any).unref?.(); } catch (err) { swallow(err); }
        });
        try {
          chunk = await Promise.race([reader.read(), idlePromise]);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      } catch (err: any) {
        yield { type: 'error', error: err.message || String(err) };
        break;
      }
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        try { require('../../debug-log').dbgInfo('stream_first_chunk', { provider: this.provider, model: this.model, elapsedMs: Date.now() - streamStart }); } catch (err) { swallow(err); }
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const ev of events) {
        for (const line of ev.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let parsed: any;
          try { parsed = JSON.parse(payload); } catch { continue; }

          const choice = parsed.choices?.[0];
          if (choice) {
            const delta = choice.delta || {};
            // DeepSeek R1 and similar OpenAI-compatible reasoning models
            // stream chain-of-thought in `reasoning_content` before the
            // visible answer begins. Emit it as a distinct chunk so the
            // UI can render it separately from the response body.
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
              yield { type: 'thinking_delta', thinking: delta.reasoning_content };
            }
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { type: 'text_delta', text: delta.content };
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                const acc = toolAcc.get(idx) || { args: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
                toolAcc.set(idx, acc);
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
          if (parsed.usage) usage = parsed.usage;
        }
      }
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
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          cacheReads: usage.prompt_tokens_details?.cached_tokens || 0,
        },
      };
    }
    yield { type: 'done', finishReason: finishReason || 'stop' };
    yield { type: 'end' };
  }
}
