import { swallow } from '../../utils/log';
/**
 * Pre-flight sanitization passes that the chat loop runs over the
 * `chatMessages` array (a copy of ctx.messages, possibly compacted)
 * before sending it to the provider. Each helper is pure: takes an
 * array, returns a new array (or the same array unchanged).
 *
 * The composite `sanitizeHistoryForLLM` runs them in the canonical
 * order:
 *   1. Strip resume tail (if `ctx.justResumed`)
 *   2. Inject task-cancel signal between turns ending with tool_use
 *   3. Compress trailing user messages
 *   4. Normalize role alternation
 *   5. Append @-reference hint to the final user message
 */

function hasToolCallShape(m: any): boolean {
  return (
    (Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use'))
    || (typeof m.content === 'string' && m.content.includes('"type":"tool_use"'))
    || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
  );
}

const LOOP_KEEP_RECENT_MESSAGES = 8;
const LOOP_CLEARABLE_RESULT_TOOLS = new Set([
  'Read', 'read_file', 'Bash', 'shell_run', 'Grep',
  'WebFetch', 'web_fetch', 'ListFiles', 'list_files', 'LSP',
]);
const LOOP_AGGRESSIVE_RESULT_TOOLS = new Set(['Bash', 'shell_run', 'Grep']);

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return name;
  if (name === 'Read' || name === 'read_file') {
    return input.file_path || input.path || '<unknown file>';
  }
  if (name === 'Grep') {
    const pattern = input.pattern || '<pattern>';
    const path = input.path || input.glob || '<path>';
    return `${pattern} @ ${path}`;
  }
  if (name === 'Bash' || name === 'shell_run') {
    const cmd = String(input.command || input.cmd || '').replace(/\s+/g, ' ').trim();
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : (cmd || '<command>');
  }
  return name;
}

function trimToolInput(name: string, input: any): any {
  if (!input || typeof input !== 'object') return input;
  if (!LOOP_CLEARABLE_RESULT_TOOLS.has(name)) return input;
  if (name === 'Read' || name === 'read_file') {
    return { file_path: input.file_path || input.path, _omitted: `Older ${name} args omitted for tool-loop context compaction.` };
  }
  if (name === 'Grep') {
    return {
      pattern: input.pattern,
      path: input.path,
      glob: input.glob,
      _omitted: 'Older Grep args omitted for tool-loop context compaction.',
    };
  }
  if (name === 'Bash' || name === 'shell_run') {
    return {
      command: toolSummary(name, input),
      _omitted: `Older ${name} args omitted for tool-loop context compaction.`,
    };
  }
  return input;
}

function resultPlaceholder(name: string, summary: string, chars: number): string {
  return `[Older ${name} result omitted to save tool-loop context tokens. Target: ${summary}. Original result was ${chars.toLocaleString()} chars. Re-run the tool if you need the full output.]`;
}

interface ToolMeta {
  name: string;
  summary: string;
}

function buildToolMetaMap(chatMessages: any[]): Map<string, ToolMeta> {
  const meta = new Map<string, ToolMeta>();
  for (const m of chatMessages) {
    if (m?.role !== 'assistant') continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'tool_use' && block.id && block.name) {
          meta.set(block.id, { name: block.name, summary: toolSummary(block.name, block.input) });
        }
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const id = tc?.id;
        const name = tc?.function?.name || tc?.name;
        if (!id || !name) continue;
        let input: any = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (err) { swallow(err); }
        meta.set(id, { name, summary: toolSummary(name, input) });
      }
    }
  }
  return meta;
}

function shouldCompactOldResult(name: string, content: string): boolean {
  if (!LOOP_CLEARABLE_RESULT_TOOLS.has(name)) return false;
  const len = content.length;
  if (LOOP_AGGRESSIVE_RESULT_TOOLS.has(name)) return len > 120;
  return len > 400;
}

/**
 * Resume-tail strip: on the first turn after `-c`, find the last clean
 * assistant/tool message and drop everything after it (except the new
 * user message at the end). Handles two failure cases:
 *   A) Incomplete tool chain — session was killed mid-tool-call
 *   B) Accumulated failed user messages — N consecutive users with no reply
 *
 * Mutates `ctx.justResumed` (sets to false) and emits a debug-log event
 * when it strips. Otherwise non-mutating; returns a new array.
 */
