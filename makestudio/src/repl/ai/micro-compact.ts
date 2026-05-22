import { swallow } from '../../utils/log';
/**
 * micro-compact.ts
 *
 * Cheap context-shrinking passes that run BEFORE the LLM-summary
 * autoCompact. They mutate `ctx.messages` in place and return how much
 * was freed. No provider calls, no IO — these are 100% mechanical.
 *
 * Two complementary passes:
 *
 *   1. `microCompact` (char-based) — truncates tool_result payloads
 *      whose char length exceeds a threshold. Picks line-boundary
 *      truncation when the payload has ≥8 newlines (keeps git log /
 *      test output readable); falls back to a single-line stub.
 *
 *   2. `apiMicroCompact` (token-aware) — same idea but uses an estimated
 *      token count instead of chars. Catches dense content (JSON blobs,
 *      minified code) that packed many tokens per char and slipped past
 *      the char threshold. Honors a per-tool policy: read-family
 *      results are clearable; write-family results stay (the model
 *      needs to remember it edited file X).
 *
 * Both pass over only the OLDER part of the conversation
 * (messages.length - MICRO_COMPACT_KEEP_RECENT). Recent turns stay
 * verbatim so the model's working context doesn't get shredded.
 *
 * Originally lived in chat.ts. Moved here so the chat loop is no
 * longer carrying ~150 lines of payload-trimming noise.
 */

import { truncateAtLineBoundary } from './chat-utils';
import { estimateTokens } from './token-estimation';

// Cache impact of microCompact:
//   - system + tools breakpoints: PRESERVED (we don't touch those blocks)
//   - last user message breakpoint: INVALIDATED for the turn immediately
//     after compaction (content between system and last-user changed).
//   - Recovers on the next turn (new last-user breakpoint warms back up).
// Net cost: one extra cache miss per microCompact. Mitigated by only
// running compaction at COMPACT_THRESHOLD / COMPACT_CTX_PCT — not every
// turn. claude-code uses the `cache_edits` API beta to keep the
// last-user breakpoint warm even after edits; we accept the single-turn
// miss instead of taking the beta dependency.

// ── microCompact (char-based) ──────────────────────────────────────────
// Tightened 2026-05-04 (sliding window aggression): was 10 → 6. The
// last 6 messages stay verbatim; everything older gets compacted on
// every turn. With KEEP_RECENT=10 a 30-tool turn still re-paid 24
// tool_results in full each round-trip; KEEP_RECENT=6 caps that at 6.
// Trade-off: model occasionally re-runs a tool whose result rotated
// out of the recent window. That's cheaper than the multi-100k token
// re-payment per round-trip.
const MICRO_COMPACT_KEEP_RECENT = 6;
// Tightened 2026-05-04: 800 → 400. Smaller threshold means tool_results
// over ~400 chars in older turns get truncated to a stub. Most Read
// outputs, even partial, exceed this; aggressive compaction of older
// reads is exactly the goal.
const MICRO_COMPACT_MIN_TOOL_RESULT = 400;
const MICRO_COMPACT_STUB = (chars: number) =>
  `[tool_result truncated by microCompact — was ${chars} chars. If you need the full output, re-run the tool.]`;

// ── apiMicroCompact (token-aware) ──────────────────────────────────────
// Tightened 2026-05-04: 1500 → 800 tokens. Catches dense JSON/code
// blobs that compress many tokens per char, alongside the char-based
// pass.
const API_MICRO_MAX_TOKENS_PER_RESULT = 800;
const API_MICRO_STUB = (tokens: number) =>
  `[tool_result truncated by apiMicroCompact — was ~${tokens} tokens. Re-run the tool if you need the full output.]`;

// Per-tool compaction policy (port of apiMicrocompact TOOLS_CLEARABLE_RESULTS
// + TOOLS_CLEARABLE_USES, services/compact/apiMicrocompact.ts:19-32).
//
// READ-family results can be cleared aggressively — the model already
// consumed them, re-running reproduces them. WRITE-family uses (the
// tool_use request, not the result) are STATE: the model must remember
// "I wrote file X earlier" to avoid redoing the work or losing track of
// edits. Compacting write uses makes the model forget its own changes.
const TOOLS_CLEARABLE_RESULTS = new Set([
  'Read', 'read_file', 'Glob', 'Grep', 'LSP',
  'Bash', 'shell_run',
  'WebFetch', 'web_fetch', 'web_search',
  'ListFiles', 'list_files',
  // Backend status tools — stale after 30s anyway
  'get_project_status', 'get_tasks_by_project', 'read_execution_state',
]);
const TOOLS_PRESERVE_USES = new Set([
  'Write', 'write_file', 'Edit', 'edit_file', 'MultiEdit', 'NotebookEdit',
]);

