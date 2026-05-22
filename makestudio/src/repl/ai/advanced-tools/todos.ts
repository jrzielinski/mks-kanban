import { swallow } from '../../../utils/log';
/**
 * Advanced tool — todos topic. Extracted from advanced-tools.ts.
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

// ── TodoWrite tool ──────────────────────────────────────────────────────────

export interface Todo {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: string;
  updatedAt: string;
}

// Per-session todo list (attached to ReplContext via WeakMap)
const todoStore: WeakMap<ReplContext, Todo[]> = new WeakMap();

export function getTodos(ctx: ReplContext): Todo[] {
  let list = todoStore.get(ctx);
  if (!list) { list = []; todoStore.set(ctx, list); }
  return list;
}

export function getCurrentTodos(ctx: ReplContext): Todo[] {
  return getTodos(ctx);
}

export const todoToolDefinitions: ToolDefinition[] = [
  {
    name: 'TodoWrite',
    description: 'Create or replace the session todo list (use for 3+ step tasks). Mark items in_progress when starting and completed when done.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string', description: 'Short imperative title (e.g. "Rename getCwd across src/")' },
              description: { type: 'string', description: 'What needs to be done.' },
              activeForm: { type: 'string', description: 'Present-continuous shown while in_progress (e.g. "Renaming getCwd")' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['subject'],
          },
          description: 'Full todo list. Replaces the current list entirely.',
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'TodoUpdate',
    description: 'Update status of a single todo by 1-based index (pending/in_progress/completed). Returns a terse one-line confirmation ("✓ #N <subject> → <status>") rather than the full list — apply it to your mental model of the list you already have from TodoWrite. Call TodoList explicitly if you need the whole list re-rendered.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '1-based index in the current todo list.' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      },
      required: ['index', 'status'],
    },
  },
  {
    name: 'TodoList',
    description: 'Return the current session todo list with statuses.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export function todoWriteImpl(input: any, ctx: ReplContext): string {
  const now = new Date().toISOString();
  const existing = getTodos(ctx);
  const existingById: Record<string, Todo> = {};
  for (const t of existing) existingById[t.subject] = t;

  const next: Todo[] = (input.todos || []).map((t: any) => {
    const subject = String(t.subject || '').trim();
    if (!subject) throw new Error('Todo subject is required');
    const prior = existingById[subject];
    return {
      id: prior?.id || crypto.randomUUID().slice(0, 8),
      subject,
      description: t.description,
      activeForm: t.activeForm,
      status: (t.status || prior?.status || 'pending') as Todo['status'],
      createdAt: prior?.createdAt || now,
      updatedAt: now,
    };
  });

  todoStore.set(ctx, next);
  return formatTodoList(next);
}

export function todoUpdateImpl(input: any, ctx: ReplContext): string {
  const list = getTodos(ctx);
  const idx = Number(input.index) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
    throw new Error(`TodoUpdate: index ${input.index} out of range (1..${list.length})`);
  }
  const status = input.status as Todo['status'];
  if (!['pending', 'in_progress', 'completed'].includes(status)) {
    throw new Error(`TodoUpdate: invalid status "${status}"`);
  }
  list[idx].status = status;
  list[idx].updatedAt = new Date().toISOString();

  // Terse one-liner instead of re-dumping the full list. When the LLM
  // chains several TodoUpdates (mark #N completed, then #N+1 in_progress,
  // etc) the TUI was rendering the whole list once per call, which
  // drowned the actual change in visual noise. The LLM already has the
  // list in context from the preceding TodoWrite — it doesn't need
  // another full render to update its mental model. Callers who want the
  // current state can still call TodoList explicitly.
  const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '~' : '·';
  const terse = `${mark} #${idx + 1} ${list[idx].subject} → ${status}`;

  // Verification nudge — fires only when the user has explicitly opted
  // into auto-verify (via /verify on or settings.autoVerifyEnabled=true)
  // or when this turn is marked as headless/critical via env. Otherwise,
  // tell the model to wrap up — the verify subagent burns 5–20K tokens
  // and a model stuck on this nudge will spiral into VerifyPlanExecution
  // → grep → re-edit cycles for tasks that don't need it.
  const allDone = list.length >= 3 && list.every(t => t.status === 'completed');
  const hasVerifyTask = list.some(t => /verif|check|test|validat/i.test(t.subject));
  if (allDone && !hasVerifyTask) {
    let verifyOptedIn = false;
    try {
      const { loadSettings } = require('../../settings');
      const s = loadSettings() || {};
      verifyOptedIn = s.autoVerifyEnabled === true
        || (s.autoVerifyDisabled === false && s.autoVerifyEnabled === undefined);
    } catch (err) { swallow(err); }
    if (process.env.MAKESTUDIO_NO_AUTO_VERIFY === '1') verifyOptedIn = false;

    if (verifyOptedIn) {
      return terse + '\n\n' + formatTodoList(list) +
        '\n\nNOTE: All tasks completed but no verification step was found. ' +
        'Before telling the user you are done, call VerifyPlanExecution with the original task, ' +
        'files changed, and your approach. You cannot self-declare success — only the verifier issues a verdict.';
    }
    // Default path: just acknowledge completion. Let the user decide
    // whether to verify (they can run /verify manually).
    return terse + '\n\n' + formatTodoList(list);
  }

  return terse;
}

export function todoListImpl(_input: any, ctx: ReplContext): string {
  return formatTodoList(getTodos(ctx));
}

export function formatTodoList(list: Todo[]): string {
  if (list.length === 0) return '(no todos)';
  return list.map((t, i) => {
    const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
    const suffix = t.status === 'in_progress' && t.activeForm ? `  — ${t.activeForm}` : '';
    return `${String(i + 1).padStart(2)}. ${mark} ${t.subject}${suffix}`;
  }).join('\n');
}