export function stripResumeTail(chatMessages: any[], ctx: any): any[] {
  if (!(ctx as any).justResumed) return chatMessages;
  (ctx as any).justResumed = false;

  let cleanEndIdx = -1;
  for (let i = chatMessages.length - 2; i >= 0; i--) {
    const m = chatMessages[i];
    if (m.role === 'assistant' || m.role === 'tool') { cleanEndIdx = i; break; }
  }
  const tail = chatMessages.slice(cleanEndIdx + 1, chatMessages.length - 1);
  const tailHasToolCalls = tail.some(hasToolCallShape);
  const tailIsOnlyUsers = tail.length > 0 && tail.every((m: any) => m.role === 'user');
  if (!tailHasToolCalls && !tailIsOnlyUsers) return chatMessages;

  const stripped = [
    ...chatMessages.slice(0, cleanEndIdx + 1),
    chatMessages[chatMessages.length - 1],
  ];
  try {
    const dbg = require('../debug-log');
    dbg.dbgInfo('justResumed_strip', {
      stripped: tail.length,
      reason: tailHasToolCalls ? 'tool_chain' : 'accumulated_users',
    });
  } catch (err) { swallow(err); }
  return stripped;
}

/**
 * If the previous turn ended with tool_use blocks but no clean text reply,
 * inject a synthetic assistant message right before the new user message
 * so the model sees "previous work done, new task" and doesn't try to
 * continue the abandoned chain.
 */
export function injectCancelSignal(chatMessages: any[]): any[] {
  if (chatMessages.length < 3) return chatMessages;
  let prevUserIdx = -1;
  for (let i = chatMessages.length - 2; i >= 0; i--) {
    if (chatMessages[i].role === 'user') { prevUserIdx = i; break; }
  }
  if (prevUserIdx < 0) return chatMessages;
  const prevTurnMsgs = chatMessages.slice(prevUserIdx + 1, chatMessages.length - 1);
  const hadToolCalls = prevTurnMsgs.some(hasToolCallShape);
  const lastPrevMsg = prevTurnMsgs[prevTurnMsgs.length - 1];
  const endedClean = lastPrevMsg && lastPrevMsg.role === 'assistant' &&
    typeof lastPrevMsg.content === 'string' && lastPrevMsg.content.trim().length > 0 &&
    !(Array.isArray(lastPrevMsg.content) && lastPrevMsg.content.some((b: any) => b.type === 'tool_use'));
  if (!hadToolCalls || endedClean) return chatMessages;
  return [
    ...chatMessages.slice(0, chatMessages.length - 1),
    { role: 'assistant', content: '[Previous task interrupted. Awaiting new instruction.]' },
    chatMessages[chatMessages.length - 1],
  ];
}

/**
 * Trailing-user compression: if the array ends with multiple consecutive
 * user messages (3+, or 2 with identical content), drop all but the last.
 * Prevents the snowball of unanswered questions from confusing the model.
 * Only the TAIL is compressed — consecutive users in the middle of the
 * conversation are intentional multi-part messages.
 */
export function compressTrailingUsers(chatMessages: any[]): any[] {
  let lastNonUserIdx = -1;
  for (let i = chatMessages.length - 2; i >= 0; i--) {
    if (chatMessages[i].role !== 'user') { lastNonUserIdx = i; break; }
  }
  const trailingUsers = chatMessages.slice(lastNonUserIdx + 1);
  const shouldCompress = trailingUsers.length >= 3
    || (trailingUsers.length === 2 &&
        trailingUsers[0].content === trailingUsers[1].content);
  if (!shouldCompress) return chatMessages;
  return [
    ...chatMessages.slice(0, lastNonUserIdx + 1),
    chatMessages[chatMessages.length - 1],
  ];
}

/**
 * Insert a placeholder assistant message between any pair of consecutive
 * user messages so the LLM sees a strict user→assistant→user alternation.
 */
export function normalizeAlternation(chatMessages: any[]): any[] {
  const normalized: any[] = [];
  for (let i = 0; i < chatMessages.length; i++) {
    const cur = chatMessages[i];
    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === 'user' && cur.role === 'user') {
      normalized.push({ role: 'assistant', content: '[Previous request was not completed — session interrupted.]' });
    }
    normalized.push(cur);
  }
  return normalized;
}