/**
 * Token-aware variant — trims tool_result blocks whose estimated token
 * count exceeds API_MICRO_MAX_TOKENS_PER_RESULT, regardless of char length.
 * Complements microCompact (which trims by char threshold). Claude Code
 * runs both: char-based for "obviously too big" fast path, then token-
 * based for the remainder.
 *
 * Order of invocation: charCompact first (cheap, no estimate), then
 * tokenCompact to catch JSON/code that squeaked past. Both idempotent.
 */
export function apiMicroCompact(ctx: any): { trimmed: number; freedTokens: number } {
  const total = ctx.messages.length;
  if (total <= MICRO_COMPACT_KEEP_RECENT + 2) return { trimmed: 0, freedTokens: 0 };
  const lastTouched = total - MICRO_COMPACT_KEEP_RECENT;

  // Build a tool_use_id → tool_name map by walking assistant messages.
  // OpenAI format has `tool_calls[].function.name`; Anthropic has
  // `content[{ type:'tool_use', id, name }]`. Both mapped here so the
  // TOOLS_CLEARABLE_RESULTS gate works across providers.
  const toolIdToName = new Map<string, string>();
  for (const m of ctx.messages) {
    if (m?.role !== 'assistant') continue;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use' && b.id && b.name) toolIdToName.set(b.id, b.name);
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const id = tc?.id;
        const name = tc?.function?.name || tc?.name;
        if (id && name) toolIdToName.set(id, name);
      }
    }
  }

  let trimmed = 0;
  let freedTokens = 0;

  const clearableByToolId = (toolUseId: string | undefined): boolean => {
    // When we don't know which tool produced this result, default to
    // CLEARABLE — char-threshold already gated us past the "small result"
    // case, so if it's big AND unknown, it's almost certainly a read-like
    // blob. Preserving uncertain results would defeat the compactor.
    if (!toolUseId) return true;
    const name = toolIdToName.get(toolUseId);
    if (!name) return true;
    if (TOOLS_PRESERVE_USES.has(name)) return false; // keep write-tool results (short anyway)
    if (TOOLS_CLEARABLE_RESULTS.has(name)) return true;
    return true; // unknown tool → clear by default
  };

  const maybeTrim = (getter: () => string, setter: (s: string) => void, tuId?: string): boolean => {
    const current = getter();
    if (typeof current !== 'string' || !current) return false;
    const tokens = estimateTokens(current);
    if (tokens <= API_MICRO_MAX_TOKENS_PER_RESULT) return false;
    if (!clearableByToolId(tuId)) return false;
    setter(API_MICRO_STUB(tokens));
    freedTokens += tokens - estimateTokens(API_MICRO_STUB(tokens));
    trimmed++;
    return true;
  };

  for (let i = 0; i < lastTouched; i++) {
    const m = ctx.messages[i];
    if (!m) continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || block.type !== 'tool_result') continue;
        const tuId: string | undefined = block.tool_use_id;
        if (typeof block.content === 'string') {
          maybeTrim(() => block.content, (s) => { block.content = s; }, tuId);
        } else if (Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub && sub.type === 'text' && typeof sub.text === 'string') {
              maybeTrim(() => sub.text, (s) => { sub.text = s; }, tuId);
            }
          }
        }
      }
    }
    if (m.role === 'tool' && typeof m.content === 'string') {
      maybeTrim(() => m.content, (s) => { m.content = s; }, m.tool_call_id);
    }
  }
  return { trimmed, freedTokens };
}

// ── compactToolUseInputs (write-tool args) ─────────────────────────────
// Edit / Write / MultiEdit calls carry the entire `new_string` (sometimes
// hundreds of lines) inside the tool_use input. Once the call has executed,
// the model only needs to remember "I edited file X" — the actual content
// is on disk now. Yet without trimming, the input stays in the history
// FOREVER, paying input tokens every turn.
//
// We replace the input of write-family tool_use blocks (in older messages)
// with a tiny placeholder that keeps the file_path so the model still
// recalls which file was touched.
const TOOLS_INPUT_TRIMMABLE = new Set([
  'Write', 'write_file', 'Edit', 'edit_file', 'MultiEdit', 'NotebookEdit',
]);
const INPUT_TRIM_KEEP_RECENT = 10;
const INPUT_TRIM_MIN_CHARS = 800;
/**
 * Build a one-line diff summary so the trimmed stub still carries
 * structural information. The previous version replaced an Edit's full
 * input with just `[Edit applied to X — original args omitted...]`,
 * losing every signal. With the summary, the model can still tell
 * roughly what happened in old turns ("oh, that Edit added 12 lines
 * and removed 3 around line 45") without needing the full args.
 *
 * Best-effort. If `input` doesn't have what we expect, returns ''.
 */
