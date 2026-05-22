import { ProviderName } from '../context';
import { getApiClient } from '../../network/api-client';
import { ModelTier } from './providers/types';
import { selectProviderForTier } from './providers/factory';
import { getCatalogEntry } from './providers/catalog';
import { hasProviderKey } from '../../config/credentials';
import { recordUsage } from './usage-tracker';

import { swallow } from '../../utils/log';
export interface StreamChunk {
  /**
   *  - `thinking_delta`: reasoning-model chain-of-thought chunk (DeepSeek
   *    `reasoning_content`, Anthropic `thinking_delta`). Do NOT render in
   *    the main message body — the UI layer decides whether to show it in
   *    a collapsed panel.
   *  - `thinking_signature`: Anthropic only. Cryptographic signature
   *    emitted at the end of a thinking block. Must be preserved and
   *    replayed back to the API in the next request, or Claude rejects
   *    the thinking block as tampered.
   */
  type: 'start' | 'text_delta' | 'thinking_delta' | 'thinking_signature' | 'tool_use' | 'usage' | 'done' | 'error' | 'end';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: any;
  usage?: any;
  provider?: string;
  model?: string;
  error?: string;
  finishReason?: string;
}

export interface ChatProvider {
  name: string;
  available: boolean;
  sendMessage(params: {
    system: string;
    /** Optional: static half of the prompt (cacheable prefix). */
    systemStatic?: string;
    /** Optional: dynamic half (cwd/project/user/memory). */
    systemDynamic?: string;
    messages: any[];
    tools: any[];
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }): Promise<ProviderResponse>;
  /**
   * Chama a config auxiliar (role=fast) se existir. Retorna `null` quando
   * o backend não tem config fast cadastrada — caller decide o fallback
   * (tipicamente, reusar sendMessage no principal).
   */
  sendSmall?(params: {
    system: string;
    messages: any[];
    tools?: any[];
    effort?: 'low' | 'medium' | 'high' | 'max';
    signal?: AbortSignal;
  }): Promise<ProviderResponse | null>;
  streamMessage?(params: {
    system: string;
    systemStatic?: string;
    systemDynamic?: string;
    messages: any[];
    tools: any[];
    effort?: 'low' | 'medium' | 'high' | 'max';
    signal?: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown>;
  getInfo?(): Promise<{ provider: string; model: string; fastProvider?: string | null; fastModel?: string | null } | null>;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReads?: number;
    cacheWrites?: number;
  };
}

export interface ContentBlock {
  /**
   *  - `thinking`: chain-of-thought from a reasoning model. `thinking`
   *    holds the plain text. `signature` (Anthropic) is opaque and must
   *    be round-tripped verbatim on the next request so Claude can
   *    verify the thinking block wasn't tampered with. For
   *    OpenAI-compatible providers (DeepSeek R1, Qwen QwQ), `signature`
   *    is absent — the `thinking` text alone is enough to replay.
   */
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  thinking?: string;
  signature?: string;
}

/**
 * Backend-driven provider — uses whatever is configured as isDefault in the
 * ApiConfigs table on the server. Works with OpenAI, Groq, Anthropic, Google.
 * This is the PRIMARY provider — the REPL should always use what the backend
 * has configured, not hardcoded local API keys.
 */
class BackendProvider implements ChatProvider {
  name: string;
  available = true;

  constructor(name: ProviderName) {
    this.name = name;
  }

