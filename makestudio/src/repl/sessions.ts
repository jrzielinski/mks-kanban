import { swallow } from '../utils/log';
/**
 * sessions.ts
 *
 * REPL session persistence — mirrors the `-c / --continue` flow.
 * Each REPL session writes every user/assistant message to a JSONL file
 * under ~/.makestudio/sessions/<cwd-slug>/<session-uuid>.jsonl.
 *
 * On startup, `--continue` loads the most recent session for the current
 * cwd and hydrates ctx.messages. `--resume <uuid>` loads a specific one.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ChatMessage, ReplContext } from './context';

interface SessionEntry {
  type: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Optional TUI override — see ChatMessage.displayText. */
  displayText?: string;
}

interface SessionHeader {
  type: 'header';
  sessionId: string;
  startedAt: string;
  cwd: string;
  provider?: string;
  model?: string;
  /** Auto-generated or manually-set title — shown in /sessions list + search. */
  title?: string;
  /** Manual tags (user-assigned via /tag) for filtering sessions. */
  tags?: string[];
  /** One-paragraph summary, regenerated on /compact or at session end. */
  summary?: string;
}

export interface SessionSummary {
  sessionId: string;
  file: string;
  startedAt: string;
  lastUpdatedAt: string;
  cwd: string;
  messageCount: number;
  firstUserMessage?: string;
  title?: string;
  /** Single tag assigned via /tag (if any). */
  tag?: string;
  /** All tags (multi-tag support). */
  tags?: string[];
  /** One-paragraph summary for session search. */
  summary?: string;
}

function sessionsRoot(): string {
  return path.join(os.homedir(), '.makestudio', 'sessions');
}

function cwdSlug(cwd: string): string {
  return cwd
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

function sessionsDirFor(cwd: string): string {
  const dir = path.join(sessionsRoot(), cwdSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newSessionId(): string {
  return crypto.randomUUID();
}

// ── Per-ReplContext session file (lazily created on first append) ──────────

const ctxSessionFile: WeakMap<ReplContext, string> = new WeakMap();

function ensureSessionFile(ctx: ReplContext): string {
  let f = ctxSessionFile.get(ctx);
  if (f) return f;
  const dir = sessionsDirFor(ctx.cwd);
  const id = newSessionId();
  f = path.join(dir, `${id}.jsonl`);
  const header: SessionHeader = {
    type: 'header',
    sessionId: id,
    startedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    provider: ctx.providerInfo?.provider,
    model: ctx.providerInfo?.model,
  };
  fs.writeFileSync(f, JSON.stringify(header) + '\n', 'utf8');
  ctxSessionFile.set(ctx, f);
  return f;
}

/**
 * Bind this ReplContext to an existing session file (used when resuming).
 */
export function bindSessionFile(ctx: ReplContext, file: string): void {
  ctxSessionFile.set(ctx, file);
}

/**
 * Unbind the ctx from its current session file. The next `appendMessage`
 * call will lazily create a fresh session via `ensureSessionFile`. Used by
 * the "new chat" path (AGENT_CLEAR in the Electron main) so a `clearConversation`
 * after a resume actually starts a new on-disk session instead of continuing
 * to append to the old file.
 */
export function unbindSessionFile(ctx: ReplContext): void {
  ctxSessionFile.delete(ctx);
}

export function currentSessionFile(ctx: ReplContext): string | null {
  return ctxSessionFile.get(ctx) || null;
}

/** Files for which we've already broadcast EVT_SESSIONS_UPDATED on their
 *  first appended message. Lets `appendMessage` fire the broadcast exactly
 *  once per new session so the renderer's sidebar can show the new chat
 *  immediately (with the firstUserMessage fallback label) without waiting
 *  for the auto-title's later broadcast. Subsequent appends don't broadcast
 *  to avoid spamming refetches on every assistant chunk / tool call. */
const broadcastedNewFiles = new Set<string>();

export function appendMessage(ctx: ReplContext, msg: ChatMessage): void {
  let f: string;
  let isFirstAppend = false;
  try {
    f = ensureSessionFile(ctx);
    isFirstAppend = !broadcastedNewFiles.has(f);
    const entry: SessionEntry = {
      type: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      timestamp: new Date().toISOString(),
    };
    if ((msg as any).displayText) entry.displayText = String((msg as any).displayText);
    fs.appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* best effort — never break the chat because of persistence */ return; }

  if (isFirstAppend) {
    broadcastedNewFiles.add(f);
    try {
      const { broadcast } = require('./ipc/broadcast');
      const { EVT_SESSIONS_UPDATED } = require('./ipc/channels');
      // path basename = "<uuid>.jsonl"; strip extension for sessionId so the
      // sidebar can set this as activeId without a separate IPC roundtrip.
      const sessionId = path.basename(f, '.jsonl');
      broadcast(EVT_SESSIONS_UPDATED, { reason: 'new-session', file: f, sessionId });
    } catch (err) { swallow(err); }
  }
}

/**
 * Rewrite the session file with a new message list. Used after operations
 * that mutate `ctx.messages` in place (notably /compact, which collapses
 * N messages into a single summary + last-N tail). Without this, the jsonl
 * still has every original message — the next process boot replays the
 * pre-compact history and the user thinks "compact didn't work".
 *
 * Atomic: writes to `<file>.tmp`, fsyncs, then renames over the original
 * so a crash mid-rewrite leaves either the old file or the new file —
 * never a partial truncated jsonl that loadSessionMessages would parse
 * as an inconsistent transcript.
 */
export function rewriteSession(ctx: ReplContext, messages: ChatMessage[]): void {
  const f = currentSessionFile(ctx);
  if (!f) return;
  let header: SessionHeader | null = null;
  try {
    const firstLine = fs.readFileSync(f, 'utf8').split('\n', 1)[0];
    const parsed = JSON.parse(firstLine);
    if (parsed?.type === 'header') header = parsed as SessionHeader;
  } catch (err) { swallow(err); }
  if (!header) {
    // No header? Synthesise one from the bound file path so the rewrite
    // doesn't lose the session id reference downstream tools rely on.
    const id = path.basename(f).replace(/\.jsonl$/, '');
    header = {
      type: 'header',
      sessionId: id,
      startedAt: new Date().toISOString(),
      cwd: ctx.cwd,
      provider: ctx.providerInfo?.provider,
      model: ctx.providerInfo?.model,
    };
  }

  const lines: string[] = [JSON.stringify(header)];
  const ts = new Date().toISOString();
  for (const msg of messages) {
    const entry: SessionEntry = {
      type: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      timestamp: ts,
    };
    if ((msg as any).displayText) entry.displayText = String((msg as any).displayText);
    lines.push(JSON.stringify(entry));
  }
  const body = lines.join('\n') + '\n';

  const tmp = f + '.tmp';
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, f);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err) { swallow(err); }
    throw err;
  }
}

