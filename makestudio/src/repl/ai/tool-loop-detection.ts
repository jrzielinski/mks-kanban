/**
 * tool-loop-detection.ts — detect when the model is stuck calling the
 * same tool over and over without progress.
 *
 * Direct port of openclaw's `agents/tool-loop-detection.ts` (~/develop/
 * openclaw/src/agents/tool-loop-detection.ts), adapted to use our own
 * session-state shape (we stash the history on ctx) and our debug
 * logger. Behaviour is identical: same detectors, same thresholds.
 *
 * Detectors:
 *   - generic_repeat        same tool+args ≥10 times → warning
 *   - unknown_tool_repeat   model keeps calling a tool that doesn't exist
 *   - known_poll_no_progress tool that's known to poll (status, log)
 *                           returning identical results
 *   - ping_pong             A→B→A→B alternation with stable outcomes on
 *                           both sides
 *   - global_circuit_breaker any tool repeating identical no-progress
 *                           outcomes ≥30 times → hard stop
 *
 * Thresholds:
 *   - WARNING_THRESHOLD          10
 *   - UNKNOWN_TOOL_THRESHOLD     10
 *   - CRITICAL_THRESHOLD         20  (auto-bumped to warning+1 if config
 *                                     leaves them equal)
 *   - GLOBAL_CIRCUIT_BREAKER     30
 *   - TOOL_CALL_HISTORY_SIZE     30
 */

import { createHash } from 'node:crypto';

export type LoopDetectorKind =
  | 'generic_repeat'
  | 'unknown_tool_repeat'
  | 'known_poll_no_progress'
  | 'global_circuit_breaker'
  | 'ping_pong';

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: 'warning' | 'critical';
      detector: LoopDetectorKind;
      count: number;
      message: string;
      pairedToolName?: string;
      warningKey?: string;
    };

export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const UNKNOWN_TOOL_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;
export const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

export interface ToolCallHistoryEntry {
  toolName: string;
  argsHash: string;
  /** Fuzzy intent fingerprint — captures the SHAPE of the call rather
   *  than exact args (Bash → canonical command prefix, Write → file
   *  path, etc.). Populated by recordToolCall via fuzzyIntent(). Used
   *  by the same-intent-streak detector to catch loops like
   *  `npx tsc a.ts` → `npx tsc b.ts` → `npx tsc c.ts` that exact-hash
   *  repeat detection misses. Empty string means "don't track for
   *  fuzzy detection". */
  intent?: string;
  toolCallId?: string;
  resultHash?: string;
  unknownToolName?: string;
  timestamp: number;
}

export interface ToolLoopDetectionConfig {
  enabled?: boolean;
  historySize?: number;
  warningThreshold?: number;
  unknownToolThreshold?: number;
  criticalThreshold?: number;
  globalCircuitBreakerThreshold?: number;
  detectors?: {
    genericRepeat?: boolean;
    knownPollNoProgress?: boolean;
    pingPong?: boolean;
  };
}

const DEFAULT_LOOP_DETECTION_CONFIG = {
  // Enabled by default in makestudio — we hit a real grep tail-spin in
  // /learn cluster that would have been caught here. Opt-out via
  // ctx.toolLoopDetectionConfig.enabled = false if the noise outweighs
  // the catches.
  enabled: true,
  historySize: TOOL_CALL_HISTORY_SIZE,
  warningThreshold: WARNING_THRESHOLD,
  unknownToolThreshold: UNKNOWN_TOOL_THRESHOLD,
  criticalThreshold: CRITICAL_THRESHOLD,
  globalCircuitBreakerThreshold: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
};

interface ResolvedLoopDetectionConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  unknownToolThreshold: number;
  criticalThreshold: number;
  globalCircuitBreakerThreshold: number;
  detectors: {
    genericRepeat: boolean;
    knownPollNoProgress: boolean;
    pingPong: boolean;
  };
}

/** Lightweight shape stashed on `ctx.toolCallHistory`. Avoids a full
 *  SessionState type dependency from the openclaw original. */
