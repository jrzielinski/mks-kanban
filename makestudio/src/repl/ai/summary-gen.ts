import { swallow } from '../../utils/log';
/**
 * summary-gen.ts — produce a PR-style summary of the current session and
 * persist it to the session header.
 *
 * Mirrors title-gen.ts (same template-loader / provider-call pattern,
 * same silent-failure semantics), but consumes the full conversation
 * instead of just the first user message and uses the
 * `agent/templates/prompts/summary.txt` prompt (ported verbatim from
 * opencode).
 *
 * The result is saved via setSessionSummary so /sessions can show it
 * alongside the title. Triggered manually via `/summary write` — never
 * fires automatically because LLM cost should be opt-in for a feature
 * the user may not need.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReplContext } from '../context';
import { currentSessionFile, setSessionSummary } from '../sessions';

/** Hard cap on input — long sessions get tail-preferred truncation since
 *  the most recent decisions matter most for the summary. */
const MAX_INPUT_CHARS = 60_000;
const SUMMARY_MAX_TOKENS = 200;

function findSummaryPromptFile(): string | null {
  const candidates: string[] = [];
  try {
    const here = __dirname;
    candidates.push(path.join(here, '..', '..', 'templates', 'prompts', 'summary.txt'));
    candidates.push(path.join(here, '..', '..', '..', 'templates', 'prompts', 'summary.txt'));
    candidates.push(path.join(here, '..', 'templates', 'prompts', 'summary.txt'));
  } catch (err) { swallow(err); }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (err) { swallow(err); }
  }
  return null;
}

function loadSummaryPrompt(): string | null {
  const f = findSummaryPromptFile();
  if (!f) return null;
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
}

/**
 * Render the conversation as plain text the model can summarise. Drops
 * tool-call internals (those bloat the input without helping the
 * summary) and keeps just user/assistant text.
 */
function flattenConversation(ctx: ReplContext): string {
  const parts: string[] = [];
  for (const m of ctx.messages || []) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? (m.content as any[])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
        : '';
    if (!text.trim()) continue;
    parts.push(`### ${m.role}\n${text}`);
  }
  let combined = parts.join('\n\n');
  if (combined.length > MAX_INPUT_CHARS) {
    combined = '… (older turns truncated) …\n\n' + combined.slice(-MAX_INPUT_CHARS);
  }
  return combined;
}

/**
 * Generate and persist a PR-style summary for the active session.
 * Returns the summary text on success, or null when no work was done
 * (no session file, no messages, prompt template missing, provider
 * failure, etc.). Caller can show the result inline.
 */
export async function generateSessionSummary(ctx: ReplContext): Promise<string | null> {
  const sessionFile = currentSessionFile(ctx);
  if (!sessionFile) return null;
  if (!ctx.messages || ctx.messages.length === 0) return null;

  const sysPrompt = loadSummaryPrompt();
  if (!sysPrompt) return null;

  const conversation = flattenConversation(ctx);
  if (!conversation.trim()) return null;

  let provider: any;
  try {
    const { getProvider } = require('./providers');
    provider = getProvider(ctx.provider);
  } catch { return null; }
  if (!provider?.sendMessage) return null;

  let summary = '';
  try {
    const response = await provider.sendMessage({
      system: sysPrompt,
      messages: [{ role: 'user', content: conversation }],
      tools: [],
      effort: 'low',
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    const blocks = Array.isArray(response?.content) ? response.content : [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        summary = b.text;
        break;
      }
    }
  } catch { return null; }

  summary = summary.trim();
  if (!summary) return null;
  // Strip "Summary:" prefix some models add despite the prompt.
  summary = summary.replace(/^summary\s*:\s*/i, '').trim();
  try { setSessionSummary(sessionFile, summary); } catch (err) { swallow(err); }
  return summary;
}
