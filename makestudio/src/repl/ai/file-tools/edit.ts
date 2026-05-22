import { swallow } from '../../../utils/log';
/**
 * File tool — edit topic. Extracted from file-tools.ts.
 */
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
import { ReplContext } from '../../context';
import { ToolDefinition } from '../tools';
import { subprocessEnv } from '../../subprocess-env';
import { markRead, wasRead, requireAbsolute, readFileWithMetadata, encodeWithMetadata, canonicalizePath, relToCwd, expandTilde } from './path-utils';
import { scanSecrets, formatSecretsError } from './secrets-scanner';


const MAX_READ_LINES = 2000;
const DEFAULT_READ_LINE_WIDTH = 2000;    // chars per line truncation
const MAX_BASH_TIMEOUT_MS = 600_000;     // 10 min hard ceiling
const DEFAULT_BASH_TIMEOUT_MS = 120_000; // 2 min default

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
export function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');
}

// Prompt-injection defence: anti-harvest sanitisers sometimes rewrite
// common Anthropic/OpenAI XML tags (`<function_results>`, `<name>`, etc.)
// when replaying tool output back to the model. If the model then emits
// those short-form tokens in an Edit, they won't match the real file.
// We undo the sanitisation on BOTH old_string and new_string before we
// try to match. Port of Claude Code `DESANITIZATIONS`.
const DESANITIZATIONS: Array<[RegExp, string]> = [
  [/<fnr>/g, '<function_results>'],
  [/<\/fnr>/g, '</function_results>'],
  [/<n>/g, '<name>'],
  [/<\/n>/g, '</name>'],
  [/<o>/g, '<output>'],
  [/<\/o>/g, '</output>'],
  [/<e>/g, '<error>'],
  [/<\/e>/g, '</error>'],
  [/<s>/g, '<system>'],
  [/<\/s>/g, '</system>'],
  [/<r>/g, '<result>'],
  [/<\/r>/g, '</result>'],
  [/< META_START >/g, '<META_START>'],
  [/< META_END >/g, '<META_END>'],
  [/< EOT >/g, '<EOT>'],
  [/< META >/g, '<META>'],
  [/< SOS >/g, '<SOS>'],
  [/\n\nH:/g, '\n\nHuman:'],
  [/\n\nA:/g, '\n\nAssistant:'],
];
export function desanitize(s: string): string {
  let out = s;
  for (const [pat, rep] of DESANITIZATIONS) out = out.replace(pat, rep);
  return out;
}

/**
 * Returns null if the file on disk matches what we captured on the last
 * Read (mtime + size), or a human-readable error string describing the
 * race if it diverged. Caller (Edit/Write/MultiEdit impls) throws that
 * string as an Error so the LLM sees it in the tool_result.
 *
 * Port of Claude Code's check in FileEditTool.ts:290-311. Windows has a
 * known issue where cloud sync / AV bumps mtime without touching bytes —
 * for Write-style (full-replacement) edits we could fall back to content
 * hash, but since our Edit operates on `old_string` matches anyway, a
 * truly modified file will just fail the match naturally.
 */
export function detectFileRaceOrNull(ctx: ReplContext, filePath: string): string | null {
  try {
    const cache = ctx.readCache.get(filePath);
    if (!cache) return null; // no snapshot captured (e.g. cache reset); can't detect
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs === cache.mtime && stat.size === cache.size) return null;
    return (
      `File has been modified since you last read it (mtime/size changed). ` +
      `Re-read ${filePath} before editing — some other process (you, the user, a linter, another agent) ` +
      `wrote to it between your Read and this Edit. Do NOT retry the Edit with the same old_string — ` +
      `the content probably changed. Re-Read first, then rewrite your Edit against the fresh content.`
    );
  } catch { return null; /* stat failed → other error surfaces later */ }
}