export interface ToolLoopState {
  toolCallHistory?: ToolCallHistoryEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveLoopDetectionConfig(config?: ToolLoopDetectionConfig): ResolvedLoopDetectionConfig {
  let warningThreshold = asPositiveInt(
    config?.warningThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.warningThreshold,
  );
  let criticalThreshold = asPositiveInt(
    config?.criticalThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.criticalThreshold,
  );
  let globalCircuitBreakerThreshold = asPositiveInt(
    config?.globalCircuitBreakerThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.globalCircuitBreakerThreshold,
  );

  if (criticalThreshold <= warningThreshold) {
    criticalThreshold = warningThreshold + 1;
  }
  if (globalCircuitBreakerThreshold <= criticalThreshold) {
    globalCircuitBreakerThreshold = criticalThreshold + 1;
  }

  return {
    enabled: config?.enabled ?? DEFAULT_LOOP_DETECTION_CONFIG.enabled,
    historySize: asPositiveInt(config?.historySize, DEFAULT_LOOP_DETECTION_CONFIG.historySize),
    warningThreshold,
    unknownToolThreshold: asPositiveInt(
      config?.unknownToolThreshold,
      DEFAULT_LOOP_DETECTION_CONFIG.unknownToolThreshold,
    ),
    criticalThreshold,
    globalCircuitBreakerThreshold,
    detectors: {
      genericRepeat:
        config?.detectors?.genericRepeat ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.genericRepeat,
      knownPollNoProgress:
        config?.detectors?.knownPollNoProgress ??
        DEFAULT_LOOP_DETECTION_CONFIG.detectors.knownPollNoProgress,
      pingPong: config?.detectors?.pingPong ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.pingPong,
    },
  };
}

/**
 * Hash a tool call for pattern matching.
 * Uses tool name + deterministic JSON serialization digest of params.
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

/**
 * "Fuzzy" intent fingerprint of a tool call. Captures the user-visible
 * SHAPE of the call rather than its exact args, so detectors can spot
 * "model is doing the same thing 5 times with slight variations":
 *
 *   - Bash:     canonical command prefix (`npx tsc`, `git status`, ...)
 *   - Write:    `Write:<path>` — same file rewritten 5x
 *   - Edit:     `Edit:<path>`  — same file edited 5x
 *   - Glob:     `Glob:<pattern>` (already coarse — fine)
 *   - Grep:     `Grep:<pattern>` (ditto)
 *   - other:    `<tool>` — every call counts (fallback)
 *
 * Returns the empty string when the call shouldn't be tracked by the
 * fuzzy detector (e.g. polls — they have their own logic, and
 * AskUserQuestion which is opaque on purpose).
 */
function fuzzyIntent(toolName: string, params: unknown): string {
  if (!isPlainObject(params)) return toolName;
  if (toolName === 'AskUserQuestion') return '';
  if (toolName === 'Bash' || toolName === 'shell_run') {
    try {
      let cmd = String((params as any).command || '').trim();
      if (!cmd) return toolName;
      // Strip leading `cd <path> && ` / `cd <path> ; ` wrappers — they are
      // not the actual operation, just a chdir. Without this, every
      // `cd /repo && grep foo` and `cd /repo && rg bar` collapses to the
      // same intent "Bash:cd" and tripping the loop detector at 5
      // unrelated greps. Mirrors the safety-classifier's effective-cwd
      // parsing (see safety-classifier.ts: `cd <path> &&` handling).
      const cdStrip = cmd.match(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*(.*)$/);
      if (cdStrip && cdStrip[1]) cmd = cdStrip[1].trim();
      // Reuse permission-arity's canonical prefix logic on the post-cd
      // remainder so the intent reflects the actual operation.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { canonicalPrefix } = require('../permission-arity');
      const prefix = canonicalPrefix(cmd);
      return `Bash:${prefix || cmd.split(/\s+/)[0]}`;
    } catch { return toolName; }
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const fp = String((params as any).file_path || (params as any).filePath || '');
    return fp ? `${toolName}:${fp}` : toolName;
  }
  // Path-aware Read intent. Without this, every Read of every different
  // file collapsed into the single intent "Read" — so a research workflow
  // that legitimately reads 10+ different files tripped the same-intent
  // streak detector at 5. With path included, only repeat reads of the
  // SAME file count as a streak (which IS the actual loop signal).
  if (toolName === 'Read' || toolName === 'read_file') {
    const fp = String((params as any).file_path || (params as any).filePath || '');
    return fp ? `Read:${fp}` : toolName;
  }
  // read_attachment is keyed by attachment id (otherwise reading multiple
  // attachments back-to-back would falsely streak).
  if (toolName === 'read_attachment') {
    const id = String((params as any).attachment_id || (params as any).id || '');
    return id ? `read_attachment:${id}` : toolName;
  }
  // LSP nav tools — reading definitions/references for different
  // symbols is normal exploration, not a loop. Key by (symbol, file).
  if (toolName === 'find_definition' || toolName === 'find_references') {
    const sym = String((params as any).symbol || (params as any).name || '');
    const fp = String((params as any).file_path || (params as any).filePath || '');
    return sym || fp ? `${toolName}:${sym}@${fp}` : toolName;
  }
  if (toolName === 'LSP') {
    const action = String((params as any).action || (params as any).op || '');
    const fp = String((params as any).file_path || (params as any).filePath || '');
    return action || fp ? `LSP:${action}:${fp}` : toolName;
  }
  // Fetching different URLs is browsing, not looping.
  if (toolName === 'WebFetch' || toolName === 'fetch') {
    const url = String((params as any).url || '');
    return url ? `${toolName}:${url}` : toolName;
  }
  if (toolName === 'Glob') return `Glob:${String((params as any).pattern || '')}`;
  if (toolName === 'Grep') return `Grep:${String((params as any).pattern || '')}`;
  return toolName;
}

/**
 * Count how many of the most recent calls share the same fuzzy intent.
 * Walks backward from the tail until a different intent breaks the
 * streak. The CURRENT call (the one about to fire) is included in the
 * count — pass it via `intent` so the threshold semantics match the
 * other detectors ("Nth time you tried this").
 *
 * Catches loops like `npx tsc src/a.ts` → `npx tsc src/b.ts` →
 * `npx tsc src/c.ts` that exact-hash detection misses, plus same-file
 * Edit/Write thrashing.
 */
function getFuzzyIntentStreak(history: ToolCallHistoryEntry[], intent: string): number {
  if (!intent) return 0;
  let streak = 1; // counts the current call itself
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.intent !== intent) break;
    streak += 1;
  }
  return streak;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = [...Object.keys(obj)].sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function digestStable(value: unknown): string {
  const serialized = stableStringifyFallback(value);
  return createHash('sha256').update(serialized).digest('hex');
}

