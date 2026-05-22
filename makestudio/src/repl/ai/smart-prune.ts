import { swallow } from '../../utils/log';
/**
 * smart-prune.ts — incremental, targeted pruning of the chat history.
 *
 * Existing compactors (micro-compact.ts, apiMicroCompact) trim by
 * size: anything past a threshold gets shortened. That's coarse —
 * an important Read of `package.json` and a redundant 5th Read of
 * the same file get treated identically.
 *
 * `incrementalPrune` is the next layer: it deletes (or stubs) entries
 * that the model demonstrably no longer needs, based on signal from
 * the rest of the history:
 *
 *   1. **Duplicate Read/Glob/Grep history** — when the model calls
 *      Read("a.ts") at turn 3 and again at turn 8, the turn-3 result
 *      is now stale. We replace turn-3's tool_result with a 1-line
 *      pointer to turn-8 ("see seq #X"). The model's deduplication
 *      logic already handles the call side; this handles the
 *      tool_result side that lingered in the history.
 *
 *   2. **Failed tool_calls older than KEEP_RECENT** — error responses
 *      have no forward value once the model has moved on. We replace
 *      the body with a 1-line "tool failed: <reason snippet>" stub.
 *
 *   3. **Long verbose Bash output > KEEP_RECENT turns ago** — we keep
 *      just the LAST 10 lines + first 3 lines, dropping the middle.
 *      Most "what was the build error?" questions hit head/tail
 *      anyway.
 *
 * All transforms are IDEMPOTENT (re-running on already-pruned history
 * is a no-op) and SAFE (recent history is never touched). This module
 * runs alongside microCompact, not instead of it.
 *
 * Off by default. Enable via `settings.smartPrune: true` or env
 * MAKESTUDIO_SMART_PRUNE=1. When off, all functions are no-ops.
 */

const KEEP_RECENT = 12;

// ── Activation check ─────────────────────────────────────────────

let cachedEnabled: boolean | null = null;
function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const env = (process.env.MAKESTUDIO_SMART_PRUNE || '').toLowerCase().trim();
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    const s = loadSettings() as any;
    cachedEnabled = !!s?.smartPrune;
    return cachedEnabled;
  } catch { cachedEnabled = false; return false; }
}

export function resetSmartPruneCache(): void { cachedEnabled = null; }

// ── Utilities ────────────────────────────────────────────────────

interface ToolUseRef {
  msgIdx: number;
  toolUseId: string;
  toolName: string;
  toolInput: any;
}

function findToolUses(messages: any[], maxIdx: number): ToolUseRef[] {
  const out: ToolUseRef[] = [];
  for (let i = 0; i < maxIdx; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'tool_use' && block.id) {
          out.push({ msgIdx: i, toolUseId: block.id, toolName: block.name, toolInput: block.input });
        }
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && tc.function?.name) {
          let parsed: any = {};
          try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch (err) { swallow(err); }
          out.push({ msgIdx: i, toolUseId: tc.id, toolName: tc.function.name, toolInput: parsed });
        }
      }
    }
  }
  return out;
}

function dedupKey(toolName: string, toolInput: any): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  // Only dedup READ-shaped tools (idempotent reads against the
  // filesystem). Mutating tools (Edit/Write/Bash) cannot be deduped
  // — a subsequent identical call has different intent.
  if (toolName === 'Read' || toolName === 'read_file') {
    const fp = toolInput.file_path || toolInput.path;
    if (!fp) return null;
    return `read|${fp}|${toolInput.offset ?? 0}|${toolInput.limit ?? 0}`;
  }
  if (toolName === 'Glob') {
    return `glob|${toolInput.pattern || ''}|${toolInput.path || ''}`;
  }
  if (toolName === 'Grep') {
    return `grep|${toolInput.pattern || ''}|${toolInput.path || ''}|${!!toolInput['-i']}|${toolInput.output_mode || 'files_with_matches'}`;
  }
  return null;
}