/**
 * Map a range in the DESANITIZED view of `original` back to the corresponding
 * [start, end] range in the ORIGINAL string. Walks character by character,
 * tracking how much desanitized content has been produced so far; when the
 * desan cursor equals the requested index, records the real start; when it
 * equals `idx + len`, records the real end.
 *
 * Necessary because `desanitize` expands short tags (`<fnr>` → `<function_results>`),
 * so desanitized byte offsets DO NOT align with real offsets. Returns null when
 * the index can't be mapped (should be unreachable if the caller already found
 * a match in the desanitized view).
 */
export function mapDesanIndexToOriginalRange(
  original: string,
  desanIdx: number,
  desanLen: number,
): { start: number; end: number } | null {
  // Build desanitized incrementally. For every pattern in DESANITIZATIONS
  // that matches at the current cursor, consume that many original chars
  // and emit the replacement chars into the desan view. Otherwise advance
  // 1 char. We record the original offsets at the desan-cursor points of
  // interest.
  let orig = 0;
  let desan = 0;
  let start = -1;
  const targetStart = desanIdx;
  const targetEnd = desanIdx + desanLen;
  while (orig < original.length && desan < targetEnd) {
    // Check if any DESANITIZATIONS pattern matches at current orig cursor.
    let matchedLen = 0;
    let matchedRepLen = 0;
    for (const [pat, rep] of DESANITIZATIONS) {
      // Patterns are sticky regexes or literal strings; treat as literals
      // by scanning the source chunk. For the DESANITIZATIONS table we
      // actually have string-literal-like regexes with fixed widths.
      // We conservatively try each pattern as a literal prefix test.
      const src = (pat as RegExp).source;
      // Strip trivial regex escapes for literal tags like `<fnr>` → `<fnr>`.
      const literal = src.replace(/\\(.)/g, '$1');
      if (original.startsWith(literal, orig)) {
        matchedLen = literal.length;
        matchedRepLen = rep.length;
        break;
      }
    }
    if (matchedLen === 0) {
      // No pattern matched — advance 1 char in both views.
      if (desan === targetStart && start === -1) start = orig;
      orig++;
      desan++;
    } else {
      // Expansion — orig moves by matchedLen, desan moves by matchedRepLen.
      // The target index might fall INSIDE the expansion region; when it
      // does we accept `orig` as the start (the real tag begins here).
      if (start === -1 && desan <= targetStart && targetStart < desan + matchedRepLen) {
        start = orig;
      }
      orig += matchedLen;
      desan += matchedRepLen;
    }
  }
  if (start === -1 && desan === targetStart) start = orig;
  // For end, orig is already at the post-match position.
  const end = orig;
  if (start === -1 || end < start) return null;
  return { start, end };
}