function stableStringifyFallback(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    if (value === null || value === undefined) {
      return `${value}`;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return `${value}`;
    }
    if (value instanceof Error) {
      return `${value.name}:${value.message}`;
    }
    return Object.prototype.toString.call(value);
  }
}

/**
 * Tools we know are polls and should be measured for "called many times
 * with no change in result". Bash with `tail -f`, makestudio's task
 * status checks, etc. fall here. Names match the makestudio tool
 * registry — extend as new poll-style tools are added.
 */
function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === 'TaskGet' || toolName === 'TaskOutput' || toolName === 'TaskList') {
    return true;
  }
  if (toolName === 'Monitor') {
    return true;
  }
  if (toolName === 'Bash' && isPlainObject(params)) {
    const cmd = String(params.command || '');
    // Heuristic: tail/follow commands look like polls.
    if (/\b(tail\s+-f|tail\s+--follow|watch\s+|pgrep|ps\s+aux)\b/.test(cmd)) return true;
  }
  return false;
}

function extractTextContent(result: unknown): string {
  // openclaw tool results have a `content: [{type, text}, ...]` shape.
  // Our results are plain strings; treat them as the text content
  // directly.
  if (typeof result === 'string') return result.trim();
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return '';
  }
  return (result.content as any[])
    .filter(
      (entry): entry is { type: string; text: string } =>
        isPlainObject(entry) && typeof entry.type === 'string' && typeof entry.text === 'string',
    )
    .map((entry) => entry.text)
    .join('\n')
    .trim();
}