function findToolResultIndex(messages: any[], toolUseId: string): { msgIdx: number; pos?: number } | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === 'tool' && m.tool_call_id === toolUseId) {
      return { msgIdx: i };
    }
    if (m?.role === 'user' && Array.isArray(m.content)) {
      for (let p = 0; p < m.content.length; p++) {
        const b = m.content[p];
        if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) {
          return { msgIdx: i, pos: p };
        }
      }
    }
  }
  return null;
}

function setToolResultText(messages: any[], loc: { msgIdx: number; pos?: number }, text: string): boolean {
  const m = messages[loc.msgIdx];
  if (!m) return false;
  if (m.role === 'tool' && typeof m.content === 'string') {
    m.content = text;
    return true;
  }
  if (m.role === 'user' && Array.isArray(m.content) && loc.pos !== undefined) {
    const block = m.content[loc.pos];
    if (block && block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        block.content = text;
      } else if (Array.isArray(block.content)) {
        block.content = [{ type: 'text', text }];
      }
      return true;
    }
  }
  return false;
}

// ── Pruners ──────────────────────────────────────────────────────

const DUP_STUB = (latestSeq: number) =>
  `[result superseded — same Read/Glob/Grep was issued again later (#${latestSeq}); see that result for current content. Older copy elided by smartPrune.]`;

const FAIL_STUB = (snippet: string) =>
  `[old failed tool call elided by smartPrune — was: ${snippet.slice(0, 120)}. Recent failures preserved.]`;

const BASH_HEAD_TAIL_NOTE = '\n... [middle elided by smartPrune; head + tail preserved] ...\n';

function pruneDuplicates(messages: any[]): { count: number; freedChars: number } {
  if (messages.length <= KEEP_RECENT + 2) return { count: 0, freedChars: 0 };
  const oldEnd = messages.length - KEEP_RECENT;
  const toolUses = findToolUses(messages, oldEnd);

  // Group by dedup key. The LAST occurrence in each group is the
  // survivor; everything before it gets stubbed.
  const lastByKey = new Map<string, ToolUseRef>();
  for (const tu of toolUses) {
    const key = dedupKey(tu.toolName, tu.toolInput);
    if (!key) continue;
    lastByKey.set(key, tu);
  }

  let count = 0;
  let freedChars = 0;
  for (const tu of toolUses) {
    const key = dedupKey(tu.toolName, tu.toolInput);
    if (!key) continue;
    const survivor = lastByKey.get(key);
    if (!survivor || survivor.toolUseId === tu.toolUseId) continue;
    // Stub this older duplicate's tool_result.
    const loc = findToolResultIndex(messages, tu.toolUseId);
    if (!loc) continue;
    const m = messages[loc.msgIdx];
    let oldLen = 0;
    if (m.role === 'tool' && typeof m.content === 'string') oldLen = m.content.length;
    else if (m.role === 'user' && Array.isArray(m.content) && loc.pos !== undefined) {
      const b = m.content[loc.pos];
      if (b?.type === 'tool_result') {
        if (typeof b.content === 'string') oldLen = b.content.length;
        else if (Array.isArray(b.content)) oldLen = JSON.stringify(b.content).length;
      }
    }
    const stub = DUP_STUB(survivor.msgIdx + 1);
    if (oldLen <= stub.length + 8) continue; // already small
    if (setToolResultText(messages, loc, stub)) {
      count++;
      freedChars += Math.max(0, oldLen - stub.length);
    }
  }
  return { count, freedChars };
}

