import { swallow } from '../utils/log';
/**
 * session-search.ts
 *
 * Port of Claude Code's utils/agenticSessionSearch.ts. Usage:
 *
 *   /search <query>
 *
 * 1. Collects all session summaries for the current cwd (listSessions).
 * 2. Pre-filters those whose metadata contains the query literal.
 * 3. Fills up to MAX_SESSIONS_TO_SEARCH entries (adds recent non-matching
 *    ones for context if matches are sparse).
 * 4. Sends the session list + query to a small fast model using
 *    SESSION_SEARCH_SYSTEM_PROMPT. Model returns {"relevant_indices":[...]}.
 * 5. We map indices back to summaries and present a ranked list.
 *
 * `SESSION_SEARCH_SYSTEM_PROMPT` and the constants below are VERBATIM
 * from claude-code/src/utils/agenticSessionSearch.ts:11-48.
 */

import * as fs from 'fs';
import { ChatMessage, ReplContext } from './context';
import { listSessions, loadSessionMessages, SessionSummary } from './sessions';
import { getProvider } from './ai/providers';

// Verbatim constants from Claude Code.
export const MAX_TRANSCRIPT_CHARS = 2000;
export const MAX_MESSAGES_TO_SCAN = 100;
export const MAX_SESSIONS_TO_SEARCH = 100;

// Verbatim system prompt from Claude Code agenticSessionSearch.ts:15-48.
export const SESSION_SEARCH_SYSTEM_PROMPT = `Your goal is to find relevant sessions based on a user's search query.

You will be given a list of sessions with their metadata and a search query. Identify which sessions are most relevant to the query.

Each session may include:
- Title (display name or custom title)
- Tag (user-assigned category, shown as [tag: name] - users tag sessions with /tag command to categorize them)
- Branch (git branch name, shown as [branch: name])
- Summary (AI-generated summary)
- First message (beginning of the conversation)
- Transcript (excerpt of conversation content)

IMPORTANT: Tags are user-assigned labels that indicate the session's topic or category. If the query matches a tag exactly or partially, those sessions should be highly prioritized.

For each session, consider (in order of priority):
1. Exact tag matches (highest priority - user explicitly categorized this session)
2. Partial tag matches or tag-related terms
3. Title matches (custom titles or first message content)
4. Branch name matches
5. Summary and transcript content matches
6. Semantic similarity and related concepts

CRITICAL: Be VERY inclusive in your matching. Include sessions that:
- Contain the query term anywhere in any field
- Are semantically related to the query (e.g., "testing" matches sessions about "tests", "unit tests", "QA", etc.)
- Discuss topics that could be related to the query
- Have transcripts that mention the concept even in passing

When in doubt, INCLUDE the session. It's better to return too many results than too few. The user can easily scan through results, but missing relevant sessions is frustrating.

Return sessions ordered by relevance (most relevant first). If truly no sessions have ANY connection to the query, return an empty array - but this should be rare.

Respond with ONLY the JSON object, no markdown formatting:
{"relevant_indices": [2, 5, 0]}`;

// ── Transcript extraction (verbatim port from lines 57-108) ──────────────

