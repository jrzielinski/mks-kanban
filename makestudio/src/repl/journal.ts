import { swallow } from '../utils/log';
/**
 * journal.ts — append-only daily memory log.
 *
 * For every assistant turn, append a short entry to
 * `~/.makestudio/memory/journal/YYYY-MM-DD.md`. Today's entries are loaded
 * back into the system prompt so the agent can refer to "what we did
 * earlier today" without scanning the full chat history.
 *
 * Different from MEMORY.md — that's the curated long-term store. This is
 * raw, time-ordered, append-only. Think of MEMORY.md as a notebook and
 * the journal as a Slack channel.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const JOURNAL_DIR = path.join(os.homedir(), '.makestudio', 'memory', 'journal');

/** Cap on per-entry length so a runaway response doesn't bloat the log. */
const MAX_ENTRY_CHARS = 600;
/** When loading today's journal back into the prompt, never inject more
 *  than this much text — otherwise the journal can crowd out the actual
 *  conversation. */
const MAX_PROMPT_CHARS = 4_000;

function todayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayFile(): string {
  return path.join(JOURNAL_DIR, `${todayStamp()}.md`);
}

function ensureDir(): void {
  try { fs.mkdirSync(JOURNAL_DIR, { recursive: true }); } catch (err) { swallow(err); }
}

/**
 * Append a one-line entry to today's journal. The entry is the text the
 * user typed and a compact summary of what the agent did or said in
 * response. Best-effort — failures are silent so a disk hiccup never
 * breaks the chat.
 *
 * `userInput` is what the user said; `assistantSummary` is an
 * already-summarised record of the agent's response (one line, ideally
 * under 200 chars). Caller picks what to summarise — chat.ts uses the
 * first sentence + tool count.
 */
export function appendJournalEntry(userInput: string, assistantSummary: string): void {
  ensureDir();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const u = (userInput || '').slice(0, MAX_ENTRY_CHARS).replace(/\n+/g, ' ').trim();
  const a = (assistantSummary || '').slice(0, MAX_ENTRY_CHARS).replace(/\n+/g, ' ').trim();
  if (!u && !a) return;
  const entry = `\n## ${ts}\n**user:** ${u}\n**agent:** ${a}\n`;
  try { fs.appendFileSync(todayFile(), entry, 'utf8'); } catch (err) { swallow(err); }
}

/**
 * Load today's (and optionally yesterday's) journal so the system prompt
 * can include them. Returns at most MAX_PROMPT_CHARS of text, with the
 * tail (latest entries) preferred when truncation is needed — earlier
 * stuff is more likely to be in the conversation context already.
 */
export function loadRecentJournal(opts?: { includeYesterday?: boolean }): string {
  const days: string[] = [];
  try {
    if (fs.existsSync(todayFile())) {
      days.push(fs.readFileSync(todayFile(), 'utf8'));
    }
    if (opts?.includeYesterday) {
      const yest = new Date(Date.now() - 24 * 3600 * 1000);
      const f = path.join(JOURNAL_DIR, `${todayStamp(yest)}.md`);
      if (fs.existsSync(f)) days.unshift(fs.readFileSync(f, 'utf8'));
    }
  } catch (err) { swallow(err); }
  if (days.length === 0) return '';
  let combined = days.join('\n\n---\n\n').trim();
  if (combined.length > MAX_PROMPT_CHARS) {
    // Keep the tail — most recent matters most.
    combined = '… (older entries truncated) …\n\n' + combined.slice(-MAX_PROMPT_CHARS);
  }
  return combined;
}

/**
 * Format a loaded journal blob as a system-prompt section. Empty string
 * when nothing to show, so the caller can concatenate unconditionally.
 */
export function formatJournalForPrompt(blob: string): string {
  if (!blob.trim()) return '';
  return `## Recent journal (today's session log)\n\n${blob}`;
}