function formatErrorForHash(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return `${error}`;
  }
  return stableStringify(error);
}

function extractUnknownToolName(error: unknown): string | undefined {
  const raw = formatErrorForHash(error).trim();
  if (!raw) {
    return undefined;
  }
  const match =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_.-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_.-]+)["']?\s+(?:not found|is not available)/i) ??
    raw.match(/no such tool[:\s]+["']?([a-z0-9_.-]+)["']?/i);
  const toolName = match?.[1]?.trim();
  return toolName ? toolName.toLowerCase() : undefined;
}

function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): { resultHash?: string; unknownToolName?: string } {
  if (error !== undefined) {
    const unknownToolName = extractUnknownToolName(error);
    return {
      resultHash: `error:${digestStable(formatErrorForHash(error))}`,
      unknownToolName,
    };
  }
  const text = extractTextContent(result);
  if (isKnownPollToolCall(toolName, params)) {
    // For polls, hash the visible text only — that's what determines
    // "no progress". Removes timestamps that would otherwise vary.
    return { resultHash: digestStable({ poll: true, text: text.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '') }) };
  }
  if (typeof result === 'string') {
    return { resultHash: digestStable(result) };
  }
  if (!isPlainObject(result)) {
    return { resultHash: result === undefined ? undefined : digestStable(result) };
  }
  return { resultHash: digestStable({ details: result, text }) };
}

function getUnknownToolRepeatStreak(
  history: ToolCallHistoryEntry[],
  toolName: string,
): { count: number; unknownToolName?: string } {
  let streak = 0;
  let repeatedUnknownToolName: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || !record.unknownToolName) {
      break;
    }
    if (!repeatedUnknownToolName) {
      repeatedUnknownToolName = record.unknownToolName;
      streak = 1;
      continue;
    }
    if (record.unknownToolName !== repeatedUnknownToolName) {
      break;
    }
    streak += 1;
  }

  return { count: streak, unknownToolName: repeatedUnknownToolName };
}

function getNoProgressStreak(
  history: ToolCallHistoryEntry[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) {
      continue;
    }
    if (typeof record.resultHash !== 'string' || !record.resultHash) {
      continue;
    }
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) {
      break;
    }
    streak += 1;
  }

  return { count: streak, latestResultHash };
}

