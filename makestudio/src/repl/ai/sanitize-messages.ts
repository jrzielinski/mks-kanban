/**
 * sanitize-messages.ts
 *
 * Defensive last-mile pass over the messages array immediately before
 * shipping it to the provider. Catches structural drift accumulated by
 * the various code paths that mutate `chatMessages` during a turn — the
 * LLM should never see a malformed history, regardless of which branch
 * of the tool loop produced it.
 *
 * What this guarantees about the returned array:
 *
 *   1. Every assistant message has a `reasoning_content` field (defaults
 *      to empty string). Some providers (deepseek, qwen) 400 when the
 *      field is absent; an empty string passes their presence check.
 *   2. `thinking_signature` is forwarded verbatim when present (required
 *      to round-trip thinking-mode replies).
 *   3. Assistant `tool_calls` are kept ONLY when followed by a tool
 *      result (or when the assistant message is the last in the array,
 *      i.e. the call is about to be executed). Orphaned tool_calls trigger
 *      a 400 "tool call did not return a tool result".
 *   4. Empty assistant messages — no content, no tool_calls, no
 *      reasoning_content — are dropped. Qwen3 specifically rejects them.
 *   5. Tool messages must carry `tool_call_id` to be paired with the
 *      originating call; missing → drop.
 *   6. `content === undefined` is coerced to `null` (valid for assistant
 *      messages whose only effect was a tool_call).
 *   7. Messages without a `role` are skipped (defensive — should never
 *      happen, but a single bad row would 400 the whole call).
 *
 * Pure function: input is not mutated. Returns a fresh array with cleaned
 * shallow-clone messages.
 */

export interface SanitizeOptions {
  /** Drop reasoning_content + thinking_signature from assistant messages.
   *  Set to true when the active provider 400s with "property
   *  reasoning_content is unsupported" (Groq Llama, OpenAI, Anthropic,
   *  etc). The streaming-error-recovery flips this on for the rest of
   *  the session via ctx.__skipReasoningField after detecting a strip-mode
   *  rejection — without that, every sanitize pass re-injects the empty
   *  string and the next call 400s again, looping forever. */
  stripReasoning?: boolean;
}

export function sanitizeMessagesForLLM(messages: any[], opts?: SanitizeOptions): any[] {
  const stripReasoning = opts?.stripReasoning === true;
  const out: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !m.role) continue;
    const clean: any = { role: m.role };
    // content can be string | array | null. null is valid for assistant
    // messages that only made tool_calls. Coerce undefined to null.
    clean.content = m.content === undefined ? null : m.content;
    if (m.role === 'assistant') {
      // Reasoning fields: ONLY forward when the upstream caller actually
      // populated reasoning_content. Previously we injected `''` whenever
      // the field was missing, but that empty value triggers DeepSeek-flash
      // to enter reasoning mode on the NEXT turn (the field's mere presence
      // is a "this conversation supports reasoning" signal). The CLI path
      // never set the field unless thinking happened — and the CLI is fast.
      // If a downstream provider 400s for missing reasoning_content, the
      // recovery in streaming-error-recovery.ts injects it on retry.
      if (!stripReasoning && typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) {
        clean.reasoning_content = m.reasoning_content;
        if (m.thinking_signature) clean.thinking_signature = m.thinking_signature;
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        // Look ahead — every tool_call must have a paired tool result OR
        // be the last message. Otherwise drop tool_calls so we don't ship
        // an orphan.
        const next = messages[i + 1];
        const isLast = i === messages.length - 1;
        const hasResult = next && next.role === 'tool';
        if (isLast || hasResult) {
          clean.tool_calls = m.tool_calls;
        }
      }
      const isEmpty = (clean.content === null || clean.content === '' ||
                       (Array.isArray(clean.content) && clean.content.length === 0))
        && !clean.tool_calls
        && !clean.reasoning_content;
      if (isEmpty) continue;
    } else if (m.role === 'tool') {
      if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;
      // Tool result with no tool_call_id is unusable — drop it.
      if (!clean.tool_call_id) continue;
    }
    out.push(clean);
  }
  return out;
}
