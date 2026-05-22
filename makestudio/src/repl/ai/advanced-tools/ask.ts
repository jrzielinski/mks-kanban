/**
 * Advanced tool — ask topic. Extracted from advanced-tools.ts.
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

// ── AskUserQuestion tool ────────────────────────────────────────────────────

export const askUserQuestionToolDefinition: ToolDefinition = {
  name: 'AskUserQuestion',
  description:
    'Ask the user a multiple-choice question for genuine ambiguity. Read relevant files first — never ask what you can answer from the code. Use SPARINGLY: only for architectural choices, missing business rules, credentials, or destructive confirmations. Language of question/options must match the user\'s current language. Auto-adds an "Other" option — do NOT include it.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user.' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short label for the option.' },
            description: { type: 'string', description: 'Optional one-line explanation.' },
            recommended: { type: 'boolean', description: 'Mark as recommended (appears first with "(recommended)" hint).' },
          },
          required: ['label'],
        },
        description: '2-5 concrete options. You do NOT need to include an "Other/Custom" option — the tool always adds one automatically.',
      },
      multiSelect: { type: 'boolean', description: 'Allow multiple answers (comma-separated).' },
    },
    required: ['question', 'options'],
  },
};

/**
 * Ask the user interactively.
 *
 * When running in the TUI, we DON'T detach Ink — that races with stdin
 * handlers. Instead, we render the question as a TUI message and install
 * a pendingQuestion resolver in the bridge. The App's InputBox onSubmit
 * checks for a pendingQuestion BEFORE routing to chat — if present, it
 * resolves with the typed answer and we return here.
 *
 * When NOT in TUI (plain readline fallback), we prompt directly.
 */
export async function askUserImpl(input: any, _ctx: ReplContext): Promise<string> {
  const question: string = input.question || '';
  const options: Array<{ label: string; description?: string; recommended?: boolean }> = input.options || [];
  const multiSelect: boolean = !!input.multiSelect;

  // Sort: recommended first, preserve input order otherwise
  const sorted = [...options].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
  const otherIdx = sorted.length + 1;

  // Build the rendered question text (works in both paths)
  const lines: string[] = [];
  lines.push('');
  lines.push('? ' + question);
  lines.push('');
  sorted.forEach((o, i) => {
    const rec = o.recommended ? '  (recommended)' : '';
    lines.push(`  ${i + 1}. ${o.label}${rec}`);
    if (o.description) lines.push(`       ${o.description}`);
  });
  lines.push(`  ${otherIdx}. Other (free text)`);
  lines.push('');
  const questionText = lines.join('\n');
  const promptLabel = multiSelect
    ? 'Select one or more (comma-separated numbers/labels) or type free text'
    : 'Select (number, label, or free text)';

  // TUI path: use bridge + pendingQuestion
  const { getTuiBridge, setPendingQuestion } = require('../../tui/bridge');
  const bridge = getTuiBridge?.();
  if (bridge) {
    bridge.addMessage({ role: 'info', text: questionText });
    bridge.addMessage({ role: 'info', text: `→ ${promptLabel}` });
    const raw = await new Promise<string>((resolve) => {
      setPendingQuestion({ resolve, placeholder: promptLabel });
    });
    return interpretAnswer(raw, sorted, otherIdx, multiSelect);
  }

  // Non-TUI path: plain readline
  process.stdout.write(questionText + '\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((resolve) =>
    rl.question(`  ${promptLabel}: `, (a) => resolve(a.trim())),
  );
  rl.close();
  return interpretAnswer(ans, sorted, otherIdx, multiSelect);
}

export function interpretAnswer(
  raw: string,
  sorted: Array<{ label: string; description?: string; recommended?: boolean }>,
  otherIdx: number,
  multiSelect: boolean,
): string {
  if (!raw || !raw.trim()) return '(no answer)';
  const trimmed = raw.trim();
  if (multiSelect) {
    const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    return parts.map(p => resolveAnswer(p, sorted, otherIdx)).join('; ');
  }
  return resolveAnswer(trimmed, sorted, otherIdx);
}

export function resolveAnswer(
  raw: string,
  options: Array<{ label: string; description?: string; recommended?: boolean }>,
  otherIdx: number,
): string {
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) {
    if (n >= 1 && n <= options.length) return options[n - 1].label;
    if (n === otherIdx) return `(other: free text expected — user gave "${raw}")`;
  }
  const match = options.find(o => o.label.toLowerCase() === raw.toLowerCase());
  if (match) return match.label;
  // Treat anything else as free-text "Other"
  return `(other: ${raw})`;
}

