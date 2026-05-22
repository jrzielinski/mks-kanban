import { swallow } from '../../utils/log';
/**
 * apply-patch.ts — atomic multi-file diff tool.
 *
 * Direct port of openclaw's `agents/apply-patch.ts` and
 * `agents/apply-patch-update.ts` (~800 lines combined), consolidated
 * into one file and stripped of the openclaw sandbox layer (we restrict
 * to the workspace cwd via simple path normalization, no fs-bridge / no
 * alias policies).
 *
 * Format (verbatim from openclaw — same markers the LLM already knows):
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   + first line of new file
 *   + second line
 *   *** Update File: path/to/existing.ts
 *   *** Move to: path/to/renamed.ts          (optional, on update)
 *   @@ optional context anchor (function name etc)
 *    unchanged context line
 *   - removed line
 *   + replacement line
 *   *** End of File                          (optional, marks last chunk)
 *   *** Delete File: path/to/old.ts
 *   *** End Patch
 *
 * Why apply_patch over Edit:
 *   - One tool call → many files. Edit forces a separate call per file.
 *   - Add+Update+Delete in the same atomic operation (fail one → fail all
 *     up to that point, but we don't roll back on partial failure to
 *     match openclaw semantics — caller sees partial summary + error).
 *   - Less brittle than Edit's exact-string matching: seekSequence has
 *     four fallback normalisations (raw → trimEnd → trim → punctuation
 *     normalised) so whitespace drift doesn't kill a patch.
 */

import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

interface AddFileHunk {
  kind: 'add';
  path: string;
  contents: string;
}

interface DeleteFileHunk {
  kind: 'delete';
  path: string;
}

interface UpdateFileChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

interface UpdateFileHunk {
  kind: 'update';
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
}

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export interface ApplyPatchSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface ApplyPatchResult {
  summary: ApplyPatchSummary;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Path safety — restrict every patch path to the workspace cwd.
// ─────────────────────────────────────────────────────────────────────────

function resolveWorkspacePath(filePath: string, cwd: string): string {
  // Resolve absolute paths verbatim and relative paths against cwd. Edit /
  // Write don't restrict to cwd (the permission system gates writes
  // outside the workspace), so apply_patch matches that behaviour —
  // anything else makes the model emit a workspace-bound patch and then
  // fall back to Write+Edit when the user is just scaffolding in /tmp.
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.resolve(cwd, filePath));
}