function summariseEditInput(name: string, input: any): string {
  try {
    if (!input || typeof input !== 'object') return '';
    if (name === 'Write' || name === 'write_file') {
      const content = typeof input.content === 'string' ? input.content : '';
      const lines = content === '' ? 0 : content.split('\n').length;
      const chars = content.length;
      return `wrote ${lines} line${lines === 1 ? '' : 's'} (${chars} chars)`;
    }
    if (name === 'Edit' || name === 'edit_file') {
      const oldS = typeof input.old_string === 'string' ? input.old_string : '';
      const newS = typeof input.new_string === 'string' ? input.new_string : '';
      const oldLines = oldS === '' ? 0 : oldS.split('\n').length;
      const newLines = newS === '' ? 0 : newS.split('\n').length;
      const replaceAll = !!input.replace_all;
      return `replaced ${oldLines} line${oldLines === 1 ? '' : 's'} with ${newLines} line${newLines === 1 ? '' : 's'}${replaceAll ? ' (replace_all)' : ''}`;
    }
    if (name === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      let oldLines = 0;
      let newLines = 0;
      for (const e of edits) {
        if (typeof e?.old_string === 'string' && e.old_string !== '') oldLines += e.old_string.split('\n').length;
        if (typeof e?.new_string === 'string' && e.new_string !== '') newLines += e.new_string.split('\n').length;
      }
      return `applied ${edits.length} edit${edits.length === 1 ? '' : 's'}: -${oldLines}/+${newLines} lines`;
    }
    if (name === 'NotebookEdit') {
      const cellId = input.cell_id || input.cell_index;
      const newSrc = typeof input.new_source === 'string' ? input.new_source : '';
      const newLines = newSrc === '' ? 0 : newSrc.split('\n').length;
      return `cell ${cellId ?? '?'} → ${newLines} line${newLines === 1 ? '' : 's'}`;
    }
  } catch (err) { swallow(err); }
  return '';
}

const INPUT_TRIM_NOTE = (path: string, name: string, summary?: string) => {
  const tail = summary ? ` (${summary})` : '';
  return `[${name} applied to ${path}${tail} — original args omitted by compactor. Re-Read the file if you need its current state.]`;
};

export function compactToolUseInputs(ctx: any): { trimmed: number; freedChars: number } {
  const total = ctx.messages.length;
  if (total <= INPUT_TRIM_KEEP_RECENT + 2) return { trimmed: 0, freedChars: 0 };
  const lastTouched = total - INPUT_TRIM_KEEP_RECENT;
  let trimmed = 0;
  let freedChars = 0;
  for (let i = 0; i < lastTouched; i++) {
    const m = ctx.messages[i];
    if (m?.role !== 'assistant') continue;

    // Anthropic format
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || block.type !== 'tool_use') continue;
        if (!TOOLS_INPUT_TRIMMABLE.has(block.name)) continue;
        if (!block.input || typeof block.input !== 'object') continue;
        if (block.input._omitted) continue; // already trimmed (idempotent)
        const before = JSON.stringify(block.input).length;
        if (before < INPUT_TRIM_MIN_CHARS) continue;
        const path = block.input.file_path || block.input.path || '<unknown>';
        const summary = summariseEditInput(block.name, block.input);
        const stub = { file_path: path, _omitted: INPUT_TRIM_NOTE(path, block.name, summary) };
        block.input = stub;
        freedChars += before - JSON.stringify(stub).length;
        trimmed++;
      }
    }

    // OpenAI format — function.arguments is a JSON string
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function;
        if (!fn || !TOOLS_INPUT_TRIMMABLE.has(fn.name)) continue;
        const args = fn.arguments;
        if (typeof args !== 'string' || args.length < INPUT_TRIM_MIN_CHARS) continue;
        let parsed: any = {};
        try { parsed = JSON.parse(args); } catch { continue; }
        if (parsed?._omitted) continue;
        const path = parsed.file_path || parsed.path || '<unknown>';
        const summary = summariseEditInput(fn.name, parsed);
        const stub = JSON.stringify({ file_path: path, _omitted: INPUT_TRIM_NOTE(path, fn.name, summary) });
        freedChars += args.length - stub.length;
        fn.arguments = stub;
        trimmed++;
      }
    }
  }
  return { trimmed, freedChars };
}

