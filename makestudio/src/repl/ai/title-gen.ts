import { swallow } from '../../utils/log';
/**
 * title-gen.ts — auto-generate a session title from the first user
 * message so /sessions shows "Refactoring auth middleware" instead of
 * "session-2026-04-25T15-32-41".
 *
 * Fires ONCE per session, after the first assistant response. Reads the
 * title prompt from agent/templates/prompts/title.txt (ported verbatim
 * from opencode), calls the active provider with a tight token budget,
 * and persists the result via renameSession.
 *
 * Failure modes are silent — a missing title is normal (sessions
 * without one still work, /sessions just falls back to the firstUser
 * message). Never blocks the main chat path.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplContext } from '../context';
import { renameSession, currentSessionFile, loadSessionMessages } from '../sessions';

/** Cap so the title generation never spends much. The prompt itself is
 *  ~1.5K chars; the user message preview is the only variable. */
const MAX_USER_PREVIEW_CHARS = 1_000;
/** Output budget — the prompt asks for ≤50 chars, but Anthropic models
 *  with extended thinking enabled burn the first ~1024 tokens reasoning
 *  before emitting a text block. With a tight budget they hit the
 *  `length` stop with ONLY a `thinking` block and no text output, so the
 *  title comes back empty. 2048 covers the 1024 min thinking budget plus
 *  headroom for the ~15-token title. Cost is trivial (≤$0.0002/title). */
const TITLE_MAX_TOKENS = 2_048;

function findTitlePromptFile(): string | null {
  const candidates: string[] = [];
  try {
    const here = __dirname;
    candidates.push(path.join(here, '..', '..', 'templates', 'prompts', 'title.txt'));
    candidates.push(path.join(here, '..', '..', '..', 'templates', 'prompts', 'title.txt'));
    candidates.push(path.join(here, '..', 'templates', 'prompts', 'title.txt'));
  } catch (err) { swallow(err); }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (err) { swallow(err); }
  }
  return null;
}

function loadTitlePrompt(): string | null {
  const f = findTitlePromptFile();
  if (!f) return null;
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
}

function cleanTitle(raw: string): string {
  let t = (raw || '').trim();
  // Strip the model's tendency to quote the title.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  // Some providers prepend "Title: " — drop that.
  t = t.replace(/^title\s*:\s*/i, '');
  // Collapse whitespace.
  t = t.replace(/\s+/g, ' ');
  // Hard cap at 60 chars (50 is the prompt target; allow a little slack).
  if (t.length > 60) t = t.slice(0, 57) + '...';
  return t;
}

/**
 * Already-titled? Reads the active session's JSONL header without
 * loading the whole file. Used to skip generation for resumed sessions
 * that already have a title.
 */
function sessionAlreadyHasTitle(sessionFile: string): boolean {
  try {
    const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').slice(0, 5);
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const obj = JSON.parse(ln);
      if (obj && obj.type === 'header') {
        return typeof obj.title === 'string' && obj.title.length > 0;
      }
    }
  } catch (err) { swallow(err); }
  return false;
}

/**
 * Fire title generation for the current session. Idempotent — if the
 * session already has a title, returns immediately. Best-effort —
 * provider failures are swallowed so the chat path is never affected.
 *
 * Caller invokes after the first assistant response completes. The
 * function checks the persisted session messages to know whether this
 * is the FIRST turn (only fires then).
 */
export async function maybeGenerateSessionTitle(ctx: ReplContext): Promise<void> {
  // Always-on diagnostic — writes one JSONL line per event to
  // ~/.makestudio/title-gen.log. Cheap (≤200 bytes per turn) and lets us
  // diagnose silent failures without forcing the user to enable DEBUG mode
  // or scroll through the Electron terminal.
  const log = (msg: string, extra?: Record<string, unknown>): void => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        msg,
        provider: ctx.provider,
        ...extra,
      }) + '\n';
      const logFile = path.join(os.homedir(), '.makestudio', 'title-gen.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line);
    } catch (err) { swallow(err); }
  };
  log('start');

  let sessionFile: string | null = null;
  try { sessionFile = currentSessionFile(ctx); } catch (err) { swallow(err); }
  if (!sessionFile) { log('skip: no session file bound'); return; }
  if (sessionAlreadyHasTitle(sessionFile)) { log('skip: already has title'); return; }

  // Only fire on the first turn. After that the session has a title
  // already (set on the first call) or stayed untitled deliberately.
  let messages: { role: string; content: string }[];
  try { messages = loadSessionMessages(sessionFile) as any; } catch (err) { log('skip: loadSessionMessages threw', { err: String(err) }); return; }
  // First-turn signature: exactly one user + one assistant message.
  const userCount = messages.filter((m) => m.role === 'user').length;
  if (userCount !== 1) { log('skip: not first turn', { userCount }); return; }

  const firstUser = messages.find((m) => m.role === 'user');
  const userText = typeof firstUser?.content === 'string'
    ? firstUser.content
    : JSON.stringify(firstUser?.content || '');
  if (!userText.trim()) { log('skip: empty user text'); return; }

  const sysPrompt = loadTitlePrompt();
  if (!sysPrompt) { log('skip: title prompt not found on disk'); return; }

  // Make the call. We use the same provider the user has configured —
  // titles are short so latency / token cost is negligible.
  let provider: any;
  try {
    const { getProvider } = require('./providers');
    provider = getProvider(ctx.provider);
  } catch (err) { log('skip: getProvider threw', { err: String(err) }); return; }
  if (!provider?.sendMessage) { log('skip: provider has no sendMessage'); return; }

  const userPreview = userText.slice(0, MAX_USER_PREVIEW_CHARS);
  let title = '';
  try {
    const response = await provider.sendMessage({
      system: sysPrompt,
      messages: [{ role: 'user', content: userPreview }],
      tools: [],
      effort: 'low',
      maxTokens: TITLE_MAX_TOKENS,
    });
    // Provider returns content blocks — pull the first text one.
    const blocks = Array.isArray(response?.content) ? response.content : [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        title = b.text;
        break;
      }
    }
    if (!title) {
      log('provider returned no text block', {
        stopReason: response?.stopReason,
        blockTypes: blocks.map((b: any) => b?.type),
        blockCount: blocks.length,
      });
    }
  } catch (err: any) {
    log('provider.sendMessage threw', {
      err: String(err?.message || err),
      status: err?.response?.status,
      data: err?.response?.data,
    });
    return;
  }

  const cleaned = cleanTitle(title);
  if (!cleaned) { log('skip: title empty after cleanup', { raw: title }); return; }
  let renamed = false;
  try { renamed = renameSession(sessionFile, cleaned); } catch (err) { log('renameSession threw', { err: String(err) }); }
  if (!renamed) { log('skip: renameSession returned false'); return; }
  log('ok: session renamed', { title: cleaned });

  // Notify renderer (Electron) so the sessions list refreshes immediately
  // instead of waiting for the 10s staleTime / window-focus refetch. No-op
  // when running in TUI / no broadcaster registered.
  try {
    const { broadcast } = require('../ipc/broadcast');
    const { EVT_SESSIONS_UPDATED } = require('../ipc/channels');
    broadcast(EVT_SESSIONS_UPDATED, {
      reason: 'auto-title',
      file: sessionFile,
      title: cleaned,
    });
  } catch (err) { swallow(err); }
}
