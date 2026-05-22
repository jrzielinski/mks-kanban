import { swallow } from '../utils/log';
/**
 * extract-memories.ts
 *
 * Auto-memory extraction. After a query completes with a final text
 * response (no tool calls), we spawn a forked sub-agent that reads the
 * last N messages of the session and proposes durable memories to save.
 *
 * Inspired by claude-code/src/services/extractMemories/. We use our own
 * memory.ts (single flat directory with topic files) rather than the
 * memdir hierarchy — simpler and already wired in.
 */

import { ReplContext, ChatMessage } from './context';
import { saveTopic, findRelevant } from './memory';

// ── Extraction thresholds (ported from Claude Code sessionMemoryUtils.ts:32-36) ──
// Claude Code uses tokenCountWithEstimation(messages) for context-window size.
// We use ctx.usage.totalTokens (cumulative API usage) as proxy — both grow
// monotonically with conversation length, so deltas are equivalent.
//
// Original Claude Code thresholds (sessionMemoryUtils.ts:32-36):
//   minimumMessageTokensToInit: 10000   — minimum total tokens before first extraction
//   minimumTokensBetweenUpdate: 5000    — minimum token growth between extractions
//   toolCallsBetweenUpdates: 3          — minimum tool calls between extractions
const MIN_TOKENS_TO_INIT = 10000;
const MIN_TOKENS_BETWEEN = 5000;
const MIN_TOOL_CALLS_BETWEEN = 3;

/**
 * Check whether enough conversation has accumulated since the last memory
 * extraction to warrant another one. Port of Claude Code's
 * shouldExtractMemory() (sessionMemory.ts:134-178) with the same 3-threshold
 * logic: token-growth AND tool-call-count, OR token-growth AND last-turn-no-tool-calls.
 *
 * Stores the last-extraction snapshot on ctx.__lastMemExtract so subsequent
 * calls can compare deltas. The snapshot is { totalTokens, toolCallsOk, ts }.
 */
export function shouldExtractMemory(ctx: ReplContext): boolean {
  const snap = (ctx as any).__lastMemExtract;
  if (!snap) {
    // First extraction: never happened. Check init threshold.
    if (ctx.usage.totalTokens < MIN_TOKENS_TO_INIT) {
      const dbg = safeRequire('../debug-log');
      dbg?.dbgInfo?.('memory_extract_skipped', { reason: 'below_init_threshold', totalTokens: ctx.usage.totalTokens, min: MIN_TOKENS_TO_INIT });
      return false;
    }
    return true;
  }

  const tokenGrowth = ctx.usage.totalTokens - snap.totalTokens;
  const toolCallGrowth = ctx.stats.toolCallsOk - snap.toolCallsOk;

  const hasMetTokenThreshold = tokenGrowth >= MIN_TOKENS_BETWEEN;
  const hasMetToolCallThreshold = toolCallGrowth >= MIN_TOOL_CALLS_BETWEEN;

  // Claude Code logic (sessionMemory.ts:168-170):
  //   (hasMetTokenThreshold && hasMetToolCallThreshold) ||
  //   (hasMetTokenThreshold && !lastTurnHasToolCalls)
  //
  // "lastTurnHasToolCalls" in Claude Code checks the LAST assistant message's
  // tool_calls array. Our proxy: if toolCallGrowth === 0 since last snapshot,
  // the last turn had no tool calls.
  const lastTurnNoToolCalls = toolCallGrowth === 0;
  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && lastTurnNoToolCalls);

  if (!shouldExtract) {
    const dbg = safeRequire('../debug-log');
    dbg?.dbgInfo?.('memory_extract_skipped', {
      reason: 'thresholds_not_met',
      tokenGrowth,
      toolCallGrowth,
      minTokens: MIN_TOKENS_BETWEEN,
      minToolCalls: MIN_TOOL_CALLS_BETWEEN,
      lastTurnNoToolCalls,
    });
  }

  return shouldExtract;
}

/** Update the extraction snapshot so the next delta counts from here. */
export function markMemExtractionDone(ctx: ReplContext): void {
  (ctx as any).__lastMemExtract = {
    totalTokens: ctx.usage.totalTokens,
    toolCallsOk: ctx.stats.toolCallsOk,
    ts: Date.now(),
  };
}

/** Safe require — returns null when the module doesn't exist instead of throwing. */
function safeRequire(mod: string): any | null {
  try { return require(mod); } catch { return null; }
}

const EXTRACT_SYSTEM_PROMPT = `You are a memory extractor.
Your job: read the recent conversation and propose durable memories to
save for future sessions with this user.

ONLY propose memories that are:
- User-specific preferences or workflow rules (e.g. "prefers lowercase branch names")
- Corrections the user made to the assistant (e.g. "don't auto-commit")
- Non-obvious project facts the user stated (e.g. "module X is being retired")
- External references the user mentioned (e.g. "bug tracker is Linear project Y")

DO NOT propose:
- Code that can be derived from the repo itself
- Temporary/in-progress task state
- Anything already in the "already-known" list below
- Greetings, small talk, meta-commentary about the assistant

Output ONLY valid JSON matching this schema:

{
  "memories": [
    {
      "name": "feedback_no_deploy",
      "description": "Never run deploy scripts without explicit permission",
      "type": "feedback",
      "body": "Rule: never run deploy-scripts/* unless the user explicitly asked.\\n\\n**Why:** user said on 2026-04-17 'nao fode deploy sem ordem'.\\n**How to apply:** block deploy commands; ask first."
    }
  ]
}

Rules for each entry:
- name: snake_case, ≤ 50 chars, descriptive
- description: one line, ≤ 150 chars
- type: one of "user", "feedback", "project", "reference"
- body: Markdown. For feedback/project, include "**Why:**" and "**How to apply:**" lines
- If nothing worth saving, return {"memories": []}
- Maximum 3 memories per extraction — be selective`;

