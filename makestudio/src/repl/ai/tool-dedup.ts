import { swallow } from '../../utils/log';
/**
 * tool-dedup.ts — pre-execution dedup for read-shaped tools.
 *
 * Pattern observed in real sessions: the model issues `Read /path/X`,
 * gets the content, then a few iterations later issues `Read /path/X`
 * again (same offset/limit) "to be sure". The agent already has a
 * FILE_UNCHANGED guard but it only WARNS — the model ignores warnings.
 * Same with `Glob` and `Grep` when the model retries the same query
 * a few rounds later, hoping for new info.
 *
 * This module REJECTS the duplicate before `executeTool` runs:
 *   - Returns `{ duplicate: true, reason: '...', previousMsgIdx: N }`
 *     so the dispatcher can synthesise an error tool_result pointing
 *     to the message where the original answer lives.
 *   - The model is forced to use the prior result instead of re-running.
 *
 * State is held on ctx (`__toolDedupCache: Map`) and rotated per turn
 * via `__turnSeq` (already bumped at the start of every handleAIChat).
 *
 * Coverage:
 *   - Read / read_file: key = (path, offset, limit) + mtime check
 *   - Glob / glob_files: key = canonical JSON of input
 *   - Grep / search_code: key = canonical JSON of input
 *
 * Pure / safe:
 *   - No side-effects beyond the in-memory map.
 *   - On any error (missing file, throw in stat) we fall through to
 *     the normal execution path — better to allow a redundant call
 *     than to wedge the turn.
 */

import * as fs from 'fs';

const READ_NAMES = new Set(['Read', 'read_file']);
const GLOB_NAMES = new Set(['Glob', 'glob_files']);
const GREP_NAMES = new Set(['Grep', 'search_code']);

interface CacheEntry {
  /** Index in `chatMessages` where the original tool_result lives. */
  msgIdx: number;
  /** mtimeMs of the file at the time of the original Read (only for reads). */
  mtimeMs?: number;
  /** Path of the file (only for reads — used in the rejection message). */
  path?: string;
  /** Tool name (for diagnostics + reject message). */
  tool: string;
}

interface ToolDedupState {
  turnSeq: number;
  cache: Map<string, CacheEntry>;
}

function getState(ctx: any): ToolDedupState {
  const currentTurn = (ctx.__turnSeq as number) || 0;
  let s = ctx.__toolDedupCache as ToolDedupState | undefined;
  if (!s || s.turnSeq !== currentTurn) {
    s = { turnSeq: currentTurn, cache: new Map() };
    ctx.__toolDedupCache = s;
  }
  return s;
}

function canonicalJson(o: any): string {
  // Order-stable, slice nothing — the LLM may craft inputs with
  // visually-identical-but-key-reordered JSON; without sort we'd treat
  // those as different and miss the dedup.
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

function readKey(input: any): { key: string; path?: string } {
  const path: string | undefined = input?.file_path || input?.filePath || input?.path;
  if (!path) return { key: '' };
  const offset = Number(input?.offset || 0);
  const limit = Number(input?.limit || 0);
  return { key: `read|${path}|${offset}|${limit}`, path };
}

export interface DupCheck {
  duplicate: boolean;
  reason?: string;
  previousMsgIdx?: number;
}

export function checkDuplicate(ctx: any, toolName: string, toolInput: any): DupCheck {
  try {
    const state = getState(ctx);
    let key: string | null = null;
    let path: string | undefined;
    if (READ_NAMES.has(toolName)) {
      const r = readKey(toolInput);
      if (!r.key) return { duplicate: false };
      key = r.key;
      path = r.path;
    } else if (GLOB_NAMES.has(toolName) || GREP_NAMES.has(toolName)) {
      key = `${toolName}|${canonicalJson(toolInput || {})}`;
    } else {
      return { duplicate: false };
    }

    const prev = state.cache.get(key);
    if (!prev) return { duplicate: false };

    // For reads, double-check the file hasn't been modified between
    // the cached call and now. If mtime changed, the model legitimately
    // needs the new content — let the call through and overwrite the
    // cache entry on registration.
    if (READ_NAMES.has(toolName) && path) {
      try {
        const st = fs.statSync(path);
        if (prev.mtimeMs !== undefined && st.mtimeMs !== prev.mtimeMs) {
          return { duplicate: false };
        }
      } catch {
        // File disappeared — let the tool run, it'll produce its own
        // not-found error.
        return { duplicate: false };
      }
      return {
        duplicate: true,
        reason: `Already read ${path} earlier this turn (offset/limit unchanged, file unchanged on disk). See message #${prev.msgIdx + 1} for the content. Re-running the same Read does not yield new information — use what you already have, or call Edit/Grep/Bash if you need to act on it.`,
        previousMsgIdx: prev.msgIdx,
      };
    }

    // Glob / Grep with identical params.
    return {
      duplicate: true,
      reason: `Already issued ${toolName} with these exact arguments earlier this turn (see message #${prev.msgIdx + 1}). Use those results — re-running won't change them this turn.`,
      previousMsgIdx: prev.msgIdx,
    };
  } catch {
    return { duplicate: false };
  }
}

export function recordToolCall(ctx: any, toolName: string, toolInput: any, msgIdx: number): void {
  try {
    const state = getState(ctx);
    let key: string | null = null;
    let entry: CacheEntry = { msgIdx, tool: toolName };
    if (READ_NAMES.has(toolName)) {
      const r = readKey(toolInput);
      if (!r.key) return;
      key = r.key;
      entry.path = r.path;
      try {
        const st = fs.statSync(r.path!);
        entry.mtimeMs = st.mtimeMs;
      } catch (err) { swallow(err); }
    } else if (GLOB_NAMES.has(toolName) || GREP_NAMES.has(toolName)) {
      key = `${toolName}|${canonicalJson(toolInput || {})}`;
    } else {
      return;
    }
    state.cache.set(key, entry);
  } catch (err) { swallow(err); }
}
