import { swallow } from '../../utils/log';
/**
 * file-tools.ts
 *
 * Core file/code tools exposed to the REPL AI: Read, Write, Edit, MultiEdit,
 * Glob, Grep, Bash. Implementations are self-contained — no dependency on any
 * third-party CLI agent — so the REPL can operate as a complete code agent.
 *
 * Safety rails:
 *   - Write requires a prior Read of the same absolute path in-session
 *     (prevents clobbering files the agent hasn't inspected).
 *   - Edit requires old_string to be unique in the file (unless replace_all).
 *   - Bash runs through the session sandbox wrapper, with a hard ceiling on
 *     timeout and a default 2min.
 *   - Paths must be absolute.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import fastGlob from 'fast-glob';
import { ReplContext } from '../context';
import type { ToolDefinition } from './tools';
import { subprocessEnv } from '../subprocess-env';
import { markRead, wasRead, requireAbsolute, readFileWithMetadata, encodeWithMetadata, canonicalizePath, relToCwd } from './file-tools/path-utils';
import { readImpl } from './file-tools/read';
import { writeImpl } from './file-tools/write';
import { editImpl, multiEditImpl } from './file-tools/edit';
import { globImpl, grepImpl } from './file-tools/search';
import { bashImpl } from './file-tools/bash';

const MAX_READ_LINES = 2000;
const DEFAULT_READ_LINE_WIDTH = 2000;    // chars per line truncation
const MAX_BASH_TIMEOUT_MS = 600_000;     // 10 min hard ceiling
const DEFAULT_BASH_TIMEOUT_MS = 120_000; // 2 min default

// ── Tool definitions ────────────────────────────────────────────────────────

export const fileToolDefinitions: ToolDefinition[] = [
  {
    name: 'Read',
    description:
      'Read a file from the local filesystem. Returns text with 1-indexed line numbers (cat -n style) so line references are unambiguous.\n\n' +
      'Use when: you need to see actual file contents before editing, understand structure of an unfamiliar file, or verify a fix.\n\n' +
      'DO NOT use when: you only want to find a symbol/pattern (use Grep), list files in a directory (use Glob), or check existence (use Bash test -f). Reading an entire large file to grep it yourself wastes tokens — use Grep.\n\n' +
      'PDFs: text layer extracted via pdf-parse (offset/limit paginate logical lines).\n' +
      'Images (.png/.jpg/.gif/.webp/.bmp/.tiff): returns metadata — actual pixels flow via image paste/attachment; don\'t call Read to "see" an image.\n' +
      'Files > 256KB require offset + limit — refusing the default full-read is deliberate (use Grep instead of paging a 10MB log).\n' +
      'Always use absolute paths. `file_path` is the only required field.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Defaults to 1.' },
        limit: { type: 'number', description: `Max lines to read. Defaults to ${MAX_READ_LINES}.` },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description:
      'Write content to a file, creating it or OVERWRITING it entirely. If the file already exists you MUST have Read it first in this session (safety rail). Prefer Edit for modifying existing files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        content: { type: 'string', description: 'Full content to write.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description:
      'Exact string replacement in a text file. You MUST have Read the file first (race detection compares mtime+size).\n\n' +
      'Use when: changing specific lines/regions you already know the exact text of, including indentation and surrounding context.\n\n' +
      'DO NOT use when: you want to overwrite the whole file (use Write), make many similar changes across files (use Bash/sed or plan a MultiEdit per file), or you didn\'t Read the file (the tool will refuse).\n\n' +
      '`old_string` must appear EXACTLY ONCE unless `replace_all: true`. Include surrounding context in old_string to make it unique — 3 lines before + 3 after is usually enough.\n' +
      'Preserves: tabs vs spaces, CRLF/LF, UTF-8 BOM. Edits to the plan file in plan mode are allowed; Edits elsewhere in plan mode are blocked.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        old_string: { type: 'string', description: 'Exact text to find.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness. Default false.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'MultiEdit',
    description:
      'Apply multiple Edit operations to a single file in one call. All edits are applied sequentially in order, each building on the result of the previous. If any fails, none are persisted. Faster than many Edit calls.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_string', 'new_string'],
          },
          description: 'Edits to apply in order.',
        },
      },
      required: ['file_path', 'edits'],
    },
  },
  {
    name: 'Glob',
    description:
      '- Fast file pattern matching tool that works with any codebase size\n' +
      '- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
      '- Returns matching file paths sorted by modification time\n' +
      '- Use this tool when you need to find files by name patterns\n' +
      '- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n\n' +
      'IMPORTANT: a bare pattern like "*.dart" only searches the top level. To find files anywhere in the tree, you MUST prefix with "**/", e.g. "**/*.dart". If a top-level pattern returns nothing, DO NOT ask the user "does this project have X?" — retry with "**/X" before concluding the file is absent.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. Use "**/" to search recursively.' },
        path: { type: 'string', description: 'Directory to search in. Defaults to current working directory.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description:
      'Search file contents with ripgrep. Full regex (including backreferences, lookbehind not supported). Gitignore respected by default.\n\n' +
      'Use when: searching for a symbol, config key, error string, or pattern across files. Prefer Grep OVER Read+grep-yourself.\n\n' +
      'DO NOT use when: you want to see all files with a given NAME (use Glob), need the file CONTENTS (use Read after narrowing with Grep), or you already know the exact path (just Read it).\n\n' +
      'Modes:\n' +
      '  - `files_with_matches` (default): returns paths only — fastest for scoping.\n' +
      '  - `content`: matching lines; add `-n` for line numbers, `-A/-B/-C` for context.\n' +
      '  - `count`: per-file hit counts — useful before drilling into a specific file.\n' +
      'Filter scope with `glob: "*.ts"` or `type: "js"`. Paginate long results with `head_limit` + `offset`.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to cwd.' },
        glob: { type: 'string', description: 'Filter files by glob (e.g. "*.ts", "*.{ts,tsx}").' },
        type: { type: 'string', description: 'Restrict by file type (e.g. "js", "py", "rust", "go", "ts").' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode. Default: files_with_matches.',
        },
        '-i': { type: 'boolean', description: 'Case-insensitive match.' },
        '-n': { type: 'boolean', description: 'Show line numbers (only in content mode).' },
        '-A': { type: 'number', description: 'Lines of context after each match (content mode only).' },
        '-B': { type: 'number', description: 'Lines of context before each match (content mode only).' },
        '-C': { type: 'number', description: 'Lines of context both sides (content mode only).' },
        head_limit: { type: 'number', description: 'Limit output to first N entries. Default 250.' },
        offset: { type: 'number', description: 'Skip first N entries before head_limit (pagination). Default 0.' },
        multiline: { type: 'boolean', description: 'Enable multiline mode so pattern can span lines.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Bash',
    description:
      'Execute a shell command. Timeout defaults to 2min (hard cap 10min). Output is captured and returned. Use `run_in_background: true` for long-running commands (builds, watchers) — returns a task_id immediately; poll with TaskOutput. Prefer dedicated tools (Read, Edit, Grep, Glob) when they fit.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        description: { type: 'string', description: 'Short description (5-10 words).' },
        timeout: { type: 'number', description: 'Optional timeout in ms (max 600000). Ignored when run_in_background is true.' },
        cwd: { type: 'string', description: 'Optional working directory. Defaults to session cwd.' },
        run_in_background: {
          type: 'boolean',
          description: 'When true, run the command as a non-blocking background task and return a task_id immediately. Use TaskOutput to poll output, TaskStop to cancel.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'NotebookEdit',
    description:
      'Edit a Jupyter notebook (.ipynb). Supports 3 operations:\n' +
      '  - replace: overwrite an existing cell\'s source\n' +
      '  - insert: add a new cell at the given index (pushes others down)\n' +
      '  - delete: remove a cell entirely\n\n' +
      'Cell indices are 0-based. Always Read the notebook first to see the current cell layout. ' +
      'The notebook\'s `metadata` (kernelspec, language_info) is preserved. ' +
      'Outputs are CLEARED on replace (stale output vs new source is worse than no output). ' +
      'If you need to add a markdown heading + a code cell, call NotebookEdit twice.',
    input_schema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
        operation: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'What to do with the cell.' },
        cell_index: { type: 'number', description: '0-based index. For insert, the new cell goes at this position (use array length to append).' },
        new_source: { type: 'string', description: 'Cell source. Required for replace/insert. Use \\n for newlines; the tool splits it into the notebook\'s line array format.' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Required for insert. Defaults to "code".' },
      },
      required: ['notebook_path', 'operation', 'cell_index'],
    },
  },
];
// MAX_READ_LINES + bash timeouts moved above fileToolDefinitions block (declared earlier).