/**
 * Append the @-reference resolution hint to the final user message.
 * Mutates the last message in place — sent-side only, ctx.messages stays
 * clean so session persistence doesn't dupe hints across compaction.
 */
export function appendAtReferenceHint(chatMessages: any[], input: string, cwd: string): void {
  try {
    const { buildAtReferenceHint } = require('./at-references');
    const hint = buildAtReferenceHint(input, cwd);
    if (hint && chatMessages.length > 0) {
      const last = chatMessages[chatMessages.length - 1];
      if (last.role === 'user' && typeof last.content === 'string') {
        last.content = last.content + hint;
      }
    }
  } catch (err) { swallow(err); }
}

/**
 * Run all sanitization passes in canonical order. Returns the cleaned
 * array. Use this from the chat loop instead of inlining the steps.
 */
export function sanitizeHistoryForLLM(
  chatMessages: any[],
  ctx: any,
  input: string,
): any[] {
  let out = chatMessages;
  try { out = stripResumeTail(out, ctx); } catch (err) { swallow(err); }
  try { out = injectCancelSignal(out); } catch (err) { swallow(err); }
  try { out = compressTrailingUsers(out); } catch (err) { swallow(err); }
  try { out = normalizeAlternation(out); } catch (err) { swallow(err); }
  appendAtReferenceHint(out, input, ctx.cwd);
  return out;
}

/**
 * Reduce history before each provider call inside a tool loop. The model
 * still needs the latest tool chain verbatim, but older Bash/Grep/Read
 * outputs dominate prompt tokens and are usually re-runnable.
 *
 * Policy:
 *   - keep the last LOOP_KEEP_RECENT_MESSAGES untouched
 *   - compact older clearable tool_result bodies to placeholders
 *   - trim bulky older tool_call arguments for clearable tools
 *
 * Pure transform: does not mutate the caller's array or nested objects.
 */
export function reduceHistoryForToolLoop(chatMessages: any[]): any[] {
  if (!Array.isArray(chatMessages) || chatMessages.length <= LOOP_KEEP_RECENT_MESSAGES) return chatMessages;
  const cutoff = chatMessages.length - LOOP_KEEP_RECENT_MESSAGES;
  const toolMeta = buildToolMetaMap(chatMessages);
  let changed = false;

  const out = chatMessages.map((m: any, idx: number) => {
    if (!m || idx >= cutoff) return m;

    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      let msgChanged = false;
      const toolCalls = m.tool_calls.map((tc: any) => {
        const name = tc?.function?.name || tc?.name;
        if (!name || !LOOP_CLEARABLE_RESULT_TOOLS.has(name)) return tc;
        let parsed: any = {};
        try { parsed = JSON.parse(tc.function?.arguments || '{}'); } catch { return tc; }
        const trimmed = trimToolInput(name, parsed);
        const nextArgs = JSON.stringify(trimmed);
        if (nextArgs === tc.function?.arguments) return tc;
        msgChanged = true;
        return {
          ...tc,
          function: { ...tc.function, arguments: nextArgs },
        };
      });
      if (!msgChanged) return m;
      changed = true;
      return { ...m, tool_calls: toolCalls };
    }

    if (m.role === 'tool' && m.tool_call_id && typeof m.content === 'string') {
      const meta = toolMeta.get(m.tool_call_id);
      const name = meta?.name || 'tool';
      if (!shouldCompactOldResult(name, m.content)) return m;
      changed = true;
      return {
        ...m,
        content: resultPlaceholder(name, meta?.summary || name, m.content.length),
      };
    }

    if (m.role === 'user' && Array.isArray(m.content)) {
      let msgChanged = false;
      const nextContent = m.content.map((block: any) => {
        if (block?.type !== 'tool_result' || !block.tool_use_id || typeof block.content !== 'string') return block;
        const meta = toolMeta.get(block.tool_use_id);
        const name = meta?.name || 'tool';
        if (!shouldCompactOldResult(name, block.content)) return block;
        msgChanged = true;
        return {
          ...block,
          content: resultPlaceholder(name, meta?.summary || name, block.content.length),
        };
      });
      if (!msgChanged) return m;
      changed = true;
      return { ...m, content: nextContent };
    }

    return m;
  });

  return changed ? out : chatMessages;
}
