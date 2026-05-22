import { swallow } from '../../utils/log';
/**
 * Recoverable provider stream errors.
 *
 * The streaming loop emits `chunk.type === 'error'` for many distinct
 * failure modes. Several of them are mechanical and can be auto-healed
 * by injecting a synthetic correction into the message history and
 * retrying the turn:
 *
 *   1. Bad tool name (Groq "attempted to call tool X" where X is not a real tool)
 *   2. Malformed JSON in tool arguments (Groq "Failed to parse … as JSON")
 *   2b. Schema validation failure (Groq "parameters did not match schema")
 *   3a. Vision not supported (provider rejects image blocks)
 *   3c. Reasoning-content round-trip rejection (DeepSeek "must be passed back")
 *   3b. Context-length exhaustion (NOT recoverable — surface and return)
 *
 * Anything else falls through; the caller surfaces the raw error.
 */

export interface RecoveryArgs {
  errText: string;
  ctx: any;
  chatMessages: any[];
  enrichedTools: any[];
  accumulatedText: string;
  buildAssistantMessage: (text: string | null, toolCalls?: any[]) => any;
  bridge: { addMessage: (m: any) => any; updateMessage: (id: string, patch: any) => void };
  msgId: string;
}

export type RecoveryOutcome = 'recovered' | 'fatal' | 'unhandled';