export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  label: string,
): string {
  if (oldStr === newStr) {
    throw new Error(`${label}: old_string and new_string are identical.`);
  }

  // Tier 1 — exact match.
  let effectiveOld: string | null = null;
  let effectiveNew: string = newStr;
  if (content.includes(oldStr)) {
    effectiveOld = oldStr;
  }
  // Tier 2 — curly↔straight quote normalisation.
  // CORRECTNESS: `normalizeQuotes` is a 1-char-for-1-char transformation
  // (curly quotes → straight quotes), so CHARACTER indices align between
  // `content` and `normContent`. But BYTE offsets diverge on multibyte
  // UTF-8 runs (curly quote is 3 bytes, straight is 1). We operate on
  // JS strings (UTF-16 code units) and use character-indexed slicing,
  // so the slice below is correct AS LONG AS normalizeQuotes is 1:1.
  // Verified: our normalizeQuotes only swaps single-char codepoints.
  if (effectiveOld === null) {
    const normContent = normalizeQuotes(content);
    const normOld = normalizeQuotes(oldStr);
    if (normContent.includes(normOld)) {
      const idx = normContent.indexOf(normOld);
      // Slice must use normOld.length (= oldStr.length by 1:1 property) —
      // NOT `oldStr.length` as a separate literal (defensive: identical here
      // but named locally in case a future normalizeQuotes adds a multi-char
      // swap). The slice uses the ORIGINAL content at the SAME character
      // index. This is safe because normalizeQuotes is position-preserving.
      effectiveOld = content.slice(idx, idx + normOld.length);
      effectiveNew = newStr; // write the model's version — agent decides quote style
    }
  }
  // Tier 3 — desanitised tags (<fnr> → <function_results>, etc.).
  // CORRECTNESS: `desanitize` is NOT 1:1. `<fnr>` (5 chars) → `<function_results>`
  // (19 chars) changes indices. We CANNOT slice the original content at
  // the desanitised index. Instead, walk the original, building the
  // desanitised version incrementally, and remember where the real slice
  // starts/ends in the ORIGINAL content.
  if (effectiveOld === null) {
    const desanContent = desanitize(content);
    const desanOld = desanitize(oldStr);
    const desanIdx = desanContent.indexOf(desanOld);
    if (desanIdx !== -1) {
      const realRange = mapDesanIndexToOriginalRange(content, desanIdx, desanOld.length);
      if (realRange) {
        effectiveOld = content.slice(realRange.start, realRange.end);
        effectiveNew = desanitize(newStr);
      }
    }
  }

  if (effectiveOld === null) {
    throw new Error(
      `${label}: old_string not found in file. ` +
      `Tried exact match, curly-quote normalisation, and tag desanitisation. ` +
      `Check whitespace/indentation — paste the actual file content via Read first.`,
    );
  }

  if (!replaceAll) {
    const first = content.indexOf(effectiveOld);
    const second = content.indexOf(effectiveOld, first + 1);
    if (second !== -1) {
      throw new Error(
        `${label}: old_string matches multiple locations. ` +
        `Use replace_all=true or expand old_string with more surrounding context to make it unique.`,
      );
    }
    return content.replace(effectiveOld, effectiveNew);
  }
  return content.split(effectiveOld).join(effectiveNew);
}

export function editImpl(input: any, ctx: ReplContext): string {
  let filePath: string = expandTilde(input.file_path);
  requireAbsolute(filePath);
  filePath = canonicalizePath(filePath); // realpath + ..-fold (stress #3/#4)
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!wasRead(ctx, filePath)) {
    throw new Error(`You must Read ${filePath} before editing it.`);
  }
  // Race detection (Claude Code port): if the file's mtime+size no longer
  // match what we captured during the last Read in THIS turn, something
  // edited it between Read and now (user, linter, another agent). Refuse
  // the edit with an actionable message — the LLM should re-Read.
  const raceErr = detectFileRaceOrNull(ctx, filePath);
  if (raceErr) throw new Error(raceErr);
  // Secrets scanner — applies to new_string only (old_string came from
  // the file we're already overwriting, so it can't be the source of a
  // *new* leak). High-confidence patterns only; placeholder values like
  // "AKIATEST" are too short to match.
  const findingsEdit = scanSecrets(input.new_string ?? '');
  if (findingsEdit.length > 0) {
    throw new Error(formatSecretsError(findingsEdit, relToCwd(filePath, ctx.cwd)));
  }
  const { text: original, lineEnding, bom } = readFileWithMetadata(filePath);
  const next = applyEdit(original, input.old_string, input.new_string, !!input.replace_all, 'Edit');
  try { require('../../file-history').snapshotBeforeEdit(ctx.cwd, filePath); } catch (err) { swallow(err); }
  try { require('../../rewind').recordFileSnapshot(ctx, filePath); } catch (err) { swallow(err); }
  fs.writeFileSync(filePath, encodeWithMetadata(next, { lineEnding, bom }));
  // Post-write content verification (port of Claude Code FileEditTool.ts:299
  // content-hash fallback). Windows cloud-sync agents can briefly lock a file
  // and silently drop our write — mtime updates but the content stays stale.
  // Re-read + compare to catch it before the model assumes success.
  try {
    const { text: onDisk } = readFileWithMetadata(filePath);
    if (onDisk !== next) {
      throw new Error(
        `Edit wrote to ${filePath} but the on-disk content does not match the expected result. ` +
        `This usually means a cloud-sync agent (OneDrive/Dropbox) or antivirus briefly held the file. ` +
        `Retry the Edit in 1-2 seconds, or pause the sync agent before editing.`,
      );
    }
  } catch (e: any) {
    // If the re-read itself failed (unlikely — we just wrote it), surface
    // a clearer error. Re-throw the thrown verification error above.
    if (e && /does not match the expected result/.test(e.message || '')) throw e;
  }
  const rel = relToCwd(filePath, ctx.cwd);
  const header = `Edited ${rel}.`;
  try {
    const { renderDiff } = require('../../diff-render');
    const diff = renderDiff(original, next, { filePath: rel, context: 3, maxLines: 120 });
    return capEditResult(`${header}\n${diff}`);
  } catch {
    return header;
  }
}