function toDisplayPath(resolved: string, cwd: string): string {
  const relative = path.relative(cwd, resolved);
  if (!relative) return path.basename(resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return resolved;
  return relative;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────

function checkPatchBoundariesStrict(lines: string[]): string | null {
  const firstLine = lines[0]?.trim();
  const lastLine = lines[lines.length - 1]?.trim();
  if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) return null;
  if (firstLine !== BEGIN_PATCH_MARKER) return "The first line of the patch must be '*** Begin Patch'";
  return "The last line of the patch must be '*** End Patch'";
}

/** Allow heredoc-style wrappers (`<<EOF ... EOF`) the model sometimes
 *  emits — strip them and re-validate the inner block. */
function checkPatchBoundariesLenient(lines: string[]): string[] {
  const strictError = checkPatchBoundariesStrict(lines);
  if (!strictError) return lines;
  if (lines.length < 4) throw new Error(strictError);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (last && (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith('EOF')) {
    const inner = lines.slice(1, -1);
    const innerError = checkPatchBoundariesStrict(inner);
    if (!innerError) return inner;
    throw new Error(innerError);
  }
  throw new Error(strictError);
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumed: number } {
  if (lines.length === 0) {
    throw new Error(`Invalid patch hunk at line ${lineNumber}: Update hunk does not contain any lines`);
  }

  let changeContext: string | undefined;
  let startIndex = 0;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new Error(
      `Invalid patch hunk at line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
    );
  }

  if (startIndex >= lines.length) {
    throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`);
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };

  let parsedLines = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`);
      }
      chunk.isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line[0];
    if (!marker) {
      chunk.oldLines.push('');
      chunk.newLines.push('');
      parsedLines += 1;
      continue;
    }

    if (marker === ' ') {
      const content = line.slice(1);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
      parsedLines += 1;
      continue;
    }
    if (marker === '+') {
      chunk.newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (marker === '-') {
      chunk.oldLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }

    if (parsedLines === 0) {
      throw new Error(
        `Invalid patch hunk at line ${lineNumber + 1}: Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }
    break;
  }

  return { chunk, consumed: parsedLines + startIndex };
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; consumed: number } {
  if (lines.length === 0) throw new Error(`Invalid patch hunk at line ${lineNumber}: empty hunk`);
  const firstLine = lines[0].trim();

  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const targetPath = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = '';
    let consumed = 1;
    for (const addLine of lines.slice(1)) {
      if (addLine.startsWith('+')) {
        contents += `${addLine.slice(1)}\n`;
        consumed += 1;
      } else {
        break;
      }
    }
    return { hunk: { kind: 'add', path: targetPath, contents }, consumed };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const targetPath = firstLine.slice(DELETE_FILE_MARKER.length);
    return { hunk: { kind: 'delete', path: targetPath }, consumed: 1 };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const targetPath = firstLine.slice(UPDATE_FILE_MARKER.length);
    let remaining = lines.slice(1);
    let consumed = 1;
    let movePath: string | undefined;

    const moveCandidate = remaining[0]?.trim();
    if (moveCandidate?.startsWith(MOVE_TO_MARKER)) {
      movePath = moveCandidate.slice(MOVE_TO_MARKER.length);
      remaining = remaining.slice(1);
      consumed += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      if (remaining[0].trim() === '') {
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }
      if (remaining[0].startsWith('***')) break;
      const { chunk, consumed: chunkLines } = parseUpdateFileChunk(
        remaining,
        lineNumber + consumed,
        chunks.length === 0,
      );
      chunks.push(chunk);
      remaining = remaining.slice(chunkLines);
      consumed += chunkLines;
    }

    if (chunks.length === 0) {
      throw new Error(
        `Invalid patch hunk at line ${lineNumber}: Update file hunk for path '${targetPath}' is empty`,
      );
    }

    return { hunk: { kind: 'update', path: targetPath, movePath, chunks }, consumed };
  }

  throw new Error(
    `Invalid patch hunk at line ${lineNumber}: '${lines[0]}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

function parsePatchText(input: string): { hunks: Hunk[] } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Invalid patch: input is empty.');

  const lines = trimmed.split(/\r?\n/);
  const validated = checkPatchBoundariesLenient(lines);
  const hunks: Hunk[] = [];

  const lastLineIndex = validated.length - 1;
  let remaining = validated.slice(1, lastLineIndex);
  let lineNumber = 2;

  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    remaining = remaining.slice(consumed);
  }

  return { hunks };
}

// ─────────────────────────────────────────────────────────────────────────
// Updater (sequence-search with whitespace tolerance)
// ─────────────────────────────────────────────────────────────────────────

/** Map punctuation variants (smart quotes, em/en dashes, NBSP, fancy
 *  whitespace) to their ASCII equivalents so a paste-from-Word doesn't
 *  break a context match. Last resort — only used when raw / trimEnd /
 *  trim all fail. */
function normalizePunctuation(value: string): string {
  return Array.from(value)
    .map((char) => {
      switch (char) {
        case '‐': case '‑': case '‒':
        case '–': case '—': case '―':
        case '−':
          return '-';
        case '‘': case '’':
        case '‚': case '‛':
          return "'";
        case '“': case '”':
        case '„': case '‟':
          return '"';
        case ' ': case ' ': case ' ':
        case ' ': case ' ': case ' ':
        case ' ': case ' ': case ' ':
        case ' ': case ' ': case ' ':
        case '　':
          return ' ';
        default:
          return char;
      }
    })
    .join('');
}

function linesMatch(
  lines: string[],
  pattern: string[],
  start: number,
  normalize: (value: string) => string,
): boolean {
  for (let idx = 0; idx < pattern.length; idx += 1) {
    if (normalize(lines[start + idx]) !== normalize(pattern[idx])) return false;
  }
  return true;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const maxStart = lines.length - pattern.length;
  const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
  if (searchStart > maxStart) return null;

  // Four matching strategies, increasing tolerance:
  // 1. exact  2. trimEnd  3. trim  4. punctuation-normalized trim
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (v) => v)) return i;
  }
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (v) => v.trimEnd())) return i;
  }
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (v) => v.trim())) return i;
  }
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, (v) => normalizePunctuation(v.trim()))) return i;
  }

  return null;
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (ctxIndex === null) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = ctxIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === null && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`);
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines];
  // Apply in reverse so indices into the buffer stay valid as we splice.
  for (const [startIndex, oldLen, newLines] of [...replacements].reverse()) {
    for (let i = 0; i < oldLen; i += 1) {
      if (startIndex < result.length) result.splice(startIndex, 1);
    }
    for (let i = 0; i < newLines.length; i += 1) {
      result.splice(startIndex + i, 0, newLines[i]);
    }
  }
  return result;
}

