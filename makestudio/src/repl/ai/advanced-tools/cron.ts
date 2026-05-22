/**
 * Advanced tool — cron topic. Extracted from advanced-tools.ts.
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

// ── Cron / recurring schedules ────────────────────────────────────────────
//
// Port of Claude Code's ScheduleCronTool. Uses the existing schedule.ts
// backend (persistent JSON + tick loop in tui-index.tsx:schedulePollerId).
// Exposes 3 LLM-invokable tools so the model can set up, inspect, and cancel
// periodic prompts without the user dropping into a slash command.

export const cronCreateToolDefinition: ToolDefinition = {
  name: 'CronCreate',
  description: 'Schedule a recurring REPL prompt via 5-field cron expression (min hour day month weekday). `prompt` fires verbatim — can be a slash command.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Unique name for the schedule (used by CronDelete).' },
      cron: { type: 'string', description: 'Cron expression. Examples: "*/5 * * * *" (every 5m), "0 */1 * * *" (hourly), "0 9 * * 1-5" (9am weekdays).' },
      prompt: { type: 'string', description: 'The prompt/slash-command to execute. Starts with `/` for slash commands.' },
    },
    required: ['name', 'cron', 'prompt'],
  },
};

export function cronCreateImpl(input: any): string {
  const { addSchedule } = require('../../schedule');
  const name = String(input?.name || '').trim();
  const cron = String(input?.cron || '').trim();
  const prompt = String(input?.prompt || '').trim();
  if (!name || !cron || !prompt) {
    return JSON.stringify({ error: 'name, cron and prompt are required' });
  }
  const s = addSchedule(name, cron, prompt);
  return JSON.stringify({
    created: true,
    id: s.id,
    name: s.name,
    cron: s.cron,
    nextRunAt: s.nextRunAt,
    prompt: s.command,
  });
}

export const cronListToolDefinition: ToolDefinition = {
  name: 'CronList',
  description: 'List all active (and disabled) scheduled prompts. Returns their cron expressions, prompts, and next fire time.',
  input_schema: { type: 'object', properties: {} },
};

export function cronListImpl(): string {
  const { loadSchedules } = require('../../schedule');
  const s = loadSchedules();
  if (!s.length) return JSON.stringify({ schedules: [], note: 'No schedules defined. Use CronCreate to add one.' });
  return JSON.stringify({ count: s.length, schedules: s });
}

export const cronDeleteToolDefinition: ToolDefinition = {
  name: 'CronDelete',
  description: 'Remove a scheduled prompt by name or id. Idempotent — returns ok=false if not found, not an error.',
  input_schema: {
    type: 'object',
    properties: {
      idOrName: { type: 'string', description: 'The `id` or `name` field reported by CronList.' },
    },
    required: ['idOrName'],
  },
};

export function cronDeleteImpl(input: any): string {
  const { removeSchedule } = require('../../schedule');
  const key = String(input?.idOrName || '').trim();
  if (!key) return JSON.stringify({ ok: false, reason: 'idOrName is required' });
  const ok = removeSchedule(key);
  return JSON.stringify({ ok, removed: key });
}

