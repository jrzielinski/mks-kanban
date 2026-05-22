/**
 * chat-utils.ts
 *
 * Pure helpers used by the chat loop, extracted from chat.ts so:
 *   1. The "god file" shrinks toward something maintainable.
 *   2. Each helper can be unit-tested in isolation (no ctx, no provider).
 *   3. Other modules (sanitize-messages, micro-compact, autoCompact paths)
 *      can import these without going through chat.ts.
 *
 * No IO. No ctx mutation. No provider calls. If you need any of those,
 * the function lives elsewhere.
 */

/** ~4 chars per token, OpenAI-style rough estimate. Safe for ASCII text. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Heuristic: a tool result is a failure when it's a JSON object with an `error` field. */
export function toolFailed(result: string): boolean {
  if (!result) return false;
  try {
    const p = JSON.parse(result);
    return !!(p && typeof p === 'object' && (p as any).error);
  } catch { return false; }
}

/**
 * Strip `{type: 'thinking'}` blocks from `content` arrays and their
 * `signature` fields. Also deletes top-level `reasoning_content` and
 * `thinking_signature`. Use this during reasoning-recovery — deleting
 * only the top-level fields leaves stale thinking+signature embedded
 * in the content array, which some providers still reject.
 *
 * MUTATES the input message object — same contract as the original
 * inline implementation. Callers that need immutability must copy first.
 */
export function stripThoughtLeaves(msg: any): void {
  delete (msg as any).reasoning_content;
  delete (msg as any).thinking_signature;
  if (Array.isArray(msg.content)) {
    msg.content = msg.content.filter((b: any) => b.type !== 'thinking');
    // Flatten to string when only one text block remains.
    if (msg.content.length === 1 && msg.content[0]?.type === 'text') {
      msg.content = msg.content[0].text;
    }
    // null is valid for assistant msgs that only made tool_calls.
    if (msg.content.length === 0) msg.content = null;
  }
}

/**
 * Hard-cap the messages array at MAX_MESSAGES, dropping the oldest. Used
 * as a backstop alongside the LLM-summary auto-compact: if the summary
 * call fails AND the array is still huge, this is the last line of
 * defence before the provider rejects the request as too big.
 */
export function compactMessages(messages: any[], maxMessages: number): any[] {
  if (messages.length <= maxMessages) return messages;
  return messages.slice(messages.length - maxMessages);
}

/**
 * Truncate a string to approximately `targetChars` but ALWAYS end at a newline
 * boundary so the model never sees malformed content (half a JSON object,
 * half a stack trace). Appends an explicit `[... truncated ...]` stub so
 * the model knows content was dropped. Port of Claude Code's SessionMemory
 * prompts.ts:298-324 line-boundary truncation pattern.
 *
 * Prefers to trim EXTRA below target when no nearby newline exists — better
 * to lose a few more chars than to break a line. When the string has zero
 * newlines, falls back to a hard slice.
 */
export function truncateAtLineBoundary(s: string, targetChars: number): string {
  if (s.length <= targetChars) return s;
  // Look backward from target for the first newline; accept up to 20% slack.
  const minAcceptable = Math.floor(targetChars * 0.8);
  let cut = -1;
  for (let i = targetChars; i >= minAcceptable; i--) {
    if (s.charCodeAt(i) === 0x0a) { cut = i; break; }
  }
  if (cut < 0) cut = targetChars; // no nearby newline → hard cut
  const kept = s.slice(0, cut);
  const droppedLines = s.slice(cut).split('\n').filter(Boolean).length;
  return `${kept}\n\n[... ${droppedLines} line(s) truncated — re-run the producing tool for the full output ...]`;
}

/**
 * Render an array of {role, content} into a plain transcript. Each
 * message is truncated to `maxPerMsg` chars to keep the eventual prompt
 * within budget. Used to build the input for compactSimple's LLM call.
 */
export function messagesToTranscript(msgs: any[], maxPerMsg: number = 1500): string {
  return msgs.map((m: any) => {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `[${m.role}]: ${body.substring(0, maxPerMsg)}`;
  }).join('\n\n');
}

/**
 * Strip the optional <analysis>…</analysis> scratchpad from a compact-
 * summary response and extract just the <summary>…</summary> body.
 * Falls back to the raw text when the tags are missing. Idempotent.
 */
export function formatCompactSummary(raw: string): string {
  // Strip <analysis> scratchpad; extract <summary> content
  let out = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const m = out.match(/<summary>([\s\S]*?)<\/summary>/);
  if (m) out = m[1].trim();
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Pull the assistant text out of an Anthropic-style chat response.
 * Concatenates every `{type: 'text', text}` block; ignores tool_use,
 * thinking, image blocks. Returns empty string when no text blocks exist.
 */
export function extractText(response: any): string {
  if (!response?.content || !Array.isArray(response.content)) return '';
  return response.content
    .filter((b: any) => b.type === 'text' && b.text)
    .map((b: any) => b.text)
    .join('');
}