// ── compactOldImages (base64 attachments) ──────────────────────────────
// A pasted screenshot becomes ~1.3× its byte size as base64 in the user
// message. With 3 screenshots in a session that's 5–15 MB sent on EVERY
// subsequent turn. After the model has consumed and reasoned about the
// image, the bulk content can be replaced with a placeholder — Vision
// already extracted what mattered and the user can re-paste if needed.
const IMAGE_STRIP_KEEP_RECENT = 5;
const IMAGE_STRIP_PLACEHOLDER = (turnIdx: number, mediaType: string) =>
  `[image attachment from turn ${turnIdx + 1} (${mediaType}) — content omitted by compactor to save tokens. Ask the user to re-paste if you need to look at it again.]`;

export function compactOldImages(ctx: any): { stripped: number; freedChars: number } {
  const total = ctx.messages.length;
  if (total <= IMAGE_STRIP_KEEP_RECENT + 2) return { stripped: 0, freedChars: 0 };
  const lastTouched = total - IMAGE_STRIP_KEEP_RECENT;
  let stripped = 0;
  let freedChars = 0;
  for (let i = 0; i < lastTouched; i++) {
    const m = ctx.messages[i];
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    let modified = false;
    const newContent = m.content.map((block: any) => {
      // Anthropic shape: { type: 'image', source: { type: 'base64', media_type, data } }
      if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
        const before = block.source.data.length;
        if (before === 0) return block;
        freedChars += before;
        stripped++;
        modified = true;
        return { type: 'text', text: IMAGE_STRIP_PLACEHOLDER(i, block.source.media_type || 'image') };
      }
      // OpenAI shape: { type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }
      if (block?.type === 'image_url' && typeof block.image_url?.url === 'string' && block.image_url.url.startsWith('data:')) {
        const before = block.image_url.url.length;
        freedChars += before;
        stripped++;
        modified = true;
        return { type: 'text', text: IMAGE_STRIP_PLACEHOLDER(i, 'image') };
      }
      return block;
    });
    if (modified) ctx.messages[i] = { ...m, content: newContent };
  }
  return { stripped, freedChars };
}

/**
 * Char-based variant — truncate tool_result payloads in older messages.
 * Returns the number of blocks trimmed and the total char delta (how much
 * context was freed). Idempotent — if a message was already trimmed, it's
 * skipped (the stub is below the threshold).
 */
export function microCompact(ctx: any): { trimmed: number; freedChars: number } {
  const total = ctx.messages.length;
  if (total <= MICRO_COMPACT_KEEP_RECENT + 2) return { trimmed: 0, freedChars: 0 };
  const lastTouched = total - MICRO_COMPACT_KEEP_RECENT;

  let trimmed = 0;
  let freedChars = 0;

  for (let i = 0; i < lastTouched; i++) {
    const m = ctx.messages[i];
    if (!m) continue;

    // Form 1: Anthropic-style content array with tool_result blocks.
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block) continue;
        if (block.type !== 'tool_result') continue;
        // block.content can be string OR array of blocks (rare nested case).
        if (typeof block.content === 'string' && block.content.length > MICRO_COMPACT_MIN_TOOL_RESULT) {
          const was = block.content.length;
          // Prefer line-boundary truncation when the payload has newlines —
          // tool results like `git log` / test output are more useful with
          // a few lines preserved than a bare stub. Falls back to stub when
          // single-line or very short.
          const canPreserveLines = (block.content.match(/\n/g) || []).length >= 8;
          block.content = canPreserveLines
            ? truncateAtLineBoundary(block.content, Math.max(400, Math.floor(MICRO_COMPACT_MIN_TOOL_RESULT * 0.3)))
            : MICRO_COMPACT_STUB(was);
          freedChars += was - block.content.length;
          trimmed++;
        } else if (Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub && sub.type === 'text' && typeof sub.text === 'string' && sub.text.length > MICRO_COMPACT_MIN_TOOL_RESULT) {
              const was = sub.text.length;
              const canPreserveLines = (sub.text.match(/\n/g) || []).length >= 8;
              sub.text = canPreserveLines
                ? truncateAtLineBoundary(sub.text, Math.max(400, Math.floor(MICRO_COMPACT_MIN_TOOL_RESULT * 0.3)))
                : MICRO_COMPACT_STUB(was);
              freedChars += was - sub.text.length;
              trimmed++;
            }
          }
        }
      }
    }

    // Form 2: OpenAI-style `role: 'tool'` with string content.
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > MICRO_COMPACT_MIN_TOOL_RESULT) {
      const was = m.content.length;
      m.content = MICRO_COMPACT_STUB(was);
      freedChars += was - m.content.length;
      trimmed++;
    }
  }

  return { trimmed, freedChars };
}