  async getInfo(): Promise<{ provider: string; model: string; fastProvider?: string | null; fastModel?: string | null } | null> {
    try {
      const api = getApiClient();
      const res = await api.post('/repl-chat/info', {}, { timeout: 10_000 });
      return {
        provider: res.data?.provider || 'unknown',
        model: res.data?.model || 'unknown',
        fastProvider: res.data?.fastProvider ?? null,
        fastModel: res.data?.fastModel ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Envia um turn pelo endpoint auxiliar `/repl-chat/small`. Se o backend
   * devolver `error: 'no_fast_config'` (ou qualquer erro de rede), retorna
   * null para o caller decidir o fallback. Formato de resposta idêntico
   * ao sendMessage — reusa o mesmo parser Form 0/1/2/3/4.
   */
  async sendSmall(params: {
    system: string;
    messages: any[];
    tools?: any[];
    effort?: 'low' | 'medium' | 'high' | 'max';
    signal?: AbortSignal;
  }): Promise<ProviderResponse | null> {
    const api = getApiClient();
    let res: any;
    try {
      res = await api.post(
        '/repl-chat/small',
        {
          system: params.system,
          messages: params.messages,
          tools: params.tools || [],
          effort: params.effort || 'low',
        },
        { timeout: 30_000 },
      );
    } catch {
      return null; // 404 (sem fast) ou erro de rede — caller cai no principal
    }
    const data = res.data;
    if (!data || data.error === 'no_fast_config' || (!data.provider && !data.model)) {
      return null;
    }
    // Parser idêntico ao sendMessage (mesma normalização de 5 formatos).
    // Reutilizável: chama o método interno parseBackendResponse abaixo.
    return this.parseBackendResponse(data);
  }

  private parseBackendResponse(data: any): ProviderResponse {
    const content: ContentBlock[] = [];
    let stopReason = data.stopReason || data.finishReason || 'stop';

    if (typeof data.content === 'string' || Array.isArray(data.toolCalls)) {
      if (typeof data.content === 'string' && data.content.trim()) {
        content.push({ type: 'text', text: data.content });
      }
      if (Array.isArray(data.toolCalls)) {
        for (const tc of data.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || tc.input || {} });
        }
      }
      return { content, stopReason: data.finishReason || 'stop' };
    }
    if (Array.isArray(data.choices) && data.choices.length > 0) {
      const msg = data.choices[0].message || {};
      stopReason = data.choices[0].finish_reason || stopReason;
      if (msg.content) content.push({ type: 'text', text: String(msg.content) });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input: any = {};
          try {
            input = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
          } catch { input = {}; }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
        }
      }
    } else if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    } else if (data.message) {
      if (data.message.content) content.push({ type: 'text', text: String(data.message.content) });
    } else if (typeof data.text === 'string') {
      content.push({ type: 'text', text: data.text });
    } else if (typeof data.response === 'string') {
      content.push({ type: 'text', text: data.response });
    }

