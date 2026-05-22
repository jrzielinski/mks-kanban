import { swallow } from '../../utils/log';
/**
 * away-summary.ts
 *
 * Port of Claude Code's services/awaySummary.ts — when the user returns
 * after an idle gap, surface a 1-3 sentence recap so they remember where
 * we left off.
 *
 * The `AWAY_SUMMARY_PROMPT` below is lifted verbatim from
 * claude-code/src/services/awaySummary.ts (buildAwaySummaryPrompt).
 *
 * Trigger: chat.ts computes the gap between turns; if >= AWAY_GAP_MS
 * AND there are existing messages, this runs in parallel with the user's
 * new turn and emits an info message once done.
 */

import { ReplContext } from '../context';
import { getProvider } from './providers';
import { readSessionMemory } from './session-memory';

// Same cap as Claude Code — ~15 exchanges of context, enough for recap.
const RECENT_MESSAGE_WINDOW = 30;
/** Minimum message count to even attempt a recap — below this, return null. */
const MIN_MESSAGES = 6;
/** Gap threshold that counts as "user stepped away". Match Claude Code's UX. */
export const AWAY_GAP_MS = 5 * 60 * 1000;

// Verbatim from Claude Code's buildAwaySummaryPrompt (Claude Code also
// injects SessionMemory content when available — we do the same below).
export const AWAY_SUMMARY_PROMPT =
  'The user stepped away and is coming back. Write exactly 1-3 short sentences. ' +
  'Start by stating the high-level task — what they are building or debugging, ' +
  'not implementation details. Next: the concrete next step. ' +
  'Skip status reports and commit recaps. ' +
  'IMPORTANT: Only describe work the conversation actually contains. ' +
  'If there is no clear task, say "Session just started — no specific task yet."';

/**
 * Flatten a message.content that might be a string OR an Anthropic-style
 * array of content blocks. We strip tool_use and tool_result blocks entirely
 * here — feeding them raw to the small model is what made this service
 * hallucinate the MD5 task in the DeepSeek session.
 */
function flattenContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Produce a "while you were away" recap. Returns null when there's nothing
 * useful to say (empty session, provider error, classifier reject).
 */
export async function generateAwaySummary(
  ctx: ReplContext,
  signal?: AbortSignal,
): Promise<string | null> {
  if (ctx.messages.length < MIN_MESSAGES) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('../settings').loadSettings().awaySummaryDisabled) return null;
  } catch (err) { swallow(err); }

  const provider = getProvider(ctx.provider);
  if (!provider.sendMessage) return null;

  // Fresh context for the summariser: text-only message history + current
  // SessionMemory snapshot (if any). SessionMemory is curated — it already
  // says "Current Task / Active Files / Recent Decisions", which is exactly
  // the grounding this model needs to avoid inventing a task.
  const memory = readSessionMemory(ctx).trim();

  const recent = ctx.messages
    .slice(-RECENT_MESSAGE_WINDOW)
    .map((m) => ({ role: m.role, content: flattenContent(m.content) }))
    .filter((m) => m.content.length > 0);

  if (recent.length < MIN_MESSAGES) return null;

  const system = [
    'You are generating a terse "welcome back" recap for a returning user.',
    'Do NOT invent a task. Ground yourself in the session memory and conversation below.',
    memory ? `\n## Session memory (authoritative context)\n${memory}\n` : '',
  ].join('\n').trim();

  recent.push({ role: 'user' as const, content: AWAY_SUMMARY_PROMPT });

  const params = {
    system,
    messages: recent,
    tools: [],
    effort: 'low' as const,
    signal,
  };

  try {
    // Prefer the auxiliary (fast) provider when configured — this is
    // exactly the kind of cheap side-task Claude Code routes through
    // getSmallFastModel. Falls back to the primary silently if the
    // backend has no role=fast config.
    let response: any = null;
    if (provider.sendSmall) {
      response = await provider.sendSmall(params as any);
    }
    if (!response) {
      response = await provider.sendMessage(params as any);
    }
    const raw: string = (response?.content || [])
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
      .trim();
    if (!raw) return null;
    // Cap at ~400 chars — anything longer violates the prompt's 1-3 sentence rule.
    if (raw.length > 400) return raw.slice(0, 397) + '...';
    return raw;
  } catch {
    return null;
  }
}

/**
 * Returns true when the gap between the previous turn and now exceeds
 * AWAY_GAP_MS — i.e. it's worth firing a recap. Exported for testing.
 */
export function gapIsAway(lastTurnAt: number, nowMs: number = Date.now()): boolean {
  if (!lastTurnAt || lastTurnAt <= 0) return false;
  return nowMs - lastTurnAt >= AWAY_GAP_MS;
}