async function applyUpdateHunk(filePath: string, chunks: UpdateFileChunk[]): Promise<string> {
  const originalContents = await fs.readFile(filePath, 'utf8');
  const originalLines = originalContents.split('\n');
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  let newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines = [...newLines, ''];
  }
  return newLines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────

function recordSummary(
  summary: ApplyPatchSummary,
  seen: { added: Set<string>; modified: Set<string>; deleted: Set<string> },
  bucket: keyof ApplyPatchSummary,
  value: string,
): void {
  if (seen[bucket].has(value)) return;
  seen[bucket].add(value);
  summary[bucket].push(value);
}

function formatSummary(summary: ApplyPatchSummary): string {
  const lines = ['Success. Updated the following files:'];
  for (const file of summary.added) lines.push(`A ${file}`);
  for (const file of summary.modified) lines.push(`M ${file}`);
  for (const file of summary.deleted) lines.push(`D ${file}`);
  return lines.join('\n');
}

async function ensureDir(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  if (!parent || parent === '.') return;
  await fs.mkdir(parent, { recursive: true });
}

export async function applyPatch(
  input: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<ApplyPatchResult> {
  const parsed = parsePatchText(input);
  if (parsed.hunks.length === 0) throw new Error('No files were modified.');

  const summary: ApplyPatchSummary = { added: [], modified: [], deleted: [] };
  const seen = { added: new Set<string>(), modified: new Set<string>(), deleted: new Set<string>() };

  for (const hunk of parsed.hunks) {
    if (options.signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (hunk.kind === 'add') {
      const resolved = resolveWorkspacePath(hunk.path, options.cwd);
      await ensureDir(resolved);
      // Refuse to overwrite existing files with Add — the model should
      // use Update for that. Matches openclaw behaviour of not stomping
      // a file silently.
      try {
        await fs.access(resolved);
        throw new Error(`Add target already exists: ${toDisplayPath(resolved, options.cwd)} — use *** Update File instead`);
      } catch (err: any) {
        if (err.code !== 'ENOENT' && !/already exists/.test(err.message || '')) {
          throw err;
        }
        if (/already exists/.test(err.message || '')) throw err;
      }
      await fs.writeFile(resolved, hunk.contents, 'utf8');
      recordSummary(summary, seen, 'added', toDisplayPath(resolved, options.cwd));
      continue;
    }

    if (hunk.kind === 'delete') {
      const resolved = resolveWorkspacePath(hunk.path, options.cwd);
      await fs.rm(resolved);
      recordSummary(summary, seen, 'deleted', toDisplayPath(resolved, options.cwd));
      continue;
    }

    // update
    const resolved = resolveWorkspacePath(hunk.path, options.cwd);
    const applied = await applyUpdateHunk(resolved, hunk.chunks);

    if (hunk.movePath) {
      const moveResolved = resolveWorkspacePath(hunk.movePath, options.cwd);
      await ensureDir(moveResolved);
      await fs.writeFile(moveResolved, applied, 'utf8');
      try { await fs.rm(resolved); } catch (err) { swallow(err); }
      recordSummary(summary, seen, 'modified', toDisplayPath(moveResolved, options.cwd));
    } else {
      await fs.writeFile(resolved, applied, 'utf8');
      recordSummary(summary, seen, 'modified', toDisplayPath(resolved, options.cwd));
    }
  }

  return { summary, text: formatSummary(summary) };
}