// ── Conversation recovery ─────────────────────────────────────────────────
//
// Port of Claude Code's utils/conversationRecovery.ts, specifically the
// "detect interrupted session" bit. Claude Code's file is mostly about
// message migration across versions; the crash-recovery semantic that
// matters for us is: "the last persisted message was a user turn with no
// assistant reply — likely the REPL crashed / was killed mid-stream."
//
// We don't add new JSONL entry types; we infer from message sequence.

export interface RecoveryStatus {
  /** True when the session looks interrupted (last message is a user turn). */
  interrupted: boolean;
  /** Full text of the incomplete user message (so caller can offer /retry). */
  lastUserMessage?: string;
  /** Total persisted messages. */
  messageCount: number;
  /** When the last assistant turn had a tool_use block that never received
   *  a tool_result, this carries the tool name + input so /retry can suggest
   *  "retry the Bash call that was running". Port of Claude Code session
   *  recovery: inferring WHICH tool crashed from transcript depth. */
  lastToolInFlight?: { name: string; input?: any };
}

/**
 * Inspect a session file and decide whether the last turn was interrupted.
 * Safe for use immediately after `loadSessionMessages`.
 */
export function detectInterrupted(file: string): RecoveryStatus {
  let messages: ChatMessage[] = [];
  try { messages = loadSessionMessages(file); } catch { return { interrupted: false, messageCount: 0 }; }
  if (messages.length === 0) return { interrupted: false, messageCount: 0 };
  const last = messages[messages.length - 1];

  // Case A: last message is a user turn — session died before assistant replied.
  if (last.role === 'user') {
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    return { interrupted: true, lastUserMessage: content, messageCount: messages.length };
  }

  // Case B: last message is assistant with a tool_use that never got a
  // tool_result — session died mid-tool. Surface the tool name so /retry
  // can suggest resuming that specific tool instead of the whole turn.
  if (last.role === 'assistant') {
    const content = Array.isArray(last.content) ? last.content : [];
    const toolUse = content.find((b: any) => b && b.type === 'tool_use');
    if (toolUse) {
      // Walk backward to find the user prompt that triggered this turn.
      let priorUser: string | undefined;
      for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const c = messages[i].content;
          priorUser = typeof c === 'string' ? c : JSON.stringify(c);
          break;
        }
      }
      return {
        interrupted: true,
        lastUserMessage: priorUser,
        messageCount: messages.length,
        lastToolInFlight: { name: (toolUse as any).name, input: (toolUse as any).input },
      };
    }
  }

  return { interrupted: false, messageCount: messages.length };
}

