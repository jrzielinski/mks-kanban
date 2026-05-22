/**
 * tool-limits.ts — size ceilings for tool results (port of Claude Code's
 * src/constants/toolLimits.ts).
 *
 * The LLM context budget is precious. A single `cat` on a 2MB file
 * without a limit nukes half the window. These constants back off
 * the size before results hit the message stream, so no single tool
 * call can blow the context.
 *
 * Applied at the junction point where the tool's string result is
 * appended to the conversation — see chat.ts where results are pushed
 * onto `chatMessages`.
 */

/** Per-result char cap before truncation/persistence kicks in. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Hard per-turn cap — sum of all tool_result chars in one assistant turn. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** Short summary rendered in compact UI (e.g. tool-row in the REPL). */
export const TOOL_SUMMARY_MAX_LENGTH = 50;

/** Approximate byte→token factor used when the real tokeniser isn't available. */
export const APPROX_BYTES_PER_TOKEN = 4;

/**
 * Truncate a tool result to `DEFAULT_MAX_RESULT_SIZE_CHARS`. Keeps head
 * (what the model was probably looking for) and adds a machine-readable
 * tail marker indicating how much was cut.
 */
export function clipToolResult(
  result: string,
  limit: number = DEFAULT_MAX_RESULT_SIZE_CHARS,
): string {
  if (result.length <= limit) return result;
  const cut = result.length - limit;
  const tail = `\n\n[tool-result truncated: ${cut.toLocaleString()} chars removed from the tail to fit the ${limit.toLocaleString()}-char per-tool budget. If you need the tail, re-run the tool with narrower parameters (offset/limit/glob) rather than re-reading the same call.]`;
  return result.slice(0, limit - tail.length) + tail;
}

/**
 * After a turn finishes, if the combined tool_result chars in this turn
 * exceeded the per-turn ceiling, replace the oldest results with a short
 * stub. We keep the most recent because that's what the model is reasoning
 * about. Returns the (possibly mutated) array.
 *
 * Claude Code has a more sophisticated policy (evict-largest); we start
 * with evict-oldest-until-fit which is simpler and already prevents the
 * worst case.
 */
export function capTurnToolResults(
  messages: Array<{ role: string; content: any; tool_call_id?: string }>,
  cap: number = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
): number {
  // Only tool-role messages count against the cap.
  const toolIdxs: number[] = [];
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const bodyLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    toolIdxs.push(i);
    total += bodyLen;
  }
  if (total <= cap) return 0;

  let dropped = 0;
  for (const idx of toolIdxs) {
    if (total <= cap) break;
    const m = messages[idx];
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const oldLen = body.length;
    m.content = `[earlier tool result (${oldLen.toLocaleString()} chars) evicted to keep this turn under the ${cap.toLocaleString()}-char per-turn budget. Re-run the tool if you still need the data.]`;
    total -= oldLen - (m.content as string).length;
    dropped++;
  }
  return dropped;
}
