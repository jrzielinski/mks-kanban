import { swallow } from '../../utils/log';
/**
 * dedup-history.ts
 *
 * Cross-turn deduplication of repeated Read calls in the chat history.
 *
 * Why this exists: when the agent reads the same file (same path, same
 * offset/limit/window) in turns 1, 3, 5, every byte of that file is
 * serialized into the history three times. The provider re-pays input
 * tokens for all three on every subsequent turn — even though only the
 * last one reflects the current file state.
 *
 * What we do: keep only the LAST occurrence of each unique Read intact.
 * Earlier identical Reads have their tool_result body replaced with a
 * short placeholder that points to the recent-most version. The model
 * still sees the call happened (so its reasoning chain stays coherent),
 * but the bulk content is deduplicated.
 *
 * Pure function: input is not mutated. Returns a new array with shallow-
 * cloned messages whose modified blocks are also new objects.
 */

const READ_TOOL_NAMES = new Set(['Read', 'read_file']);

const PLACEHOLDER = (path: string, replacedByMsgIdx: number) =>
  `[Earlier Read of ${path} — superseded by a later Read of the same target (see message #${replacedByMsgIdx + 1}). Content omitted to save context tokens.]`;

interface ReadCall {
  /** Index in the messages array where this call was made (assistant turn). */
  msgIdx: number;
  /** Identifier the corresponding tool_result will reference. */
  callId: string;
  /** Tool name (Read / read_file). */
  name: string;
  /** Tool input — used to build the dedup key AND to recover the path
   *  for the placeholder text. */
  input: any;
}

function readKey(name: string, input: any): string {
  // Stable, order-insensitive key. Different offset/limit windows are
  // legitimately different reads (chunks), so we keep them separate.
  const normalised: Record<string, any> = {};
  if (input && typeof input === 'object') {
    for (const k of Object.keys(input).sort()) normalised[k] = input[k];
  }
  return `${name}|${JSON.stringify(normalised)}`;
}

function pathOf(input: any): string {
  return (input && (input.file_path || input.path || input.filepath)) || '<unknown>';
}

function collectReads(messages: any[]): ReadCall[] {
  const out: ReadCall[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;

    // Anthropic-format content blocks
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'tool_use' && READ_TOOL_NAMES.has(block.name)) {
          out.push({ msgIdx: i, callId: block.id, name: block.name, input: block.input });
        }
      }
    }

    // OpenAI-format tool_calls array
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name;
        if (!name || !READ_TOOL_NAMES.has(name)) continue;
        let input: any = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch (err) { swallow(err); }
        out.push({ msgIdx: i, callId: tc.id, name, input });
      }
    }
  }
  return out;
}

export function dedupRepeatedReads(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const reads = collectReads(messages);
  if (reads.length < 2) return messages;

  // Group by params; for each group with >1 entry, mark every entry
  // EXCEPT the last as deduplicatable.
  const byKey = new Map<string, ReadCall[]>();
  for (const r of reads) {
    const key = readKey(r.name, r.input);
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); }
    arr.push(r);
  }

  // callId → { path, supersededByMsgIdx }
  const dups = new Map<string, { path: string; supersededByMsgIdx: number }>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const last = group[group.length - 1];
    for (let i = 0; i < group.length - 1; i++) {
      dups.set(group[i].callId, {
        path: pathOf(group[i].input),
        supersededByMsgIdx: last.msgIdx,
      });
    }
  }

  if (dups.size === 0) return messages;

  // Now produce a new messages array with the bulky tool_result bodies
  // replaced. Both Anthropic (user message with tool_result blocks) and
  // OpenAI (separate `tool` role message) shapes are covered.
  return messages.map((m: any) => {
    if (!m) return m;

    // OpenAI format: { role: 'tool', tool_call_id, content }
    if (m.role === 'tool' && m.tool_call_id && dups.has(m.tool_call_id)) {
      const info = dups.get(m.tool_call_id)!;
      return { ...m, content: PLACEHOLDER(info.path, info.supersededByMsgIdx) };
    }

    // Anthropic format: { role: 'user', content: [..., {type:'tool_result', tool_use_id, content}, ...] }
    if (m.role === 'user' && Array.isArray(m.content)) {
      let modified = false;
      const newContent = m.content.map((block: any) => {
        if (block?.type === 'tool_result' && block.tool_use_id && dups.has(block.tool_use_id)) {
          modified = true;
          const info = dups.get(block.tool_use_id)!;
          return { ...block, content: PLACEHOLDER(info.path, info.supersededByMsgIdx) };
        }
        return block;
      });
      return modified ? { ...m, content: newContent } : m;
    }

    return m;
  });
}