function getPingPongStreak(
  history: ToolCallHistoryEntry[],
  currentSignature: string,
): {
  count: number;
  pairedToolName?: string;
  pairedSignature?: string;
  noProgressEvidence: boolean;
} {
  const last = history[history.length - 1];
  if (!last) {
    return { count: 0, noProgressEvidence: false };
  }

  let otherSignature: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash;
      otherToolName = call.toolName;
      break;
    }
  }

  if (!otherSignature || !otherToolName) {
    return { count: 0, noProgressEvidence: false };
  }

  let alternatingTailCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (call.argsHash !== expected) {
      break;
    }
    alternatingTailCount += 1;
  }

  if (alternatingTailCount < 2) {
    return { count: 0, noProgressEvidence: false };
  }

  const expectedCurrentSignature = otherSignature;
  if (currentSignature !== expectedCurrentSignature) {
    return { count: 0, noProgressEvidence: false };
  }

  const tailStart = Math.max(0, history.length - alternatingTailCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;
  for (let i = tailStart; i < history.length; i += 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    if (!call.resultHash) {
      noProgressEvidence = false;
      break;
    }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) {
        firstHashA = call.resultHash;
      } else if (firstHashA !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    if (call.argsHash === otherSignature) {
      if (!firstHashB) {
        firstHashB = call.resultHash;
      } else if (firstHashB !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    noProgressEvidence = false;
    break;
  }

  // Need repeated stable outcomes on both sides before treating
  // ping-pong as no-progress.
  if (!firstHashA || !firstHashB) {
    noProgressEvidence = false;
  }

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    pairedSignature: last.argsHash,
    noProgressEvidence,
  };
}

function canonicalPairKey(signatureA: string, signatureB: string): string {
  return [signatureA, signatureB].sort().join('|');
}

/**
 * Detect if an agent is stuck in a repetitive tool call loop. Called
 * BEFORE executing each tool. When stuck=true, the caller MUST refuse
 * to execute (critical) or surface the warning (warning).
 *
 * Returns `{stuck: false}` when detection is disabled (config).
 */
export function detectToolCallLoop(
  state: ToolLoopState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
): LoopDetectionResult {
  const resolvedConfig = resolveLoopDetectionConfig(config);
  if (!resolvedConfig.enabled) {
    return { stuck: false };
  }
  const history = state.toolCallHistory ?? [];
  const currentHash = hashToolCall(toolName, params);
  const unknownToolStreak = getUnknownToolRepeatStreak(history, toolName);
  const noProgress = getNoProgressStreak(history, toolName, currentHash);
  const noProgressStreak = noProgress.count;
  const knownPollTool = isKnownPollToolCall(toolName, params);
  const pingPong = getPingPongStreak(history, currentHash);

  if (unknownToolStreak.count >= resolvedConfig.unknownToolThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'unknown_tool_repeat',
      count: unknownToolStreak.count,
      message: `CRITICAL: attempted unavailable tool ${unknownToolStreak.unknownToolName ?? toolName} ${unknownToolStreak.count} times. Stop retrying that missing tool and answer without it.`,
      warningKey: `unknown-tool:${toolName}:${unknownToolStreak.unknownToolName ?? 'unknown'}`,
    };
  }

  if (noProgressStreak >= resolvedConfig.globalCircuitBreakerThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker to prevent runaway loops.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
    };
  }

  if (
    knownPollTool &&
    resolvedConfig.detectors.knownPollNoProgress &&
    noProgressStreak >= resolvedConfig.criticalThreshold
  ) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
    };
  }

  if (
    knownPollTool &&
    resolvedConfig.detectors.knownPollNoProgress &&
    noProgressStreak >= resolvedConfig.warningThreshold
  ) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
    };
  }

  const pingPongWarningKey = pingPong.pairedSignature
    ? `pingpong:${canonicalPairKey(currentHash, pingPong.pairedSignature)}`
    : `pingpong:${toolName}:${currentHash}`;

  if (
    resolvedConfig.detectors.pingPong &&
    pingPong.count >= resolvedConfig.criticalThreshold &&
    pingPong.noProgressEvidence
  ) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `CRITICAL: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls) with no progress. This appears to be a stuck ping-pong loop. Session execution blocked to prevent resource waste.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  if (resolvedConfig.detectors.pingPong && pingPong.count >= resolvedConfig.warningThreshold) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `WARNING: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls). This looks like a ping-pong loop; stop retrying and report the task as failed.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  // Generic detector: warn-only for repeated identical calls.
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === currentHash,
  ).length;

  if (
    !knownPollTool &&
    resolvedConfig.detectors.genericRepeat &&
    recentCount >= resolvedConfig.warningThreshold
  ) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, stop retrying and report the task as failed.`,
      warningKey: `generic:${toolName}:${currentHash}`,
    };
  }

  // Same-intent streak detector: catches "same shape, different args"
  // loops the exact-hash detector misses (e.g. `npx tsc a.ts` → `b.ts`
  // → `c.ts` rapid-fire). Lower thresholds than generic_repeat (5/15)
  // because hitting 5 of these in a row is a stronger signal — exact
  // repeats can be intentional (re-poll a status), fuzzy repeats
  // almost never are.
  const FUZZY_WARN_THRESHOLD = 5;
  const FUZZY_CRIT_THRESHOLD = 15;
  if (!knownPollTool && resolvedConfig.detectors.genericRepeat) {
    const intent = fuzzyIntent(toolName, params);
    if (intent) {
      const fuzzyStreak = getFuzzyIntentStreak(history, intent);
      if (fuzzyStreak >= FUZZY_CRIT_THRESHOLD) {
        return {
          stuck: true,
          level: 'critical',
          detector: 'generic_repeat',
          count: fuzzyStreak,
          message: `CRITICAL: ${fuzzyStreak} consecutive ${toolName} calls share the same intent (${intent}). Different args won't change the outcome — stop retrying and report failure.`,
          warningKey: `fuzzy:${intent}`,
        };
      }
      if (fuzzyStreak >= FUZZY_WARN_THRESHOLD) {
        return {
          stuck: true,
          level: 'warning',
          detector: 'generic_repeat',
          count: fuzzyStreak,
          message: `WARNING: ${fuzzyStreak} consecutive ${toolName} calls with the same intent (${intent}). If this isn't making progress, stop retrying — different args won't change the outcome.`,
          warningKey: `fuzzy:${intent}`,
        };
      }
    }
  }

  return { stuck: false };
}