// Per-session tracking: set of absolute paths that have been read.
// Write/Edit require the path to be in this set to prevent blind overwrites.
//
// Capped LRU via insertion-order deletion (Set preserves insertion order).
// Stress test #13 flagged the old unbounded Set as a slow leak: long sessions
// reading 1000s of unique files accumulated proportional memory. With the cap,
// the oldest-read path is evicted once we exceed MAX_READ_PATHS_PER_SESSION —
// the only user-visible impact is that a very-long-ago Read no longer
// satisfies the "Read-before-Write" gate, which just forces an extra Read.
const MAX_READ_PATHS_PER_SESSION = 1000;
const readPaths: WeakMap<ReplContext, Set<string>> = new WeakMap();

// ── Dispatch ────────────────────────────────────────────────────────────────

function planModeGate(name: string, input: any, ctx: ReplContext): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const adv = eval('require')('./advanced-tools');
    if (!adv.isPlanModeActive?.(ctx)) return null;
    const planFile = adv.getPlanFilePath?.(ctx);

    if (name === 'Write') {
      // Allow only writes to the plan file itself
      if (input.file_path && planFile && path.resolve(input.file_path) === path.resolve(planFile)) return null;
      return `[blocked] plan mode is active — Write is only allowed for the plan file at ${planFile}. ` +
        `Call ExitPlanMode when the plan is complete to resume editing.`;
    }
    if (name === 'Edit' || name === 'MultiEdit') {
      if (input.file_path && planFile && path.resolve(input.file_path) === path.resolve(planFile)) return null;
      return `[blocked] plan mode is active — ${name} is disabled. Write the plan via Write to ${planFile}, then ExitPlanMode.`;
    }
    if (name === 'Bash') {
      const cmd = String(input.command || '').trim().toLowerCase();
      // Allow only read-only git subcommands in plan mode
      const allowed = /^(git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files)\b)/.test(cmd)
        || /^(ls|pwd|wc|head|tail|cat|file|find|stat)\b/.test(cmd);
      if (allowed) return null;
      return `[blocked] plan mode is active — Bash is restricted to read-only commands (git status/log/diff/show/branch/remote/rev-parse/ls-files, ls, pwd, wc, head, tail, cat, file, find, stat). Call ExitPlanMode to run arbitrary commands.`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * NotebookEdit — manipulates .ipynb files (Fase 4.4).
 *
 * Reads the notebook JSON, mutates the `cells` array per the operation,
 * writes it back with the original metadata (kernelspec, language_info)
 * preserved. Outputs are cleared on replace — stale outputs bound to
 * old source are worse than no outputs.
 *
 * Notebooks store source as either a string OR an array of strings (one
 * per line, each with trailing newline). We always write arrays for
 * better git diff readability.
 */
