import { swallow } from '../../utils/log';
/**
 * subagent-pool.ts — persistent session pool for dispatch_agent.
 *
 * When the caller passes a `session_id` to dispatch_agent, we stash the
 * running conversation (messages + metadata) keyed by (subagentType,
 * session_id) so later invocations with the same id continue instead of
 * starting from scratch.
 *
 * Two tiers:
 *   1. In-memory Map (fast-path) — same process, no disk I/O.
 *   2. On-disk JSON (persistent) — `~/.makestudio/subagent-sessions/<type>/<id>.json`.
 *      Survives CLI restarts, lets the LLM pick up yesterday's research.
 *
 * TTL defaults to 7 days. Cleanup is lazy: expired files are pruned the
 * next time loadSession / listSessions runs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface PoolEntry {
  messages: any[];
  updatedAt: number;
  createdAt: number;
  totalTokens: number;
  description?: string;
}

// 7d × 50 entries was excessive: subagent histories accumulate large message
// trails and get re-sent verbatim on every resume. Token-cost audit traced a
// big slice of the daily spend to long-lived sessions being replayed weeks
// after their last use. 24h × 15 covers normal "continue what I was doing
// yesterday" without keeping multi-day backlogs warm.
const MAX_MEMORY_ENTRIES = 15;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const memStore = new Map<string, PoolEntry>();

function sessionsRoot(): string {
  return path.join(os.homedir(), '.makestudio', 'subagent-sessions');
}

function sessionPath(subagentType: string, sessionId: string): string {
  // Sanitise: filenames may not contain slashes. Subagent types and IDs are
  // short, but custom agent names are user-controlled.
  const safeType = subagentType.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(sessionsRoot(), safeType, `${safeId}.json`);
}

function memKey(subagentType: string, sessionId: string): string {
  return `${subagentType}::${sessionId}`;
}

function logEviction(key: string, reason: 'ttl' | 'lru', ageMs: number): void {
  const msg = `[subagent-pool] evicted ${key} (${reason}, age ${(ageMs / 1000).toFixed(0)}s)`;
  try {
    const { getTuiBridge } = require('../tui/bridge');
    const bridge = getTuiBridge?.();
    if (bridge) { bridge.addMessage({ role: 'info', text: msg }); return; }
  } catch (err) { swallow(err); }
  if (process.env.MAKESTUDIO_DEBUG) process.stderr.write(msg + '\n');
}

function evictExpiredMemory(now: number): void {
  for (const [k, v] of memStore.entries()) {
    if (now - v.updatedAt > TTL_MS) {
      logEviction(k, 'ttl', now - v.updatedAt);
      memStore.delete(k);
    }
  }
}

function evictOldestMemory(): void {
  const first = memStore.keys().next();
  if (!first.done) {
    const v = memStore.get(first.value);
    if (v) logEviction(first.value, 'lru', Date.now() - v.updatedAt);
    memStore.delete(first.value);
  }
}

function readFromDisk(subagentType: string, sessionId: string): PoolEntry | null {
  const p = sessionPath(subagentType, sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.messages)) {
      return {
        messages: parsed.messages,
        updatedAt: parsed.updatedAt || 0,
        createdAt: parsed.createdAt || parsed.updatedAt || 0,
        totalTokens: parsed.totalTokens || 0,
        description: parsed.description,
      };
    }
  } catch (err) { swallow(err); }
  try { fs.unlinkSync(p); } catch (err) { swallow(err); }
  return null;
}

function writeToDisk(subagentType: string, sessionId: string, entry: PoolEntry): void {
  const p = sessionPath(subagentType, sessionId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic write: tmp file then rename. Avoids half-written JSON on crash.
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) { swallow(err); }
}

// When a resumed subagent session has more than this many messages, we
// run a cheap mini-compact on the OLD tail — keeps the last KEEP_RECENT
// turns verbatim and replaces tool_result bodies above the size threshold
// in everything older. Bounds the resume cost without making subagents
// "forget" their last few steps.
const RESUME_TRIM_THRESHOLD_MSGS = 30;
const RESUME_TRIM_KEEP_RECENT = 12;
const RESUME_TRIM_RESULT_CHARS = 600;
const RESUME_TRIM_STUB = (chars: number) =>
  `[tool_result trimmed on resume — was ${chars} chars. Re-run the tool if you need it.]`;

function trimResumedMessages(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length <= RESUME_TRIM_THRESHOLD_MSGS) {
    return messages;
  }
  const lastTouched = messages.length - RESUME_TRIM_KEEP_RECENT;
  const out = messages.slice();
  for (let i = 0; i < lastTouched; i++) {
    const m = out[i];
    if (!m) continue;
    // Anthropic format: user message with tool_result content blocks
    if (m.role === 'user' && Array.isArray(m.content)) {
      const newContent = m.content.map((block: any) => {
        if (block?.type !== 'tool_result') return block;
        const cur = typeof block.content === 'string' ? block.content : '';
        if (cur.length < RESUME_TRIM_RESULT_CHARS) return block;
        return { ...block, content: RESUME_TRIM_STUB(cur.length) };
      });
      out[i] = { ...m, content: newContent };
      continue;
    }
    // OpenAI format: tool message with content string
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length >= RESUME_TRIM_RESULT_CHARS) {
      out[i] = { ...m, content: RESUME_TRIM_STUB(m.content.length) };
    }
  }
  return out;
}

/** Load session messages (from memory, falling back to disk). */
export function loadSession(subagentType: string, sessionId: string): any[] | null {
  const now = Date.now();
  evictExpiredMemory(now);
  const k = memKey(subagentType, sessionId);

  // Memory hit.
  const mem = memStore.get(k);
  if (mem) {
    memStore.delete(k);
    memStore.set(k, { ...mem, updatedAt: now });
    return trimResumedMessages(mem.messages);
  }

  // Disk hit — rehydrate into memory.
  const disk = readFromDisk(subagentType, sessionId);
  if (disk) {
    if (now - disk.updatedAt > TTL_MS) {
      try { fs.unlinkSync(sessionPath(subagentType, sessionId)); } catch (err) { swallow(err); }
      return null;
    }
    while (memStore.size >= MAX_MEMORY_ENTRIES) evictOldestMemory();
    memStore.set(k, { ...disk, updatedAt: now });
    return trimResumedMessages(disk.messages);
  }

  return null;
}

