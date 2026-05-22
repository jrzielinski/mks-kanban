/**
 * compact-grouping.ts — split conversation into turn-level groups.
 *
 * Port of Claude Code's services/compact/grouping.ts adapted for our
 * message shape. A "turn" here = one user prompt + the assistant reply +
 * every tool_result that followed before the NEXT user prompt. This is
 * the minimal unit we can safely compact or snip without breaking
 * tool_use / tool_result pairing.
 *
 * Used by snipOldTurns (below) and the microCompact pass in chat.ts.
 */

export interface TurnGroup {
  /** Start index in the original messages array (inclusive). */
  start: number;
  /** End index in the original messages array (inclusive). */
  end: number;
  /** Messages in the group (shallow refs — mutating them mutates the source). */
  messages: any[];
  /** The user prompt text for this turn (first user message in the group). */
  userPrompt: string;
  /** Number of tool calls the assistant made in this turn. */
  toolCount: number;
  /** Final assistant text (last assistant text block in the group). */
  finalText: string;
  /** Byte-length approximation — sum of JSON.stringify(content). */
  sizeChars: number;
}

function messageContentString(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b: any) => (b?.type === 'text' ? b.text : (b?.type === 'tool_use' ? `[tool_use:${b.name}]` : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function messageSizeChars(m: any): number {
  try { return JSON.stringify(m.content ?? '').length; } catch { return 0; }
}

/**
 * Walk `messages` and split into turn groups. A new group starts on every
 * `role: 'user'` message (except a synthetic "tool_result" user carrying
 * only tool_result blocks — those stay with the current assistant turn).
 */
export function groupMessagesByTurn(messages: any[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let cur: any[] | null = null;
  let curStart = -1;
  let curUserPrompt = '';

  const flush = (endIdx: number) => {
    if (!cur || cur.length === 0 || curStart < 0) return;
    let toolCount = 0;
    let finalText = '';
    let size = 0;
    for (const m of cur) {
      size += messageSizeChars(m);
      if (m.role === 'assistant') {
        const c = m.content;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b?.type === 'tool_use') toolCount++;
            if (b?.type === 'text' && b.text) finalText = b.text;
          }
        } else if (typeof c === 'string') {
          finalText = c;
        }
      }
    }
    groups.push({
      start: curStart,
      end: endIdx,
      messages: cur,
      userPrompt: curUserPrompt,
      toolCount,
      finalText,
      sizeChars: size,
    });
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isUser = m?.role === 'user';
    // A user message whose content is ONLY tool_result blocks belongs to
    // the current turn (those are the API-mandated tool_result envelopes).
    const isToolResultOnly = isUser && Array.isArray(m.content) &&
      m.content.every((b: any) => b?.type === 'tool_result');
    const startsNewTurn = isUser && !isToolResultOnly;

    if (startsNewTurn) {
      flush(i - 1);
      cur = [m];
      curStart = i;
      curUserPrompt = messageContentString(m).slice(0, 200);
    } else {
      if (!cur) {
        // Edge: conversation starts with assistant or system — open a
        // synthetic group with whatever came first.
        cur = [m];
        curStart = i;
        curUserPrompt = '(no prior user prompt — session continued)';
      } else {
        cur.push(m);
      }
    }
  }
  flush(messages.length - 1);
  return groups;
}

/**
 * Replace old turn groups with a compact stub that preserves meaning but
 * frees 90%+ of their chars. Keeps the LAST `keepRecent` turns verbatim;
 * older turns become a single `role: 'user'` message with a summary.
 *
 * Returns { replaced, freedChars } — replaced=0 means no snipping needed.
 */
export function snipOldTurns(
  messages: any[],
  opts: { keepRecent?: number; minCharsPerTurn?: number } = {},
): { replaced: number; freedChars: number; newMessages: any[] } {
  const keepRecent = opts.keepRecent ?? 6;
  const minChars = opts.minCharsPerTurn ?? 500;
  const groups = groupMessagesByTurn(messages);
  if (groups.length <= keepRecent + 1) {
    return { replaced: 0, freedChars: 0, newMessages: messages };
  }
  const toSnip = groups.slice(0, groups.length - keepRecent);
  // Skip snipping when the candidate turns are already small — the stub
  // machinery has fixed overhead; only worth it when we actually reclaim chars.
  const snippable = toSnip.filter((g) => g.sizeChars >= minChars);
  if (snippable.length === 0) {
    return { replaced: 0, freedChars: 0, newMessages: messages };
  }

  const stub = {
    role: 'user' as const,
    content:
      `[${snippable.length} older turn(s) collapsed by snipCompact to save context.]\n\n` +
      snippable
        .map((g, i) => {
          const summary = g.finalText ? g.finalText.slice(0, 160) : '(no text output)';
          return `Turn ${i + 1} · user asked: "${g.userPrompt.slice(0, 100).replace(/\s+/g, ' ')}" · ${g.toolCount} tool call(s) · assistant: "${summary.replace(/\s+/g, ' ')}"`;
        })
        .join('\n'),
  };
  const freedChars = snippable.reduce((s, g) => s + g.sizeChars, 0) - JSON.stringify(stub.content).length;

  // Replace: everything before the first non-snippable group is discarded,
  // stub takes its place. Non-snippable old groups AND the keepRecent tail
  // stay in place.
  const firstKeepIdx = snippable[snippable.length - 1].end + 1;
  const newMessages = [stub, ...messages.slice(firstKeepIdx)];
  return { replaced: snippable.length, freedChars, newMessages };
}