function notebookEditImpl(input: any, ctx: ReplContext): string {
  let file: string = input.notebook_path;
  if (!file || typeof file !== 'string') {
    throw new Error('NotebookEdit requires `notebook_path` (absolute path to a .ipynb file).');
  }
  requireAbsolute(file);
  file = canonicalizePath(file); // realpath + ..-fold (stress #3/#4)
  if (!file.endsWith('.ipynb')) throw new Error(`Not a notebook: ${file} (expected .ipynb)`);
  if (!fs.existsSync(file)) throw new Error(`Notebook not found: ${file}`);

  const op: string = input.operation;
  if (!['replace', 'insert', 'delete'].includes(op)) {
    throw new Error(`Invalid operation "${op}" — use replace/insert/delete.`);
  }
  const idx: number = Number(input.cell_index);
  if (!Number.isFinite(idx) || idx < 0) throw new Error('cell_index must be a non-negative integer.');

  // Snapshot for /undo-file (per-file) and /rewind (per-turn) before we mutate.
  try { require('../file-history').snapshotBeforeEdit(ctx.cwd, file); } catch (err) { swallow(err); }
  try { require('../rewind').recordFileSnapshot(ctx, file); } catch (err) { swallow(err); }

  let nb: any;
  try { nb = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err: any) { throw new Error(`Notebook is not valid JSON: ${err.message}`); }
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Notebook has no `cells` array — not a valid ipynb.');

  const cells = nb.cells;

  // Format source as array-of-strings (one per line, preserving trailing newline).
  const toSourceArray = (s: string): string[] => {
    if (s === '') return [];
    const lines = s.split('\n');
    return lines.map((ln, i) => (i < lines.length - 1 ? ln + '\n' : ln));
  };

  if (op === 'delete') {
    if (idx >= cells.length) throw new Error(`cell_index ${idx} out of range (notebook has ${cells.length} cells).`);
    const removed = cells.splice(idx, 1)[0];
    fs.writeFileSync(file, JSON.stringify(nb, null, 1) + '\n', 'utf8');
    markRead(ctx, file);
    const removedType = removed?.cell_type || 'unknown';
    return `Deleted cell ${idx} (${removedType}). Notebook now has ${cells.length} cell(s).`;
  }

  if (op === 'insert') {
    const cellType = (input.cell_type as string) || 'code';
    if (!['code', 'markdown', 'raw'].includes(cellType)) {
      throw new Error(`Invalid cell_type "${cellType}".`);
    }
    if (typeof input.new_source !== 'string') {
      throw new Error('insert requires `new_source` (string).');
    }
    if (idx > cells.length) throw new Error(`cell_index ${idx} beyond end (notebook has ${cells.length} cells, max insert index is ${cells.length}).`);
    const newCell: any = {
      cell_type: cellType,
      source: toSourceArray(input.new_source),
      metadata: {},
    };
    if (cellType === 'code') {
      newCell.execution_count = null;
      newCell.outputs = [];
    }
    cells.splice(idx, 0, newCell);
    fs.writeFileSync(file, JSON.stringify(nb, null, 1) + '\n', 'utf8');
    markRead(ctx, file);
    return `Inserted ${cellType} cell at index ${idx}. Notebook now has ${cells.length} cell(s).`;
  }

  // replace
  if (idx >= cells.length) throw new Error(`cell_index ${idx} out of range (notebook has ${cells.length} cells).`);
  if (typeof input.new_source !== 'string') {
    throw new Error('replace requires `new_source` (string).');
  }
  const target = cells[idx];
  target.source = toSourceArray(input.new_source);
  // Clear stale outputs — agent's new source may have nothing to do with
  // the previous execution's output; keeping them is misleading.
  if (target.cell_type === 'code') {
    target.outputs = [];
    target.execution_count = null;
  }
  fs.writeFileSync(file, JSON.stringify(nb, null, 1) + '\n', 'utf8');
  markRead(ctx, file);
  return `Replaced source of cell ${idx} (${target.cell_type}). Outputs cleared.`;
}

export async function executeFileTool(name: string, input: any, ctx: ReplContext): Promise<string> {
  const blocked = planModeGate(name, input, ctx);
  if (blocked) return blocked;
  switch (name) {
    case 'Read':         return await readImpl(input, ctx);
    case 'Write':        return writeImpl(input, ctx);
    case 'Edit':         return editImpl(input, ctx);
    case 'MultiEdit':    return multiEditImpl(input, ctx);
    case 'Glob':         return globImpl(input, ctx);
    case 'Grep':         return grepImpl(input, ctx);
    case 'Bash':         return await bashImpl(input, ctx);
    case 'NotebookEdit': return notebookEditImpl(input, ctx);
    default:
      throw new Error(`Unknown file tool: ${name}`);
  }
}

export function isFileToolName(name: string): boolean {
  return ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'NotebookEdit'].includes(name);
}
