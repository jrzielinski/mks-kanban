import { swallow } from '../../utils/log';
/**
 * session-memory.ts
 *
 * Port of Claude Code's services/SessionMemory/sessionMemory.ts (simplified).
 *
 * Maintains a live `.md` snapshot of WHAT THIS SESSION IS ABOUT — current
 * task, recent decisions, relevant files — so that the `away-summary`
 * (Fase 2.3) and any future "welcome back" path can recap accurately
 * without feeding the LLM a raw dump of tool_use/tool_result blocks
 * (which is what caused the "you're generating an MD5 hash" hallucination
 * that José Roberto hit).
 *
 * Key design differences from Claude Code:
 *  - We store the .md file next to the session .jsonl rather than in a
 *    shared memdir (it's per-session, not per-user). Path:
 *      ~/.makestudio/sessions/<cwdSlug>/<sessionId>.memory.md
 *  - We run it on the SAME process (not a forked subagent) — the fast
 *    provider (role=fast) is cheap enough that fork isolation isn't
 *    worth the complexity. If it becomes expensive, consider moving
 *    to a worker_thread.
 *  - We debounce: updates fire when BOTH conditions are true —
 *    (a) at least N tool calls happened since the last update,
 *    (b) at least T seconds elapsed since the last update.
 *    This prevents runaway cost on very active sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReplContext } from '../context';
import { getProvider } from './providers';
import { currentSessionFile } from '../sessions';

/** Minimum interval between two SessionMemory refreshes. */
const MIN_INTERVAL_MS = 2 * 60 * 1000;          // 2 minutes
/** Minimum tool calls that must have happened since the last refresh. */
const MIN_TOOL_CALLS = 6;
/** Max messages we show to the summariser per pass — bounds cost. */
const WINDOW_SIZE = 40;
/** Max chars we keep in the .md — further updates compact the file. */
const MEMORY_MAX_CHARS = 4000;

const PROMPT = `You are maintaining a living \`.md\` session memory for a coding assistant.
Your job: read the recent conversation, update the memory to reflect what the
session is CURRENTLY about — not a history dump.

Output ONE markdown document with these exact top-level sections:

## Current Task
One-line statement of the high-level goal the user is working on RIGHT NOW.

## Active Files
Bullet list of file paths the assistant has touched/read recently. One line each.

## Recent Decisions
2-5 bullets. What did the user or assistant decide? (approach, trade-offs, files to avoid)

## Open Questions
0-3 bullets. Explicit questions the user asked that are not yet answered.

## Blocked / Needs Deploy
0-3 bullets. Things waiting on a manual step (deploy, user action, external service).

Rules:
- Keep it FACTUAL. Do not invent context. If you don't see it, omit the section.
- Keep it SHORT. The whole file must be under 4000 chars.
- Do not include the conversation turn-by-turn. You are making a compact
  mental state snapshot — not a transcript.
- If the previous memory contradicts what you now see, REWRITE — do not append.
- Write in the same language the user writes in. Default: en.`;

// Per-ctx state — tracks when we last refreshed + the tool-call counter
// snapshot at that point.
interface MemoryState {
  lastRefreshMs: number;
  lastToolCalls: number;
  inflight: boolean;
}
const stateByCtx: WeakMap<ReplContext, MemoryState> = new WeakMap();

function getState(ctx: ReplContext): MemoryState {
  let s = stateByCtx.get(ctx);
  if (!s) {
    s = { lastRefreshMs: 0, lastToolCalls: 0, inflight: false };
    stateByCtx.set(ctx, s);
  }
  return s;
}

/**
 * Compute the path where this session's memory `.md` lives. Returns null
 * when the session file hasn't been created yet (e.g. brand-new session
 * with 0 messages) — SessionMemory only kicks in after the first turn.
 */
export function sessionMemoryPath(ctx: ReplContext): string | null {
  const sessionFile = currentSessionFile(ctx);
  if (!sessionFile) return null;
  return sessionFile.replace(/\.jsonl$/, '.memory.md');
}

/** Read the current memory `.md` (empty string when the file doesn't exist). */
export function readSessionMemory(ctx: ReplContext): string {
  const p = sessionMemoryPath(ctx);
  if (!p || !fs.existsSync(p)) return '';
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

/**
 * Decide whether enough has happened to justify a refresh. Called from
 * scheduleSessionMemoryUpdate() on every Stop hook — returns true no more
 * than once every MIN_INTERVAL_MS and only if MIN_TOOL_CALLS new tool
 * calls happened meanwhile.
 */
function shouldRefresh(ctx: ReplContext): boolean {
  const s = getState(ctx);
  if (s.inflight) return false;
  const now = Date.now();
  if (now - s.lastRefreshMs < MIN_INTERVAL_MS) return false;
  const toolCalls = ((ctx.stats?.toolCallsOk || 0) + (ctx.stats?.toolCallsFail || 0));
  if (toolCalls - s.lastToolCalls < MIN_TOOL_CALLS) return false;
  return true;
}

/**
 * Run the memory refresh (non-blocking). Safe to call on every turn end
 * — short-circuits to a no-op when the interval/threshold isn't met.
 */
export function scheduleSessionMemoryUpdate(ctx: ReplContext): void {
  if (!shouldRefresh(ctx)) return;
  const s = getState(ctx);
  s.inflight = true;

  // Fire-and-forget. Any error is swallowed; SessionMemory is best-effort.
  (async () => {
    try {
      const provider = getProvider(ctx.provider);
      if (!provider.sendSmall && !provider.sendMessage) return;

      const memoryPath = sessionMemoryPath(ctx);
      if (!memoryPath) return;

      const previous = readSessionMemory(ctx);
      const recent = ctx.messages.slice(-WINDOW_SIZE);
      // Filter out non-text blocks so the small model doesn't see JSON
      // tool_use/tool_result soup (which is what made away-summary
      // hallucinate in the DeepSeek session).
      const filtered = recent.map((m) => ({
        role: m.role,
        content: extractText(m.content),
      })).filter((m) => m.content.trim().length > 0);

      if (filtered.length < 3) return; // not enough to summarise

      const user = `Previous memory (may be stale — rewrite, don't append):
${previous || '(empty)'}

Recent conversation:
${filtered.map((m: any, i: number) => `[${i + 1}] ${m.role}: ${m.content.slice(0, 800)}`).join('\n\n')}`;

      const params = {
        system: PROMPT,
        messages: [{ role: 'user' as const, content: user }],
        tools: [],
        effort: 'low' as const,
      };

      let response: any = null;
      if (provider.sendSmall) {
        response = await provider.sendSmall(params as any);
      }
      if (!response) {
        response = await provider.sendMessage(params as any);
      }
      const raw: string = (response?.content || [])
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text).join('').trim();

      if (!raw) return;
      const clipped = raw.length > MEMORY_MAX_CHARS ? raw.slice(0, MEMORY_MAX_CHARS) : raw;
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      fs.writeFileSync(memoryPath, clipped, 'utf8');

      s.lastRefreshMs = Date.now();
      s.lastToolCalls = ((ctx.stats?.toolCallsOk || 0) + (ctx.stats?.toolCallsFail || 0));
    } catch (err) { swallow(err); } finally {
      s.inflight = false;
    }
  })();
}