/**
 * Alternative recovery form: detects a session whose LAST assistant message
 * ends with the "(request cancelled)" marker our streaming path writes on
 * abort. Useful for surfacing "you pressed Esc twice last time — retry?".
 */
export function detectCancelled(file: string): boolean {
  try {
    const messages = loadSessionMessages(file);
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return false;
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    return content.includes('(request cancelled)');
  } catch { return false; }
}

// ── Listing & loading ──────────────────────────────────────────────────────

export function listSessions(cwd: string, limit: number = 30): SessionSummary[] {
  const dir = sessionsDirFor(cwd);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  } catch { return []; }

  const summaries: SessionSummary[] = [];
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (lines.length === 0) continue;
      const header = safeJson<SessionHeader>(lines[0]);
      if (!header || header.type !== 'header') continue;
      const messages = lines.slice(1).map(l => safeJson<SessionEntry>(l)).filter(Boolean) as SessionEntry[];
      const firstUser = messages.find(m => m.type === 'user');
      summaries.push({
        sessionId: header.sessionId,
        file: f,
        startedAt: header.startedAt,
        lastUpdatedAt: stat.mtime.toISOString(),
        cwd: header.cwd,
        messageCount: messages.length,
        firstUserMessage: firstUser?.content.slice(0, 120),
        title: (header as any).title,
        tag: (header as any).tag,
        tags: Array.isArray((header as any).tags) ? (header as any).tags : undefined,
        summary: (header as any).summary,
      });
    } catch (err) { swallow(err); }
  }
  summaries.sort((a, b) => (b.lastUpdatedAt.localeCompare(a.lastUpdatedAt)));
  return summaries.slice(0, limit);
}

export function loadSessionMessages(file: string): ChatMessage[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out: ChatMessage[] = [];
  for (const ln of lines) {
    const e = safeJson<any>(ln);
    if (!e || e.type === 'header') continue;
    if (e.type === 'user' || e.type === 'assistant') {
      let content: any = e.content;
      // appendMessage JSON.stringifies array content — restore the array so that
      // ctx.messages has proper structured blocks (API calls + TUI display).
      if (typeof content === 'string' && (content.startsWith('[') || content.startsWith('{'))) {
        try { content = JSON.parse(content); } catch (err) { swallow(err); }
      }
      const msg: ChatMessage = { role: e.type, content };
      if (e.displayText) msg.displayText = String(e.displayText);
      out.push(msg);
    }
  }
  return out;
}

export function loadMostRecent(cwd: string): SessionSummary | null {
  const list = listSessions(cwd, 1);
  return list[0] || null;
}

/**
 * Rename a session file's in-header `title` for friendlier `/sessions` listing.
 * Currently appends the title to the header (non-breaking change).
 */
export function renameSession(file: string, title: string): boolean {
  return updateSessionHeader(file, (h) => { h.title = title; });
}

/** Write/overwrite the session's `summary` field — called by /compact or
 *  at session end to produce a searchable one-paragraph digest. */
export function setSessionSummary(file: string, summary: string): boolean {
  return updateSessionHeader(file, (h) => { h.summary = summary; });
}

/** Replace the session's `tags` array (multi-tag support; coexists with the
 *  legacy single `tag` field via getCurrentSessionTag). */
export function setSessionTags(file: string, tags: string[]): boolean {
  return updateSessionHeader(file, (h) => {
    h.tags = Array.from(new Set(tags.map((t) => String(t).trim()).filter(Boolean)));
  });
}

/** Internal helper — in-place update of the JSONL header line. */
function updateSessionHeader(file: string, mutate: (h: any) => void): boolean {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    if (lines.length === 0) return false;
    const header = safeJson<any>(lines[0]);
    if (!header || header.type !== 'header') return false;
    mutate(header);
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── /tag session tagging (Claude Code port) ──────────────────────────────
//
// Port of Claude Code commands/tag + utils/sessionStorage#saveTag. One tag
// per session, stored in the JSONL header's `tag` field. Toggling the same
// tag removes it. Tags are discoverable via getSessionTagsIndex, which feeds
// agenticSessionSearch.

/** Read-only: current tag from the session file, or null. */
export function getCurrentSessionTag(file: string): string | null {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const firstLine = content.split('\n', 1)[0];
    const h = safeJson<any>(firstLine || '');
    if (!h || h.type !== 'header') return null;
    return typeof h.tag === 'string' && h.tag ? h.tag : null;
  } catch { return null; }
}

