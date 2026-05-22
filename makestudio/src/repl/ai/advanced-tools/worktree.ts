/**
 * Advanced tool — worktree topic. Extracted from advanced-tools.ts.
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

// ── Worktree tools (LLM-invoked git worktree isolation) ────────────────────

// Per-session worktree state
const worktreeState: WeakMap<ReplContext, {
  handle: WorktreeHandle;
  originalCwd: string;
}> = new WeakMap();

export const worktreeToolDefinitions: ToolDefinition[] = [
  {
    name: 'EnterWorktree',
    description: 'Create an isolated git worktree (branch=slug) and switch into it. Use before risky edits. Session cwd moves to the worktree until ExitWorktree is called.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short worktree name (letters, digits, - _ .). Also used as the branch name.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'ExitWorktree',
    description: 'Leave the worktree. mode=merge (default) merges back into the original branch; mode=discard drops it. Restores session cwd.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['merge', 'discard'], description: 'merge (default) or discard.' },
      },
      required: [],
    },
  },
  {
    name: 'WorktreeStatus',
    description: 'Report whether a worktree is currently active and its path/branch.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export function enterWorktreeImpl(input: any, ctx: ReplContext): string {
  if (worktreeState.get(ctx)) {
    throw new Error('A worktree is already active in this session — call ExitWorktree first.');
  }
  const slug: string = String(input.slug || '').trim();
  if (!slug) throw new Error('EnterWorktree: slug is required');
  const check = canEnterWorktree(ctx.cwd);
  if (!check.ok) throw new Error(`Cannot enter worktree: ${check.reason}`);
  const originalCwd = ctx.cwd;
  const handle = enterWorktreeForDum(ctx.cwd, slug);
  ctx.cwd = handle.worktreePath;
  worktreeState.set(ctx, { handle, originalCwd });
  return JSON.stringify({
    status: 'entered',
    worktreePath: handle.worktreePath,
    branch: handle.branch,
    baseSha: handle.baseSha,
    originalCwd,
  }, null, 2);
}

export function exitWorktreeImpl(input: any, ctx: ReplContext): string {
  const state = worktreeState.get(ctx);
  if (!state) throw new Error('No worktree active in this session.');
  const mode = (input.mode || 'merge') as 'merge' | 'discard';
  let message: string;
  if (mode === 'discard') {
    exitWorktreeAndDiscard(state.handle);
    message = 'Worktree discarded (branch deleted, working tree removed).';
  } else {
    const res = exitWorktreeAndMerge(state.handle);
    message = res.message;
    if (!res.ok) {
      // Keep state so user can fix manually; cwd stays in worktree
      return JSON.stringify({
        status: 'merge_conflict',
        message,
        worktreePath: state.handle.worktreePath,
        branch: state.handle.branch,
        hint: 'Worktree preserved. Resolve conflicts manually, then call ExitWorktree again (mode=discard to drop, or merge to retry).',
      }, null, 2);
    }
  }
  ctx.cwd = state.originalCwd;
  worktreeState.delete(ctx);
  return JSON.stringify({ status: 'exited', mode, message, restoredCwd: ctx.cwd }, null, 2);
}

export function worktreeStatusImpl(_input: any, ctx: ReplContext): string {
  const state = worktreeState.get(ctx);
  if (!state) return JSON.stringify({ active: false });
  return JSON.stringify({
    active: true,
    worktreePath: state.handle.worktreePath,
    branch: state.handle.branch,
    baseSha: state.handle.baseSha,
    originalCwd: state.originalCwd,
  }, null, 2);
}