    const rawUsage = data.usage || {};
    const cacheReads = rawUsage.cache_read_input_tokens || rawUsage.prompt_tokens_details?.cached_tokens || 0;
    const cacheWrites = rawUsage.cache_creation_input_tokens || 0;
    // Anthropic returns input_tokens as ONLY the fresh (non-cached) input —
    // cache_read and cache_creation are separate. To represent the actual
    // input volume that flowed to the model (what the dashboard shows as
    // "Input Cache hit + Cache miss"), sum all three. OpenAI/DeepSeek
    // (`prompt_tokens`) already include cached tokens, so we use the
    // raw value for those.
    const isAnthropicShape = rawUsage.input_tokens !== undefined && rawUsage.prompt_tokens === undefined;
    const promptTokens = isAnthropicShape
      ? (rawUsage.input_tokens || 0) + cacheReads + cacheWrites
      : (rawUsage.prompt_tokens || 0);
    const completionTokens = rawUsage.completion_tokens || rawUsage.output_tokens || 0;
    const usage = {
      promptTokens,
      completionTokens,
      totalTokens: rawUsage.total_tokens || (promptTokens + completionTokens),
      cacheReads,
      cacheWrites,
    };
    return { content, stopReason, usage };
  }

  async sendMessage(params: {
    system: string;
    systemStatic?: string;
    systemDynamic?: string;
    messages: any[];
    tools: any[];
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }): Promise<ProviderResponse> {
    const api = getApiClient();

    const messages = params.messages.map((m) => m);

    // Retry policy — matches Claude Code's withRetry.ts:52-56, 530-548.
    // Changes from the old 3-attempt / 2^attempt-seconds scheme:
    //   - 10 attempts (Claude's DEFAULT_MAX_RETRIES) vs 3
    //   - Base 500ms (not 1s) with 25% jitter per attempt
    //   - Cap at 32s (maxDelayMs) so we never sleep a minute between tries
    //   - Honour Retry-After header when provider sends it
    //   - Don't retry 4xx (auth/bad-request) — only 5xx + transient net
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 32_000;
    let lastError: any;
    let res: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        res = await api.post(
          '/repl-chat',
          {
            system: params.system,
            // Optional hints for prompt-cache-aware providers. Backend
            // that recognises them emits the static block with
            // cache_control; backend that doesn't simply ignores them
            // (body.system still carries the full concatenated prompt).
            systemStatic: params.systemStatic,
            systemDynamic: params.systemDynamic,
            messages,
            tools: params.tools,
            cacheSystem: true,
            effort: params.effort,
          },
          { timeout: 120_000 },
        );
        break; // success
      } catch (err: any) {
        lastError = err;
        const status = err.response?.status;
        const code = err.code;
        // Rate-limit / transient detection. The backend often swallows the
        // upstream 429 and re-throws with a different status (500 from a
        // NestJS exception filter, or the raw provider message), so the
        // status code alone isn't reliable. We also scan err.message for
        // tell-tale strings.
        const msg: string = String(err.message || err.response?.data?.message || '');
        const looksLikeRateLimit =
          /\b429\b/.test(msg) ||
          /rate.?limit/i.test(msg) ||
          /tokens per min/i.test(msg) ||
          /quota/i.test(msg);
        const isRetryable =
          status === 429 || status === 529 ||
          (status && status >= 500 && status < 600) ||
          code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' ||
          code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
          err.message?.includes('timeout') ||
          looksLikeRateLimit;

        if (!isRetryable || attempt === MAX_RETRIES) {
          // Telemetry so /stats can show retry exhaustion.
          try { require('../../utils/events').recordEvent('api_retry_exhausted', { status, code, attempts: attempt + 1 }); } catch (err) { swallow(err); }
          throw err;
        }

        // Honour Retry-After (seconds OR HTTP-date) if the provider set one,
        // otherwise exponential backoff with jitter. Do NOT cap Retry-After
        // at MAX_DELAY_MS — that caused a 429 storm against rate-limited
        // providers that asked us to wait longer (stress test #9). Instead,
        // clamp at RETRY_AFTER_CEILING_MS (5 min) to protect liveness, and
        // abort retrying when the server asks for more than that.
        const RETRY_AFTER_CEILING_MS = 5 * 60 * 1000;
        const retryAfterHdr = err.response?.headers?.['retry-after'];
        let retryAfterMs = NaN;
        if (retryAfterHdr != null) {
          const asNum = Number(retryAfterHdr);
          if (Number.isFinite(asNum) && asNum >= 0) {
            retryAfterMs = asNum * 1000;
          } else {
            const asDate = Date.parse(String(retryAfterHdr));
            if (Number.isFinite(asDate)) retryAfterMs = Math.max(0, asDate - Date.now());
          }
        }
        // OpenAI-style in-body hint ("Please try again in 2.656s" or
        // "... in 1m30s"). Preferred over blind exponential backoff when
        // present — the provider is telling us exactly when quota resets.
        if (!Number.isFinite(retryAfterMs) && looksLikeRateLimit) {
          const m = msg.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i)
                 || msg.match(/in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i);
          if (m) {
            const n = parseFloat(m[1]);
            const unit = m[2].toLowerCase();
            const ms = unit === 'ms' ? n : unit === 'm' ? n * 60_000 : n * 1000;
            // Add 250ms padding so we don't hit the exact same window on retry.
            retryAfterMs = Math.max(0, ms + 250);
          }
        }
        if (Number.isFinite(retryAfterMs) && retryAfterMs > RETRY_AFTER_CEILING_MS) {
          try { require('../../utils/events').recordEvent('api_retry_exhausted', { status, code, attempts: attempt + 1, reason: 'retry_after_too_large', retryAfterMs }); } catch (err) { swallow(err); }
          throw err;
        }
        const baseBackoff = Math.min(Math.pow(2, attempt) * BASE_DELAY_MS, MAX_DELAY_MS);
        const jitter = Math.random() * 0.25 * baseBackoff;
        const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : baseBackoff + jitter;
        try { require('../../utils/events').recordEvent('api_retry', { status, code, attempt: attempt + 1, delayMs: Math.round(delayMs) }); } catch (err) { swallow(err); }
        // User-visible notice so a silent multi-second pause doesn't look
        // like a freeze. Rate limits especially need this — OpenAI TPM
        // resets can take tens of seconds.
        try {
          const secs = (delayMs / 1000).toFixed(1);
          const reason = looksLikeRateLimit ? 'rate limit' : (status ? `http ${status}` : (code || 'network'));
          process.stderr.write(`  ! ${reason} — retrying in ${secs}s (attempt ${attempt + 2}/${MAX_RETRIES + 1})\n`);
        } catch (err) { swallow(err); }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!res) throw lastError;

    const data = res.data;

    // Normalize backend response to our ContentBlock format.
    // Backend (multi-provider) returns various shapes — unify them:
    //   OpenAI/Groq/Google: { choices: [{ message: { content, tool_calls } }] }
    //   Anthropic (legacy): { content: [{ type, text | tool_use }] }
    //   Direct chat:        { message: { content, tool_calls } }
    const content: ContentBlock[] = [];
    let stopReason = data.stopReason || data.finishReason || 'stop';

    // Form 0: Backend chatWithTools shape: { content: string, toolCalls?: [], finishReason }
    if (typeof data.content === 'string' || Array.isArray(data.toolCalls)) {
      if (typeof data.content === 'string' && data.content.trim()) {
        content.push({ type: 'text', text: data.content });
      }
      if (Array.isArray(data.toolCalls)) {
        for (const tc of data.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments || tc.input || {},
          });
        }
      }
      return { content, stopReason: data.finishReason || 'stop' };
    }

    // Form 1: OpenAI-compatible choices array (Groq, OpenAI, Together, Google)
    if (Array.isArray(data.choices) && data.choices.length > 0) {
      const msg = data.choices[0].message || {};
      stopReason = data.choices[0].finish_reason || stopReason;
      if (msg.content) {
        content.push({ type: 'text', text: String(msg.content) });
      }
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
    }
    // Form 2: Anthropic-style content array
    else if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
    }
    // Form 3: Direct message object
    else if (data.message) {
      if (data.message.content) {
        content.push({ type: 'text', text: String(data.message.content) });
      }
      if (Array.isArray(data.message.tool_calls)) {
        for (const tc of data.message.tool_calls) {
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
    }
    // Form 4: plain text
    else if (typeof data.text === 'string') {
      content.push({ type: 'text', text: data.text });
    } else if (typeof data.response === 'string') {
      content.push({ type: 'text', text: data.response });
    }

    // Extract usage including cache stats for all provider shapes
    const rawUsage = data.usage || {};
    const cacheReads =
      rawUsage.cache_read_input_tokens ||                                    // Anthropic
      rawUsage.prompt_tokens_details?.cached_tokens ||                       // OpenAI
      0;
    const cacheWrites =
      rawUsage.cache_creation_input_tokens ||                                // Anthropic
      0;
    // Anthropic returns `input_tokens` as the FRESH-only input (cache hits
    // and writes are separate fields). OpenAI/DeepSeek's `prompt_tokens`
    // already includes cached tokens. Detect by which key is present and
    // sum the Anthropic case so promptTokens reflects the real input volume.
    const isAnthropicShape = rawUsage.input_tokens !== undefined && rawUsage.prompt_tokens === undefined;
    const promptTokens = isAnthropicShape
      ? (rawUsage.input_tokens || 0) + cacheReads + cacheWrites
      : (rawUsage.prompt_tokens || 0);
    const completionTokens = rawUsage.completion_tokens || rawUsage.output_tokens || 0;
    const usage = {
      promptTokens,
      completionTokens,
      totalTokens: rawUsage.total_tokens || (promptTokens + completionTokens),
      cacheReads,
      cacheWrites,
    };

    return { content, stopReason, usage };
  }

  async *streamMessage(params: {
    system: string;
    systemStatic?: string;
    systemDynamic?: string;
    messages: any[];
    tools: any[];
    effort?: 'low' | 'medium' | 'high' | 'max';
    signal?: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown> {
    const { loadConfig } = require('../../config/config');
    const config = loadConfig();
    const baseURL = config?.serverUrl || 'https://api.zielinski.dev.br';
    const token = config?.token;
    if (!token) { yield { type: 'error', error: 'Not authenticated' }; return; }

    // Use native fetch (Node 18+)
    const body = JSON.stringify({
      system: params.system,
      systemStatic: params.systemStatic,
      systemDynamic: params.systemDynamic,
      messages: params.messages,
      tools: params.tools,
      cacheSystem: true,
      effort: params.effort,
    });

    // Retry setup (mirrors sendMessage) — rate-limit aware so the TUI's
    // streaming path doesn't bail on the first 429. Only retries the
    // INITIAL connect/handshake; once chunks start arriving we commit.
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 32_000;
    const RETRY_AFTER_CEILING_MS = 5 * 60 * 1000;

    let response: Response | undefined;
    let lastErrMsg = '';
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let transport: any;
      try {
        response = await (globalThis as any).fetch(`${baseURL}/api/v1/repl-chat/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Accept': 'text/event-stream',
          },
          body,
          signal: params.signal,
        });
      } catch (err: any) {
        transport = err;
      }

      const okResponse = response && response.ok && response.body;
      if (okResponse) break;

      // Pull error details — body often carries the provider's raw 429 text.
      let status = response?.status;
      let bodyText = '';
      if (response && !response.ok) {
        try { bodyText = await response.text(); } catch (err) { swallow(err); }
      }
      const errMsg = transport?.message || bodyText || (status ? `HTTP ${status}` : 'stream failed');
      lastErrMsg = errMsg;

      const looksLikeRateLimit =
        /\b429\b/.test(errMsg) ||
        /rate.?limit/i.test(errMsg) ||
        /tokens per min/i.test(errMsg) ||
        /quota/i.test(errMsg);
      const code = transport?.code;
      const isRetryable =
        status === 429 || status === 529 ||
        (status && status >= 500 && status < 600) ||
        code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' ||
        code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
        errMsg.includes('timeout') ||
        looksLikeRateLimit;

      if (!isRetryable || attempt === MAX_RETRIES) {
        yield { type: 'error', error: errMsg };
        return;
      }

      // Honor in-body "try again in X.Xs|m|ms" from OpenAI-style errors.
      let retryAfterMs = NaN;
      const headerVal = response?.headers?.get?.('retry-after');
      if (headerVal != null) {
        const asNum = Number(headerVal);
        if (Number.isFinite(asNum) && asNum >= 0) retryAfterMs = asNum * 1000;
        else {
          const asDate = Date.parse(String(headerVal));
          if (Number.isFinite(asDate)) retryAfterMs = Math.max(0, asDate - Date.now());
        }
      }
      if (!Number.isFinite(retryAfterMs) && looksLikeRateLimit) {
        const m = errMsg.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i)
               || errMsg.match(/in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i);
        if (m) {
          const n = parseFloat(m[1]);
          const unit = m[2].toLowerCase();
          const ms = unit === 'ms' ? n : unit === 'm' ? n * 60_000 : n * 1000;
          retryAfterMs = Math.max(0, ms + 250);
        }
      }
      if (Number.isFinite(retryAfterMs) && retryAfterMs > RETRY_AFTER_CEILING_MS) {
        yield { type: 'error', error: errMsg };
        return;
      }

      const baseBackoff = Math.min(Math.pow(2, attempt) * BASE_DELAY_MS, MAX_DELAY_MS);
      const jitter = Math.random() * 0.25 * baseBackoff;
      const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : baseBackoff + jitter;
      try {
        const secs = (delayMs / 1000).toFixed(1);
        const reason = looksLikeRateLimit ? 'rate limit' : (status ? `http ${status}` : (code || 'network'));
        process.stderr.write(`  ! ${reason} — retrying in ${secs}s (attempt ${attempt + 2}/${MAX_RETRIES + 1})\n`);
      } catch (err) { swallow(err); }
      try { require('../../utils/events').recordEvent('api_retry', { status, code, attempt: attempt + 1, delayMs: Math.round(delayMs), stream: true }); } catch (err) { swallow(err); }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (!response || !response.ok || !response.body) {
      yield { type: 'error', error: lastErrMsg || `HTTP ${response?.status ?? 'unknown'}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // Idle timeout watchdog — port of Claude Code's streaming detection. If
    // no bytes arrive for STREAM_IDLE_TIMEOUT_MS the backend (or network)
    // almost certainly stalled; cancel the reader so the outer loop can
    // surface an error instead of hanging forever on a zombie connection.
    // Each successful read() call resets the timer.
    const STREAM_IDLE_TIMEOUT_MS = 45_000;
    /** Soft warning shown to the user when the stream goes quiet for a
     *  while but hasn't hit the hard timeout yet. The agent isn't frozen
     *  — the model is just thinking — but the user has zero feedback
     *  during this gap. Heartbeat re-arms on every chunk. */
    const STREAM_HEARTBEAT_MS = 8_000;
    let idleTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let lastChunkAt = Date.now();
    let stalled = false;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        try { reader.cancel('idle timeout'); } catch (err) { swallow(err); }
      }, STREAM_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };
    const armHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(function tick() {
        const elapsed = Math.round((Date.now() - lastChunkAt) / 1000);
        try {
          const { setTransientStatus } = require('../tui/bridge');
          setTransientStatus?.(`waiting on model · ${elapsed}s since last chunk · Esc Esc to interrupt`, 4000);
        } catch (err) { swallow(err); }
        // Re-arm so we keep ticking every heartbeat interval until a chunk
        // arrives (which calls armHeartbeat() again, resetting the cadence).
        heartbeatTimer = setTimeout(tick, STREAM_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
      }, STREAM_HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    };
    armIdle();
    armHeartbeat();

    try {
      while (true) {
        let readResult: { done: boolean; value: Uint8Array | undefined };
        try {
          readResult = await reader.read() as any;
        } catch (err: any) {
          if (stalled) {
            try { require('../../utils/events').recordEvent('stream_idle_timeout', { ms: STREAM_IDLE_TIMEOUT_MS }); } catch (err) { swallow(err); }
            yield { type: 'error', error: `stream stalled (no chunks for ${STREAM_IDLE_TIMEOUT_MS / 1000}s) — retry with /retry or refine the request` };
            return;
          }
          yield { type: 'error', error: err.message || String(err) };
          return;
        }
        const { done, value } = readResult;
        if (done) break;
        lastChunkAt = Date.now();
        armIdle();
        armHeartbeat();
        buffer += decoder.decode(value, { stream: true });

        // SSE events separated by \n\n
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const ev of events) {
          // Each event has lines like "data: {json}"
          const lines = ev.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const chunk = JSON.parse(jsonStr);
              yield chunk as StreamChunk;
              if (chunk.type === 'end') return;
            } catch (err) { swallow(err); }
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    }
  }
}

/**
 * REPL provider-name → model-tier mapping.
 *   /ai claude   → default  (main coding model)
 *   /ai codex    → fast     (faster/cheaper fallback)
 *   /ai gemini   → image    (vision-capable model)
 * The actual provider/model per tier comes from the catalog (fetched from
 * backend at start, editable via /model).
 */
const TIER_BY_NAME: Record<ProviderName, ModelTier> = {
  claude: 'default',
  codex: 'fast',
  gemini: 'image',
};

/**
 * DirectWithFallbackProvider: tries the direct call (user's own API key, no
 * backend hop). If no key is configured for the tier's provider, or the
 * direct call throws, it falls back transparently to the backend provider.
 * Streaming is mirrored through a generator so the caller sees the same
 * StreamChunk protocol regardless of path.
 */
class DirectWithFallbackProvider implements ChatProvider {
  name: string;
  available = true;
  private readonly tier: ModelTier;
  private readonly backend: BackendProvider;

  constructor(name: ProviderName) {
    this.name = name;
    this.tier = TIER_BY_NAME[name] || 'default';
    this.backend = new BackendProvider(name);
  }

  async getInfo(): Promise<{ provider: string; model: string } | null> {
    const entry = getCatalogEntry(this.tier);
    if (hasProviderKey(entry.provider, entry.baseURL)) {
      return { provider: entry.provider, model: entry.model };
    }
    return this.backend.getInfo();
  }

  async sendMessage(params: {
    system: string;
    messages: any[];
    tools: any[];
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }): Promise<ProviderResponse> {
    const selection = selectProviderForTier(this.tier);
    if (!selection) return this.backend.sendMessage(params);
    try {
      const resp = await selection.provider.send({
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        effort: params.effort,
        maxTokens: params.maxTokens,
      });
      recordUsage({
        provider: selection.entry.provider,
        model: selection.entry.model,
        tier: selection.tier,
        usage: resp.usage,
      });
      return resp;
    } catch {
      // Transparent fallback to backend on direct-call failure.
      return this.backend.sendMessage(params);
    }
  }

  async *streamMessage(params: {
    system: string;
    messages: any[];
    tools: any[];
    effort?: 'low' | 'medium' | 'high' | 'max';
    signal?: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown> {
    const selection = selectProviderForTier(this.tier);
    if (!selection) {
      try {
        require('../debug-log').dbgInfo('llm_path', { path: 'backend_proxy', reason: 'no_session_key_for_tier', tier: this.tier });
      } catch (err) { swallow(err); }
      yield* this.backend.streamMessage(params);
      return;
    }
    try {
      require('../debug-log').dbgInfo('llm_path', {
        path: 'direct',
        provider: selection.entry.provider,
        model: selection.entry.model,
        baseURL: selection.entry.baseURL,
      });
    } catch (err) { swallow(err); }

    // Fallback policy: once the session key is injected at login the agent
    // talks straight to the provider. Falling back to the backend proxy is
    // only useful for *transient* failures (network blip, 5xx, transport
    // reset) — for application-layer 4xx the request shape itself is the
    // problem and re-sending the same body through the backend just burns
    // a round-trip and confuses the recovery layer (the backend would
    // emit the SAME error). So we only fall back on:
    //   - transport errors (no HTTP status in the message), OR
    //   - 5xx / 408 / 429 status codes.
    // 400/401/403/404 are propagated to the caller untouched so chat.ts's
    // recovery 3c sees the real provider error.
    const isTransientError = (errText: string): boolean => {
      const m = errText.match(/HTTP\s+(\d{3})/);
      if (!m) return true; // no status → transport
      const status = parseInt(m[1]!, 10);
      return status >= 500 || status === 408 || status === 429;
    };

    let emitted = false;
    try {
      for await (const chunk of selection.provider.stream({
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        effort: params.effort,
        signal: params.signal,
      })) {
        if (chunk.type === 'error' && !emitted) {
          if (isTransientError(chunk.error || '')) {
            yield* this.backend.streamMessage(params);
            return;
          }
          // 4xx — propagate so the chat layer can apply the right recovery.
          yield chunk;
          return;
        }
        if (chunk.type === 'text_delta' || chunk.type === 'tool_use') emitted = true;
        if (chunk.type === 'usage') {
          recordUsage({
            provider: selection.entry.provider,
            model: selection.entry.model,
            tier: selection.tier,
            usage: chunk.usage,
          });
        }
        yield chunk;
      }
    } catch (err: any) {
      if (!emitted) {
        if (isTransientError(err?.message || String(err))) {
          yield* this.backend.streamMessage(params);
          return;
        }
        yield { type: 'error', error: err?.message || String(err) };
        return;
      }
      // Partial content already streamed — propagate end so caller can close.
      yield { type: 'end' };
    }
  }
}

const providers: Record<string, ChatProvider> = {
  claude: new DirectWithFallbackProvider('claude'),
  codex: new DirectWithFallbackProvider('codex'),
  gemini: new DirectWithFallbackProvider('gemini'),
};

export function getProvider(name: ProviderName): ChatProvider {
  return providers[name] || providers.claude;
}

export function isProviderAvailable(name: ProviderName): boolean {
  const p = providers[name];
  return p ? p.available : false;
}