function extractMessageText(msg: ChatMessage): string {
  if (msg.role !== 'user' && msg.role !== 'assistant') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return (c as any[])
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Pure, exported for testability. */
export function extractTranscript(
  messages: ChatMessage[],
  maxChars: number = MAX_TRANSCRIPT_CHARS,
  maxScan: number = MAX_MESSAGES_TO_SCAN,
): string {
  if (messages.length === 0) return '';
  const scanned = messages.length <= maxScan
    ? messages
    : [
        ...messages.slice(0, maxScan / 2),
        ...messages.slice(-maxScan / 2),
      ];
  const text = scanned
    .map(extractMessageText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

// ── Pre-filter (verbatim port from lines 113-140, adapted to our fields) ──

export function summaryContainsQuery(summary: SessionSummary, transcript: string, queryLower: string): boolean {
  if ((summary.title || '').toLowerCase().includes(queryLower)) return true;
  if ((summary.tag || '').toLowerCase().includes(queryLower)) return true;
  if ((summary.firstUserMessage || '').toLowerCase().includes(queryLower)) return true;
  if (transcript && transcript.toLowerCase().includes(queryLower)) return true;
  return false;
}

// ── Prompt builder ───────────────────────────────────────────────────────

export interface EnrichedSummary {
  summary: SessionSummary;
  transcript: string;
}

export function buildSessionList(enriched: EnrichedSummary[]): string {
  return enriched.map((e, i) => {
    const s = e.summary;
    const parts: string[] = [`${i}:`];
    parts.push(s.title || s.firstUserMessage?.slice(0, 60) || '(no title)');
    if (s.tag) parts.push(`[tag: ${s.tag}]`);
    if (s.firstUserMessage) parts.push(`- First message: ${s.firstUserMessage.slice(0, 300)}`);
    if (e.transcript) parts.push(`- Transcript: ${e.transcript}`);
    return parts.join(' ');
  }).join('\n');
}

// ── Response parser ──────────────────────────────────────────────────────

export interface SearchResult {
  relevant_indices: number[];
}

export function parseSearchResponse(raw: string): number[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed: SearchResult = JSON.parse(match[0]);
    const arr = Array.isArray(parsed.relevant_indices) ? parsed.relevant_indices : [];
    return arr.filter(n => Number.isInteger(n) && n >= 0);
  } catch { return []; }
}

// ── Main API ─────────────────────────────────────────────────────────────

export interface SearchHit {
  summary: SessionSummary;
  rank: number;        // 0 = most relevant
  tagMatch: boolean;   // exact-tag hit → highlighted
}

/**
 * Perform the full search flow. Returns ranked hits. Empty array when
 * query is empty, no sessions exist, the model returns nothing useful,
 * or the provider call fails.
 */
export async function agenticSessionSearch(
  query: string,
  ctx: ReplContext,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const summaries = listSessions(ctx.cwd, 1000);
  if (summaries.length === 0) return [];
  const queryLower = q.toLowerCase();

  // Enrich each summary with its transcript once (used by pre-filter + prompt).
  const enrichedAll: EnrichedSummary[] = summaries.map(s => {
    let transcript = '';
    try { transcript = extractTranscript(loadSessionMessages(s.file)); }
    catch (err) { swallow(err); }
    return { summary: s, transcript };
  });

  const matching = enrichedAll.filter(e => summaryContainsQuery(e.summary, e.transcript, queryLower));

  let toSearch: EnrichedSummary[];
  if (matching.length >= MAX_SESSIONS_TO_SEARCH) {
    toSearch = matching.slice(0, MAX_SESSIONS_TO_SEARCH);
  } else {
    const nonMatching = enrichedAll.filter(e => !summaryContainsQuery(e.summary, e.transcript, queryLower));
    toSearch = [...matching, ...nonMatching.slice(0, MAX_SESSIONS_TO_SEARCH - matching.length)];
  }

  const provider = getProvider(ctx.provider);
  if (!provider.sendMessage) return [];

  const userMessage = `Sessions:\n${buildSessionList(toSearch)}\n\nSearch query: "${q}"\n\nFind the sessions that are most relevant to this query.`;
  try {
    const response = await provider.sendMessage({
      system: SESSION_SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [],
      effort: 'low',
      // @ts-ignore — some providers ignore signal
      signal,
    } as any);
    const raw: string = (response?.content || [])
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('');
    const indices = parseSearchResponse(raw);
    return indices
      .filter(i => i < toSearch.length)
      .map((i, rank) => {
        const s = toSearch[i].summary;
        const tagMatch = !!(s.tag && s.tag.toLowerCase().includes(queryLower));
        return { summary: s, rank, tagMatch };
      });
  } catch { return []; }
}