/**
 * Cap Edit/MultiEdit tool result to prevent pathological diffs from blowing
 * the tool-result size budget. Port of Claude Code's FileEditTool
 * maxResultSizeChars=100_000 guard. A malformed binary-treated-as-text or
 * an adversarial content swap could otherwise produce multi-MB diff output.
 */
const EDIT_RESULT_MAX_CHARS = 100_000;
export function capEditResult(s: string): string {
  if (s.length <= EDIT_RESULT_MAX_CHARS) return s;
  return s.slice(0, EDIT_RESULT_MAX_CHARS) + `\n\n... [diff truncated at ${EDIT_RESULT_MAX_CHARS} chars]`;
}


export function multiEditImpl(input: any, ctx: ReplContext): string {
  let filePath: string = expandTilde(input.file_path);
  requireAbsolute(filePath);
  filePath = canonicalizePath(filePath); // realpath + ..-fold (stress #3/#4)
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!wasRead(ctx, filePath)) {
    throw new Error(`You must Read ${filePath} before editing it.`);
  }
  const raceErr = detectFileRaceOrNull(ctx, filePath);
  if (raceErr) throw new Error(raceErr);
  const edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = input.edits || [];
  if (edits.length === 0) throw new Error('MultiEdit: edits array is empty.');

  // Secrets scanner — concat all new_strings and scan once. One leaked
  // pattern across any edit blocks the whole batch, which is correct
  // (the file would land on disk with the secret if even one survived).
  const concatNew = edits.map((e) => e.new_string ?? '').join('\n');
  const findingsMulti = scanSecrets(concatNew);
  if (findingsMulti.length > 0) {
    throw new Error(formatSecretsError(findingsMulti, relToCwd(filePath, ctx.cwd)));
  }

  const { text: original, lineEnding, bom } = readFileWithMetadata(filePath);
  let content = original;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    content = applyEdit(content, e.old_string, e.new_string, !!e.replace_all, `MultiEdit[${i + 1}/${edits.length}]`);
  }
  try { require('../../file-history').snapshotBeforeEdit(ctx.cwd, filePath); } catch (err) { swallow(err); }
  try { require('../../rewind').recordFileSnapshot(ctx, filePath); } catch (err) { swallow(err); }
  fs.writeFileSync(filePath, encodeWithMetadata(content, { lineEnding, bom }));
  const rel = relToCwd(filePath, ctx.cwd);
  const header = `MultiEdit applied ${edits.length} edit(s) to ${rel}.`;
  try {
    const { renderDiff } = require('../../diff-render');
    const diff = renderDiff(original, content, { filePath: rel, context: 3, maxLines: 160 });
    return capEditResult(`${header}\n${diff}`);
  } catch {
    return header;
  }
}

