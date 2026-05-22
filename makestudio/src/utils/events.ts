import { swallow } from './log';
/**
 * events.ts — local event log (Fase 5.2).
 *
 * Appends one JSON line per event to `~/.makestudio/events.jsonl`.
 * Consumed by `/stats` (Fase 5.3) and useful for post-mortem when
 * something weird happens in a long session.
 *
 * Design:
 *   - Append-only JSON Lines
 *   - Size-based rotation: when the file exceeds MAX_BYTES, rename to
 *     `events.jsonl.old` (single-level rotation; old → overwritten).
 *   - All writes are synchronous but cheap (~1KB per line). We accept
 *     the small blocking cost for simplicity.
 *   - Crashes during write leave a possibly-truncated last line — the
 *     reader (stats) MUST tolerate that.
 *
 * Event shape:
 *   { ts: ISO, type: string, ...fields }
 *
 * Standard types emitted by chat.ts / hooks.ts / runtime:
 *   - turn_start         { cwd, provider, model }
 *   - turn_end           { cwd, durationMs, tokens, ok }
 *   - tool_call          { tool, durationMs, ok, errorKind? }
 *   - compact            { kind: 'micro'|'full', beforePct, afterPct, ok }
 *   - hook_fire          { event, toolName?, blocked? }
 *   - error              { message, where, stack? }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './log';

const MAX_BYTES = 100 * 1024 * 1024;   // 100 MB before rotation
const EVENTS_DIR = path.join(os.homedir(), '.makestudio');
const EVENTS_FILE = path.join(EVENTS_DIR, 'events.jsonl');
const OLD_FILE = EVENTS_FILE + '.old';

let disabled = false; // flipped on repeated write failure

function ensureFile(): void {
  try { fs.mkdirSync(EVENTS_DIR, { recursive: true }); } catch { logger.warn('failed to create events dir: %s', EVENTS_DIR); }
}

function maybeRotate(): void {
  try {
    const stat = fs.statSync(EVENTS_FILE);
    if (stat.size > MAX_BYTES) {
      try { fs.renameSync(EVENTS_FILE, OLD_FILE); } catch { logger.warn('failed to rotate events file: %s', OLD_FILE); }
    }
  } catch (err) { swallow(err); }
}

/**
 * Sanitize MCP tool names for telemetry — collapse user-controlled `mcp__*`
 * names to the bucket `mcp`. Port of Claude Code's sanitizeToolName
 * (promptCacheBreakDetection.ts:181-185).
 *
 * Why: MCP tool names are user/org-controlled (e.g. `mcp__slack_acme__post`
 * leaks the workspace slug). Built-in tool names are fixed vocabulary and
 * safe to log verbatim. This lets us keep useful stats without inadvertently
 * recording sensitive identifiers in events.jsonl (which users share when
 * debugging).
 */
function sanitizeToolName(name: unknown): unknown {
  if (typeof name !== 'string') return name;
  if (name.startsWith('mcp__')) return 'mcp';
  return name;
}

/**
 * Record one event. Never throws — event log must not disturb the agent.
 * Applies MCP name sanitization to common fields so tool telemetry stays
 * useful without leaking user/org-controlled strings.
 */
export function recordEvent(type: string, fields: Record<string, unknown> = {}): void {
  if (disabled) return;
  try {
    ensureFile();
    maybeRotate();
    // Shallow copy + sanitise tool-ish fields. Doesn't walk nested objects
    // (keep the helper cheap); any new event type that carries tool names
    // should pass them in the top-level `tool` / `subagent_type` fields.
    const safe: Record<string, unknown> = { ...fields };
    if ('tool' in safe) safe.tool = sanitizeToolName(safe.tool);
    if ('subagent_type' in safe) safe.subagent_type = sanitizeToolName(safe.subagent_type);
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...safe }) + '\n';
    fs.appendFileSync(EVENTS_FILE, line, 'utf8');
  } catch {
    logger.warn('failed to write event: %s — disabling', EVENTS_FILE);
    disabled = true;
  }
}

/**
 * Read last N events (recent first). Used by `/stats` and manual probes.
 * Tolerates a truncated last line.
 */
export function readRecentEvents(limit: number = 500): Array<Record<string, unknown>> {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.slice(-limit).reverse();
    const out: Array<Record<string, unknown>> = [];
    for (const ln of slice) {
      try { out.push(JSON.parse(ln)); } catch (err) { swallow(err); }
    }
    return out;
  } catch {
    logger.warn('failed to read events file: %s', EVENTS_FILE);
    return [];
  }
}

export function eventsFilePath(): string { return EVENTS_FILE; }