export async function recoverStreamError(args: RecoveryArgs): Promise<RecoveryOutcome> {
  const { errText, ctx, chatMessages, enrichedTools, accumulatedText, buildAssistantMessage, bridge, msgId } = args;

  // Recovery 1 — Bad tool name. Only fires when the name the
  // provider flagged is NOT in our actual tool list (i.e. a real
  // hallucinated / mis-cased name). Otherwise "attempted to call
  // tool Read …argument error…" falsely blamed Read itself.
  const badToolMatch = errText.match(/attempted to call tool ['"]?([A-Za-z0-9_.-]+)['"]?/i);
  if (badToolMatch) {
    const badName = badToolMatch[1]!;
    const validNames = new Set(enrichedTools.map((t: any) => t.name));
    if (!validNames.has(badName)) {
      const validList = [...validNames].join(', ');
      bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
      bridge.addMessage({
        role: 'info',
        text: `(provider rejected tool "${badName}" — not in valid tool list; injecting error and retrying)`,
      });
      chatMessages.push(buildAssistantMessage(accumulatedText || null));
      chatMessages.push({
        role: 'user',
        content: `The previous tool call failed: tool name "${badName}" is not valid. Valid tool names (case-sensitive, exact): ${validList}. Retry with the correct name.`,
      });
      return 'recovered';
    }
    // Name is valid → it's likely a bad-arguments error. Fall through.
  }

  // Recovery 2 — Malformed JSON in tool-call arguments. Groq emits
  // "Failed to parse tool call arguments as JSON" when the model
  // outputs truncated or malformed argument objects. Feed the
  // model a synthetic correction and retry the turn.
  const badJsonMatch = /parse tool call arguments as JSON|tool_call.*arguments.*(invalid|malformed|parse)/i.test(errText);
  if (badJsonMatch) {
    bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
    bridge.addMessage({
      role: 'info',
      text: '(provider rejected tool-call arguments — not valid JSON. Retrying with guidance.)',
    });
    chatMessages.push(buildAssistantMessage(accumulatedText || null));
    chatMessages.push({
      role: 'user',
      content:
        'Your previous tool call had invalid JSON in `arguments`. Rules: ' +
        '(1) all strings double-quoted and properly escaped; ' +
        '(2) no trailing commas; ' +
        '(3) no comments; ' +
        '(4) the whole `arguments` value is a single JSON object, not a fragment. ' +
        'Re-issue the tool call with well-formed JSON arguments and continue from where you left off.',
    });
    return 'recovered';
  }

  // Recovery 2b — Schema validation error.
  const schemaMatch = errText.match(/parameters for tool ['"]?([A-Za-z0-9_.-]+)['"]?.*(?:did not match schema|validation failed)/i);
  if (schemaMatch) {
    const toolName = schemaMatch[1]!;
    const missingMatch = errText.match(/missing (?:properties|property)[:\s]*\[?([^\]]+?)\]?(?:$|,|\.|\n)/i);
    const missingFields = missingMatch ? missingMatch[1]!.replace(/['"]/g, '').trim() : null;
    const toolDef = enrichedTools.find((t: any) => t.name === toolName);
    const required: string[] = toolDef?.input_schema?.required || [];
    const props: string[] = toolDef ? Object.keys(toolDef.input_schema?.properties || {}) : [];

    bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
    bridge.addMessage({
      role: 'info',
      text: `(provider rejected ${toolName} — schema mismatch${missingFields ? ' (missing ' + missingFields + ')' : ''}. Retrying with guidance.)`,
    });
    chatMessages.push(buildAssistantMessage(accumulatedText || null));
    chatMessages.push({
      role: 'user',
      content:
        `Your previous call to tool "${toolName}" failed schema validation` +
        (missingFields ? `: missing required field(s) ${missingFields}. ` : `. `) +
        (required.length ? `Required fields: ${required.join(', ')}. ` : '') +
        (props.length ? `All valid fields: ${props.join(', ')}. ` : '') +
        'Re-issue the tool call with ALL required fields filled in and continue from where you left off.',
    });
    return 'recovered';
  }

  // Recovery 3a — Vision not supported. Strip image blocks from
  // the in-flight history and retry transparently. No hardcoded
  // model names — works with any provider.
  if (!((ctx as any).__visionStrippedThisTurn) &&
      /unknown variant.*image|image.*not supported|does not support.*image|image_url|unsupported.*content.*type/i.test(errText)) {
    (ctx as any).__visionStrippedThisTurn = true;
    for (let mi = 0; mi < chatMessages.length; mi++) {
      const m: any = chatMessages[mi];
      if (Array.isArray(m.content)) {
        m.content = m.content.filter((b: any) => b.type !== 'image' && b.type !== 'image_url');
        if (m.content.length === 1 && m.content[0]?.type === 'text') {
          m.content = m.content[0].text;
        }
      }
    }
    bridge.updateMessage(msgId, { text: '', streaming: true });
    bridge.addMessage({ role: 'warn', text: '(provider does not support images — retrying without image blocks)' });
    return 'recovered';
  }

  // Recovery 3c — Reasoning-mode round-trip rejection. DeepSeek
  // (v4-flash, reasoner) and other thinking-mode providers 400 with:
  //   "The reasoning_content in the thinking mode must be passed
  //    back to the API."
  // The previous version of this recovery STRIPPED reasoning_content
  // — exactly the wrong direction. The provider is saying "I need
  // it ON every assistant message", not "I want it removed". Strip-
  // ping caused infinite retries and burned the user's session.
  //
  // Real fix: walk every assistant message in the conversation and
  // inject `reasoning_content: ''` (empty string) where the field
  // is missing. Empty string is accepted by the API — it just
  // signals "this turn had no chain-of-thought" — and satisfies the
  // "field must be present" check. We also heal ctx.messages so
  // the fix persists across future turns of this session.
  if (/reasoning_content|thinking[_\s-]?content|reasoning.*thinking.?mode|thinking.?mode.*reasoning/i.test(errText)) {
    // Two opposite failure modes share the same keyword:
    //   - REQUIRES the field (DeepSeek, Qwen): "reasoning_content must be passed back"
    //   - REJECTS the field (Groq Llama, etc): "property 'reasoning_content' is unsupported"
    // Match by the key signal — "unsupported" / "not allowed" → STRIP;
    // everything else falls through to the legacy ADD-empty path.
    const isUnsupported = /unsupported|not\s+allowed|not\s+supported|unknown\s+property|extra\s+field/i.test(errText);
    try {
      const dbg = require('../debug-log');
      dbg.dbgWarn('reasoning_recovery_3c_fired', {
        tries: (ctx as any).__reasoningRecoveryTries || 0,
        mode: isUnsupported ? 'strip' : 'inject',
        errText: errText.slice(0, 600),
        msgCount: chatMessages.length,
      });
    } catch (err) { swallow(err); }
    const triesSoFar = (ctx as any).__reasoningRecoveryTries || 0;
    if (triesSoFar >= 1) {
      // Already healed once and the provider STILL 400s with the
      // same error — that means something we can't fix from here
      // (different message shape issue, provider misconfig, etc).
      // Pop the current user msg from ctx.messages so the next
      // turn doesn't immediately re-encounter this state.
      if (ctx.messages.length > 0 && ctx.messages[ctx.messages.length - 1]?.role === 'user') {
        ctx.messages.pop();
      }
      bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
      bridge.addMessage({
        role: 'error',
        text:
          `Provider rejeitou shape de reasoning_content mesmo depois do healing. ` +
          `Resposta do provider: ${errText.slice(0, 200)}. ` +
          `Use /clear pra resetar, ou /model pra trocar de modelo.`,
      });
      return 'fatal';
    }
    (ctx as any).__reasoningRecoveryTries = triesSoFar + 1;

    // Heal the in-flight payload AND the persisted history. Two paths:
    //  - STRIP (provider says field is unsupported): delete reasoning_content
    //    + thinking_signature from every assistant message so the next call
    //    doesn't re-trigger the rejection.
    //  - INJECT (provider says field must be present): add empty string
    //    where missing.
    const healMessage = (m: any): void => {
      if (!m || typeof m !== 'object') return;
      if (m.role !== 'assistant') return;
      if (isUnsupported) {
        delete m.reasoning_content;
        delete m.thinking_signature;
      } else {
        if (typeof m.reasoning_content !== 'string') m.reasoning_content = '';
      }
    };
    for (const m of chatMessages) healMessage(m);
    for (const m of ctx.messages || []) healMessage(m);
    // Pin the strip-mode flag for the rest of the session so sanitize-
    // messages.ts doesn't re-inject reasoning_content on the next call.
    // Without this, sanitize would put the field back and we'd 400 again
    // immediately, looping until the retry budget is exhausted.
    if (isUnsupported) {
      (ctx as any).__skipReasoningRoundTrip = true;
    }

    bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
    return 'recovered';
  }

  // Recovery 3b — Context-length / token-limit exhaustion. Not
  // retryable by the model alone; surface a helpful message.
  if (/context.?length|too many tokens|token.?limit|maximum context/i.test(errText)) {
    bridge.updateMessage(msgId, { text: accumulatedText, streaming: false });
    bridge.addMessage({
      role: 'error',
      text: 'Context window exhausted. Run /compact, /clear, or switch to a model with a larger context via /model.',
    });
    return 'fatal';
  }

  return 'unhandled';
}
