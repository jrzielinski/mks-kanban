import { swallow } from '../../../utils/log';
/**
 * Advanced tool — pr-suggest topic. Extracted from advanced-tools.ts.
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

// ── SuggestBackgroundPR tool ────────────────────────────────────────────
//
// Honest note: Claude Code's tools/SuggestBackgroundPRTool is a STUB in
// the open-source build (`isEnabled: () => false`, returns "not
// available in this build"). We can't port behaviour that doesn't exist.
// The tool below is MakeStudio-designed around the same semantic intent:
// when the agent has just produced substantial diff, it can call this
// tool to surface a one-shot "open PR?" prompt to the user. No GitHub
// access is required — we just compute diff stats and hand the user a
// ready-to-run `gh pr create` command.

export const SUGGEST_PR_MIN_FILES = 3;
export const SUGGEST_PR_MIN_LINES = 50;

export interface PrSuggestion {
  title: string;
  summary: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  command: string;
  at: string;
}

const lastSuggestionByCtx: WeakMap<ReplContext, PrSuggestion> = new WeakMap();
export function getLastPrSuggestion(ctx: ReplContext): PrSuggestion | null {
  return lastSuggestionByCtx.get(ctx) || null;
}

export const suggestBackgroundPrToolDefinition: ToolDefinition = {
  name: 'SuggestBackgroundPR',
  description: 'Suggest a pull request after substantial implementation (3+ files or 50+ lines changed). Emits a ready-to-run `gh pr create` command. Do NOT call for small edits or when a PR was already opened.',
  input_schema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Short PR title (imperative, under 70 chars). Example: "Add tips rotation to welcome banner".' },
      summary: { type: 'string', description: '1-3 sentence PR summary (what + why). Shown to the user and used as PR body.' },
      base:    { type: 'string', description: 'Base branch for the PR. Defaults to "main" or "master" depending on repo.' },
    },
    required: ['title', 'summary'],
  },
};

export function computeDiffStats(cwd: string): { filesChanged: number; linesAdded: number; linesRemoved: number } {
  let filesChanged = 0, linesAdded = 0, linesRemoved = 0;
  try {
    // Tracked changes (staged + unstaged).
    const tracked = spawnSync('git', ['diff', '--numstat', 'HEAD'], { cwd, encoding: 'utf8' });
    if (tracked.status === 0) {
      for (const l of tracked.stdout.split('\n').filter(Boolean)) {
        const parts = l.split('\t');
        if (parts.length < 3) continue;
        const a = parseInt(parts[0]!, 10);
        const r = parseInt(parts[1]!, 10);
        if (Number.isFinite(a)) linesAdded += a;
        if (Number.isFinite(r)) linesRemoved += r;
        filesChanged++;
      }
    }
    // Untracked files — count each file + its line count as added lines.
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
    if (untracked.status === 0) {
      for (const rel of untracked.stdout.split('\n').filter(Boolean)) {
        try {
          const content = fs.readFileSync(path.join(cwd, rel), 'utf8');
          const lineCount = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
          filesChanged++;
          linesAdded += lineCount;
        } catch (err) { swallow(err); }
      }
    }
  } catch (err) { swallow(err); }
  return { filesChanged, linesAdded, linesRemoved };
}

export function suggestBackgroundPrImpl(input: any, ctx: ReplContext): string {
  const title = String(input?.title || '').trim();
  const summary = String(input?.summary || '').trim();
  const base = String(input?.base || '').trim() || 'main';
  if (!title || !summary) {
    return JSON.stringify({ error: 'Both title and summary are required.' });
  }
  const stats = computeDiffStats(ctx.activeProject?.localPath || ctx.cwd);
  // Gate: require substantial change. Refusing here prevents noisy nudges.
  if (stats.filesChanged < SUGGEST_PR_MIN_FILES && (stats.linesAdded + stats.linesRemoved) < SUGGEST_PR_MIN_LINES) {
    return JSON.stringify({
      suppressed: true,
      reason: `Change too small to justify a background PR suggestion (${stats.filesChanged} files, +${stats.linesAdded}/-${stats.linesRemoved} lines). Thresholds: ${SUGGEST_PR_MIN_FILES} files OR ${SUGGEST_PR_MIN_LINES} lines.`,
      stats,
    });
  }
  // Build the ready-to-run command. The user can copy it or run /pr.
  const bodyEscaped = summary.replace(/`/g, '\\`').replace(/"/g, '\\"');
  const titleEscaped = title.replace(/"/g, '\\"');
  const command = `gh pr create --base "${base}" --title "${titleEscaped}" --body "${bodyEscaped}"`;
  const suggestion: PrSuggestion = {
    title, summary,
    filesChanged: stats.filesChanged,
    linesAdded: stats.linesAdded,
    linesRemoved: stats.linesRemoved,
    command,
    at: new Date().toISOString(),
  };
  lastSuggestionByCtx.set(ctx, suggestion);
  // Surface in the TUI so the user sees it even while the agent keeps working.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bridge = require('../../tui/bridge').getTuiBridge?.();
    if (bridge) {
      const body = [
        '↳ PR suggestion:',
        `  ${title}`,
        `  ${summary}`,
        `  ${stats.filesChanged} files · +${stats.linesAdded}/-${stats.linesRemoved} lines · base=${base}`,
        `  run: ${command}`,
        `  (or type /pr to open it now)`,
      ].join('\n');
      bridge.addMessage({ role: 'info', text: body });
    }
  } catch (err) { swallow(err); }
  return JSON.stringify({
    suggested: true,
    ...suggestion,
  }, null, 2);
}