const MAX_RECENT_MESSAGES = 24;

interface ExtractedMemory {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  body: string;
}

/**
 * Run the extractor. Non-blocking — caller should not await if they want
 * this to happen in the background. Swallows all errors silently.
 */
export async function extractAndSaveMemories(ctx: ReplContext): Promise<ExtractedMemory[]> {
  try {
    if (!ctx.messages || ctx.messages.length < 4) return [];
    const recent = ctx.messages.slice(-MAX_RECENT_MESSAGES);

    // Check if there's been any user correction or explicit rule. Skip
    // extraction for purely informational chat (saves tokens).
    const userText = recent
      .filter((m: ChatMessage) => m.role === 'user')
      .map((m: ChatMessage) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n');
    if (!looksLikeMemoryWorthy(userText)) return [];

    const transcript = recent.map((m: ChatMessage) => {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}]: ${body.substring(0, 800)}`;
    }).join('\n\n');

    // Gather "already-known" memories so the extractor doesn't repeat.
    // Use the query string as a loose matcher based on last user turn.
    const lastUser = [...recent].reverse().find((m: ChatMessage) => m.role === 'user');
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser!.content : '';
    const alreadyKnown = findRelevant(lastUserText, 10)
      .map(t => `- ${t.name}: ${t.body.substring(0, 100).replace(/\n/g, ' ')}`)
      .join('\n') || '(none)';

    const { getProvider } = require('./ai/providers');
    const provider = getProvider(ctx.provider);
    if (!provider) return [];

    const response = await provider.sendMessage({
      system: EXTRACT_SYSTEM_PROMPT + '\n\n## Already-known memories (do not duplicate)\n' + alreadyKnown,
      messages: [{
        role: 'user',
        content: 'Recent conversation:\n\n' + transcript + '\n\nExtract any durable memories as JSON.',
      }],
      tools: [],
      effort: 'low',
    }).catch(() => null);
    if (!response) return [];

    const text = (response.content || [])
      .filter((b: any) => b.type === 'text' && b.text)
      .map((b: any) => b.text)
      .join('')
      .trim();

    const json = extractJson(text);
    if (!json || !Array.isArray(json.memories)) return [];

    const saved: ExtractedMemory[] = [];
    for (const entry of json.memories) {
      if (!isValidMemory(entry)) continue;
      const existing = findRelevant(entry.name, 1);
      if (existing.length > 0 && existing[0].name === entry.name) continue; // duplicate
      saveTopic({
        name: entry.name,
        body: buildFrontmatter(entry) + entry.body.trim() + '\n',
        tags: [entry.type],
      });
      saved.push(entry);
    }
    return saved;
  } catch {
    return [];
  }
}

function buildFrontmatter(e: ExtractedMemory): string {
  return `---\nname: ${e.name}\ndescription: ${escapeYaml(e.description)}\ntype: ${e.type}\nautoExtracted: true\n---\n\n`;
}

function escapeYaml(s: string): string {
  if (/[:#]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

function isValidMemory(e: any): e is ExtractedMemory {
  return e
    && typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 60
    && /^[a-z0-9_]+$/i.test(e.name)
    && typeof e.description === 'string' && e.description.length > 0 && e.description.length <= 200
    && ['user', 'feedback', 'project', 'reference'].includes(e.type)
    && typeof e.body === 'string' && e.body.length > 10 && e.body.length <= 3000;
}

/**
 * Extract the first JSON object from the LLM response, tolerating
 * surrounding prose / code fences.
 */
function extractJson(text: string): any | null {
  // Try code-fenced JSON first
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (err) { swallow(err); }
  }
  // Then find the outermost { ... }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.substring(first, last + 1)); } catch (err) { swallow(err); }
  }
  return null;
}

/**
 * Quick heuristic: does the user text contain words that commonly signal
 * a memory-worthy statement? Avoids firing the extractor on every single
 * turn — only when there's a decent chance of finding something.
 */
function looksLikeMemoryWorthy(userText: string): boolean {
  const signals = [
    'never', 'nunca', 'nao', 'não', 'sempre', 'always',
    'prefer', 'prefiro', 'quero', 'want',
    'please', 'por favor',
    'rule', 'regra',
    'remember', 'lembra', 'lembre',
    'dont', "don't", 'nao faz', 'não faz',
    'like', 'hate', 'odeio',
    'uses', 'usa', 'utiliza',
    'is tracked in', 'esta em', 'é em',
  ];
  const lower = userText.toLowerCase();
  return signals.some(s => lower.includes(s));
}