/** Set (or clear, when tag=null/'') the session tag. Returns true on success. */
export function setSessionTag(file: string, tag: string | null): boolean {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    if (lines.length === 0) return false;
    const header = safeJson<any>(lines[0]);
    if (!header || header.type !== 'header') return false;
    if (tag) header.tag = tag;
    else delete header.tag;
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return true;
  } catch { return false; }
}

/**
 * Toggle a tag: if the session already has this tag, remove it; otherwise
 * overwrite whatever tag was there. Mirrors Claude Code's /tag behaviour.
 * Returns the final state ('added' | 'removed' | 'replaced' | null on error).
 */
export function toggleSessionTag(file: string, tag: string): 'added' | 'removed' | 'replaced' | null {
  // Reject before sanitising — otherwise all-whitespace turns into '---'.
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').replace(/^-+|-+$/g, '');
  if (!sanitized) return null;
  const existing = getCurrentSessionTag(file);
  if (existing === sanitized) {
    return setSessionTag(file, null) ? 'removed' : null;
  }
  const result = setSessionTag(file, sanitized) ? (existing ? 'replaced' : 'added') : null;
  return result;
}

/**
 * Scan all sessions under cwd, return a map tag → sessionIds[]. Used by
 * agenticSessionSearch to prioritise tag matches.
 */
export function getSessionTagsIndex(cwd: string): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const s of listSessions(cwd, 1000)) {
    const tag = getCurrentSessionTag(s.file);
    if (!tag) continue;
    if (!index[tag]) index[tag] = [];
    index[tag]!.push(s.sessionId);
  }
  return index;
}

export interface ForkResult {
  oldSessionId: string;
  newSessionId: string;
  newFile: string;
  messageCount: number;
}

/**
 * Fork the ctx's current session into a new file with a fresh sessionId.
 * The ctx is re-bound to the new file so subsequent appendMessage calls
 * write to the fork; the original session file stays untouched and can
 * be resumed via `makestudio --resume <oldSessionId>` (or `makestudio -c`
 * / `--continue` to restore just the MOST RECENT session without an id).
 *
 * Port of Claude Code's `/branch` (src/commands/branch/branch.ts): same
 * semantic (copy transcript + new sessionId + record parent), simplified
 * because our JSONL lacks parentUuid chains / content-replacement entries.
 */
export function forkSession(ctx: ReplContext, title?: string): ForkResult | null {
  const current = ctxSessionFile.get(ctx);
  if (!current) return null;
  let content: string;
  try { content = fs.readFileSync(current, 'utf8'); }
  catch { return null; }

  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const oldHeader = safeJson<any>(lines[0]);
  if (!oldHeader || oldHeader.type !== 'header') return null;

  const newId = newSessionId();
  const dir = sessionsDirFor(ctx.cwd);
  const newFile = path.join(dir, `${newId}.jsonl`);

  const newHeader: any = {
    ...oldHeader,
    type: 'header',
    sessionId: newId,
    startedAt: new Date().toISOString(),
    forkedFrom: {
      sessionId: oldHeader.sessionId,
      file: current,
      forkedAt: new Date().toISOString(),
    },
  };
  if (title) newHeader.title = title;
  else if (oldHeader.title) newHeader.title = oldHeader.title + ' (Branch)';

  const bodyLines = lines.slice(1); // drop old header, keep all message entries
  fs.writeFileSync(
    newFile,
    [JSON.stringify(newHeader), ...bodyLines].join('\n') + '\n',
    'utf8',
  );

  ctxSessionFile.set(ctx, newFile);
  return {
    oldSessionId: oldHeader.sessionId,
    newSessionId: newId,
    newFile,
    messageCount: bodyLines.length,
  };
}

export function loadById(cwd: string, sessionIdOrPrefix: string): SessionSummary | null {
  const all = listSessions(cwd, 1000);
  return all.find(s =>
    s.sessionId === sessionIdOrPrefix ||
    s.sessionId.startsWith(sessionIdOrPrefix),
  ) || null;
}

function safeJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}