/**
 * Record a tool call in the session's history for loop detection.
 * Maintains a sliding window of the last N calls.
 *
 * Call this BEFORE the tool executes so the entry exists for any
 * concurrent loop detection — `recordToolCallOutcome` later attaches
 * the result hash to the same entry.
 */
export function recordToolCall(
  state: ToolLoopState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
  config?: ToolLoopDetectionConfig,
): void {
  const resolvedConfig = resolveLoopDetectionConfig(config);
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    intent: fuzzyIntent(toolName, params),
    toolCallId,
    timestamp: Date.now(),
  });

  if (state.toolCallHistory.length > resolvedConfig.historySize) {
    state.toolCallHistory.shift();
  }
}

/**
 * Record a completed tool call outcome so loop detection can identify
 * no-progress repeats. Call this AFTER the tool finishes (or errors).
 */
export function recordToolCallOutcome(
  state: ToolLoopState,
  params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
    config?: ToolLoopDetectionConfig;
  },
): void {
  const resolvedConfig = resolveLoopDetectionConfig(params.config);
  const outcome = hashToolOutcome(params.toolName, params.toolParams, params.result, params.error);
  const resultHash = outcome.resultHash;
  if (!resultHash) {
    return;
  }

  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  const argsHash = hashToolCall(params.toolName, params.toolParams);
  let matched = false;
  for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
    const call = state.toolCallHistory[i];
    if (!call) {
      continue;
    }
    if (params.toolCallId && call.toolCallId !== params.toolCallId) {
      continue;
    }
    if (call.toolName !== params.toolName || call.argsHash !== argsHash) {
      continue;
    }
    if (call.resultHash !== undefined) {
      continue;
    }
    call.resultHash = resultHash;
    call.unknownToolName = outcome.unknownToolName;
    matched = true;
    break;
  }

  if (!matched) {
    state.toolCallHistory.push({
      toolName: params.toolName,
      argsHash,
      toolCallId: params.toolCallId,
      resultHash,
      unknownToolName: outcome.unknownToolName,
      timestamp: Date.now(),
    });
  }

  if (state.toolCallHistory.length > resolvedConfig.historySize) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - resolvedConfig.historySize);
  }
}

/**
 * Get current tool call statistics for a session (for /debug or
 * monitoring overlays).
 */
export function getToolCallStats(state: ToolLoopState): {
  totalCalls: number;
  uniquePatterns: number;
  mostFrequent: { toolName: string; count: number } | null;
} {
  const history = state.toolCallHistory ?? [];
  const patterns = new Map<string, { toolName: string; count: number }>();

  for (const call of history) {
    const key = call.argsHash;
    const existing = patterns.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      patterns.set(key, { toolName: call.toolName, count: 1 });
    }
  }

  let mostFrequent: { toolName: string; count: number } | null = null;
  for (const pattern of patterns.values()) {
    if (!mostFrequent || pattern.count > mostFrequent.count) {
      mostFrequent = pattern;
    }
  }

  return {
    totalCalls: history.length,
    uniquePatterns: patterns.size,
    mostFrequent,
  };
}