/** Persist session messages. Called after each dispatch_agent loop completes. */
export function saveSession(
  subagentType: string,
  sessionId: string,
  messages: any[],
  opts: { tokens?: number; description?: string } = {},
): void {
  const now = Date.now();
  evictExpiredMemory(now);
  const k = memKey(subagentType, sessionId);
  const prior = memStore.get(k) || readFromDisk(subagentType, sessionId);
  const entry: PoolEntry = {
    messages,
    updatedAt: now,
    createdAt: prior?.createdAt ?? now,
    totalTokens: (prior?.totalTokens || 0) + (opts.tokens || 0),
    description: opts.description ?? prior?.description,
  };
  memStore.delete(k);
  while (memStore.size >= MAX_MEMORY_ENTRIES) evictOldestMemory();
  memStore.set(k, entry);
  writeToDisk(subagentType, sessionId, entry);
}

/** Explicit drop — removes from both memory and disk. */
export function dropSession(subagentType: string, sessionId: string): boolean {
  const k = memKey(subagentType, sessionId);
  const inMem = memStore.delete(k);
  let onDisk = false;
  try {
    const p = sessionPath(subagentType, sessionId);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      onDisk = true;
    }
  } catch (err) { swallow(err); }
  return inMem || onDisk;
}

export interface SessionSummary {
  id: string;
  subagentType: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  totalTokens: number;
  description?: string;
}

/** List all persisted sessions. Prunes expired entries along the way. */
export function listSessions(): SessionSummary[] {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const now = Date.now();
  const out: SessionSummary[] = [];
  let typeDirs: string[] = [];
  try { typeDirs = fs.readdirSync(root); } catch { return []; }
  for (const typeDir of typeDirs) {
    const typePath = path.join(root, typeDir);
    let files: string[] = [];
    try {
      const st = fs.statSync(typePath);
      if (!st.isDirectory()) continue;
      files = fs.readdirSync(typePath);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      const p = path.join(typePath, f);
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.messages)) continue;
        if (now - (parsed.updatedAt || 0) > TTL_MS) {
          try { fs.unlinkSync(p); } catch (err) { swallow(err); }
          continue;
        }
        out.push({
          id,
          subagentType: typeDir,
          createdAt: parsed.createdAt || parsed.updatedAt || 0,
          updatedAt: parsed.updatedAt || 0,
          messageCount: parsed.messages.length,
          totalTokens: parsed.totalTokens || 0,
          description: parsed.description,
        });
      } catch (err) { swallow(err); }
    }
  }
  // Newest first.
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function getPoolStats(): { memSize: number; max: number; ttlMs: number } {
  return { memSize: memStore.size, max: MAX_MEMORY_ENTRIES, ttlMs: TTL_MS };
}

/** Debug counter — current pool size. Consumed by debug-log. */
export function __debugPoolSize(): number {
  return memStore.size;
}
