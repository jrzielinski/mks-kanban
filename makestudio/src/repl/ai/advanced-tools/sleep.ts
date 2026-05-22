/**
 * Advanced tool — sleep topic. Extracted from advanced-tools.ts.
 */
/**
 * advanced-tools.ts
 *
 * Additional code-agent tools:
 *   - LSP (semantic code nav: definition, references, implementation, hover,
 *     workspaceSymbol, documentSymbol, callHierarchy)
 *   - TodoWrite (in-session task list managed by the LLM)
 *   - AskUserQuestion (LLM-driven multi-choice clarification with "Other")
 *   - BackgroundTask (TaskCreate/Output/Status/Stop/List — non-blocking shell)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { ReplContext } from '../../context';
import { ToolDefinition } from '../tools';
import {
  lspDefinition,
  lspDefinitionAt,
  lspReferences,
  lspReferencesAt,
  lspHover,
  lspDocumentSymbols,
  lspImplementation,
  lspWorkspaceSymbols,
  lspIncomingCalls,
  lspOutgoingCalls,
} from '../../lsp';
import {
  enterWorktreeForDum,
  exitWorktreeAndMerge,
  exitWorktreeAndDiscard,
  canEnterWorktree,
  WorktreeHandle,
} from '../../../core/worktree';

// ── Sleep tool (ported from Claude Code tools/SleepTool/prompt.ts) ───────

export const SLEEP_TOOL_PROMPT_VERBATIM = `Wait for a specified duration. The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.

You may receive <tick> prompts — these are periodic check-ins. Look for useful work to do before sleeping.

You can call this concurrently with other tools — it won't interfere with them.

Prefer this over \`Bash(sleep ...)\` — it doesn't hold a shell process.

Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.`;

// Cap duration to avoid runaway waits. Claude Code doesn't expose a hard
// number publicly; we clamp to 60s so a mis-typed agent call doesn't park
// the REPL for hours.
export const SLEEP_TOOL_MAX_MS = 60_000;
export const SLEEP_TOOL_MIN_MS = 0;

export const sleepToolDefinition: ToolDefinition = {
  name: 'Sleep',
  description: 'Wait for a specified duration. Use when asked to sleep/wait or when polling for a long background event. Prefer over Bash(sleep).',
  input_schema: {
    type: 'object',
    properties: {
      duration_ms: { type: 'number', description: `Sleep duration in milliseconds. Clamped to [${SLEEP_TOOL_MIN_MS}, ${SLEEP_TOOL_MAX_MS}].` },
    },
    required: ['duration_ms'],
  },
};

/**
 * Clamp + wait. Honours AbortSignal (double-Esc cancels this cleanly).
 * Exported split so tests can exercise the clamp logic without waiting.
 */
export function clampSleepMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SLEEP_TOOL_MIN_MS;
  return Math.max(SLEEP_TOOL_MIN_MS, Math.min(SLEEP_TOOL_MAX_MS, Math.floor(n)));
}

export async function sleepImpl(input: any, ctx: ReplContext): Promise<string> {
  const target = clampSleepMs(input?.duration_ms);
  if (target === 0) {
    return JSON.stringify({ slept_ms: 0, aborted: false });
  }
  const started = Date.now();
  const controller = ctx.currentAbortController;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { cleanup(); resolve(); }, target);
    const onAbort = () => { clearTimeout(t); cleanup(); resolve(); };
    function cleanup() {
      if (controller) controller.signal.removeEventListener('abort', onAbort);
    }
    if (controller) {
      if (controller.signal.aborted) { clearTimeout(t); resolve(); return; }
      controller.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const actual = Date.now() - started;
  return JSON.stringify({
    slept_ms: actual,
    aborted: controller?.signal.aborted || false,
    requested_ms: target,
  });
}