function pruneOldFailures(messages: any[]): { count: number; freedChars: number } {
  if (messages.length <= KEEP_RECENT + 2) return { count: 0, freedChars: 0 };
  const oldEnd = messages.length - KEEP_RECENT;
  let count = 0;
  let freedChars = 0;
  for (let i = 0; i < oldEnd; i++) {
    const m = messages[i];
    let body: string | null = null;
    let setter: ((s: string) => boolean) | null = null;

    if (m?.role === 'tool' && typeof m.content === 'string') {
      body = m.content;
      setter = (s) => { m.content = s; return true; };
    } else if (m?.role === 'user' && Array.isArray(m.content)) {
      for (let p = 0; p < m.content.length; p++) {
        const b = m.content[p];
        if (b?.type === 'tool_result' && typeof b.content === 'string') {
          body = b.content;
          setter = (s) => { b.content = s; return true; };
          break;
        }
      }
    }
    if (!body || !setter) continue;
    if (body.startsWith('[old failed') || body.startsWith('[result superseded')) continue;

    // Heuristic: tool_result that LOOKS like a failure. Be conservative —
    // we don't want to stub legitimate output that mentions "error".
    const looksFailed =
      /^\s*\{[\s\S]*"error"\s*:/.test(body) ||
      /^\s*Error:/i.test(body) ||
      /^\s*Refusing to/.test(body) ||
      /^\s*\[edit will fail/.test(body);

    if (!looksFailed) continue;
    if (body.length < 200) continue; // short failures stay verbatim

    const stub = FAIL_STUB(body);
    if (setter(stub)) {
      count++;
      freedChars += body.length - stub.length;
    }
  }
  return { count, freedChars };
}

function pruneVerboseBash(messages: any[]): { count: number; freedChars: number } {
  if (messages.length <= KEEP_RECENT + 2) return { count: 0, freedChars: 0 };
  const oldEnd = messages.length - KEEP_RECENT;
  let count = 0;
  let freedChars = 0;

  // Find old Bash tool_use blocks and their tool_results.
  const bashTools = findToolUses(messages, oldEnd).filter((t) => t.toolName === 'Bash' || t.toolName === 'shell_run');
  for (const tu of bashTools) {
    const loc = findToolResultIndex(messages, tu.toolUseId);
    if (!loc) continue;
    const m = messages[loc.msgIdx];
    let body: string | null = null;
    let setter: ((s: string) => boolean) | null = null;
    if (m.role === 'tool' && typeof m.content === 'string') {
      body = m.content;
      setter = (s) => { m.content = s; return true; };
    } else if (m.role === 'user' && Array.isArray(m.content) && loc.pos !== undefined) {
      const b = m.content[loc.pos];
      if (b?.type === 'tool_result' && typeof b.content === 'string') {
        body = b.content;
        setter = (s) => { b.content = s; return true; };
      }
    }
    if (!body || !setter) continue;
    if (body.includes(BASH_HEAD_TAIL_NOTE)) continue; // already pruned
    const lines = body.split('\n');
    if (lines.length <= 25) continue; // not verbose enough
    const head = lines.slice(0, 3).join('\n');
    const tail = lines.slice(-10).join('\n');
    const next = head + BASH_HEAD_TAIL_NOTE + tail;
    if (next.length >= body.length) continue;
    if (setter(next)) {
      count++;
      freedChars += body.length - next.length;
    }
  }
  return { count, freedChars };
}

// ── Public API ───────────────────────────────────────────────────

export interface SmartPruneResult {
  duplicatesStubbed: number;
  failuresStubbed: number;
  bashTrimmed: number;
  freedChars: number;
}

export function incrementalPrune(ctx: any): SmartPruneResult {
  const empty: SmartPruneResult = { duplicatesStubbed: 0, failuresStubbed: 0, bashTrimmed: 0, freedChars: 0 };
  if (!isEnabled()) return empty;
  if (!ctx || !Array.isArray(ctx.messages)) return empty;

  const dup = pruneDuplicates(ctx.messages);
  const fail = pruneOldFailures(ctx.messages);
  const bash = pruneVerboseBash(ctx.messages);

  return {
    duplicatesStubbed: dup.count,
    failuresStubbed: fail.count,
    bashTrimmed: bash.count,
    freedChars: dup.freedChars + fail.freedChars + bash.freedChars,
  };
}
