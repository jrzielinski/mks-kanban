import { swallow } from '../../../utils/log';
/**
 * File tool — write topic. Extracted from file-tools.ts.
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
import { markRead, wasRead, requireAbsolute, rejectDevicePath, readFileWithMetadata, encodeWithMetadata, canonicalizePath, relToCwd, expandTilde } from './path-utils';
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
export function writeImpl(input: any, ctx: ReplContext): string {
  let filePath: string = expandTilde(input.file_path);
  const content: string = input.content ?? '';
  requireAbsolute(filePath);
  rejectDevicePath(filePath); // /dev/*, DOS reserved, etc.
  filePath = canonicalizePath(filePath); // realpath + ..-fold (stress #3/#4)
  rejectDevicePath(filePath); // re-check after symlink resolution

  // ── DUM pre-write validation hook ────────────────────────────────
  // When the agent is enriching a DUM (env vars set by enrich-pass),
  // validate the JSON BEFORE landing on disk. Failures throw, the LLM
  // gets the error as the tool result, and corrects in the same loop —
  // saves the fix-pass round-trip after a server-side gate rejection.
  if (/\.makestudio\/dums\/dum_\d+\.json$/.test(filePath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { validateDumJson, formatValidationError } = require('../../decompose/dum-write-validator');
      const expectedTempId = process.env.MAKESTUDIO_DECOMPOSITION_TEMPID || undefined;
      const expectedType = process.env.MAKESTUDIO_DECOMPOSITION_TYPE || undefined;
      const sectionsCsv = process.env.MAKESTUDIO_DECOMPOSITION_SECTIONS || '';
      const expectedSections = sectionsCsv
        ? sectionsCsv.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const result = validateDumJson(content, { expectedTempId, expectedType, expectedSections });
      if (!result.ok) {
        const fileName = filePath.split('/').pop() || filePath;
        throw new Error(formatValidationError(result, fileName));
      }
    } catch (err: any) {
      // Re-throw validation errors so the LLM sees them. Module-load
      // errors (validator missing) are swallowed — better to write the
      // file than to block on infra.
      if (err?.message?.startsWith('Refused to write')) throw err;
    }
  }

  const exists = fs.existsSync(filePath);
  if (exists && !wasRead(ctx, filePath)) {
    throw new Error(
      `Refusing to overwrite existing file without a prior Read: ${filePath}. ` +
      `Call Read first to inspect its contents, then Write (or prefer Edit/MultiEdit).`,
    );
  }

  // Conflict detection — multi-cwd writes / external tool wrote to
  // the file between our Read and now. The cached entry was stamped
  // with the file's mtime at Read time; if disk mtime differs, someone
  // else (another agent session, the user's editor, a git hook) has
  // touched the file since. Refuse rather than blindly overwrite.
  const cacheEntry = ctx.readCache.get(filePath);
  if (exists && cacheEntry && cacheEntry.mtime > 0) {
    const liveStat = (() => { try { return fs.statSync(filePath); } catch { return null; } })();
    if (liveStat && Math.abs(liveStat.mtimeMs - cacheEntry.mtime) > 1) {
      throw new Error(
        `Refusing to overwrite ${filePath} — file was modified externally since the last Read ` +
        `(cached mtime ${new Date(cacheEntry.mtime).toISOString()}, current ${new Date(liveStat.mtimeMs).toISOString()}). ` +
        `Read again to load the updated content, then re-issue the Write.`,
      );
    }
  }

  // Reject if the prior Read was a partial view (offset/limit truncated).
  // Without this guard, the model can issue Read({offset:1, limit:50}) on
  // a 500-line file, then Write the whole file with content reconstructed
  // from those 50 lines — silently destroying lines 51-500. Force a fresh
  // full Read first. Mirrors claude-code's FileStateCache.isPartialView
  // gate (utils/fileStateCache.ts).
  const cached = ctx.readCache.get(filePath);
  if (exists && cached?.partialView) {
    throw new Error(
      `Refusing to overwrite ${filePath} — your last Read was a partial view (offset/limit was used, or the file exceeded the default read window). ` +
      `Call Read again WITHOUT offset/limit to load the whole file before overwriting it. ` +
      `If you only want to change specific lines, use Edit/MultiEdit instead — those are safe with partial reads.`,
    );
  }

  // Secrets scanner — high-confidence patterns only (AWS keys, GitHub PATs,
  // private key blocks, postgres DSNs with inline password, JWTs). Designed
  // to fail loud on real leaks without nagging on placeholders or fixtures.
  // Off-switch via MAKESTUDIO_DISABLE_SECRETS_SCANNER=1 for legitimate
  // exception cases (encrypted secret stores, intentional fixtures).
  const secretFindings = scanSecrets(content);
  if (secretFindings.length > 0) {
    throw new Error(formatSecretsError(secretFindings, relToCwd(filePath, ctx.cwd)));
  }

  const before = exists ? readFileWithMetadata(filePath).text : '';
  // Inherit lineEnding/bom from the last Read if we have one. Otherwise
  // classify the BEFORE content. For brand-new files, default to LF + no BOM.
  let meta = ctx.readCache.get(filePath);
  if (exists && !meta) {
    const probed = readFileWithMetadata(filePath);
    meta = { mtime: 0, size: 0, lineEnding: probed.lineEnding, bom: probed.bom };
  }
  try { require('../../file-history').snapshotBeforeEdit(ctx.cwd, filePath); } catch (err) { swallow(err); }
  try { require('../../rewind').recordFileSnapshot(ctx, filePath); } catch (err) { swallow(err); }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write: tmp file in the same directory + rename. Crash mid-
  // write leaves either the OLD file (if rename hasn't happened) or
  // the NEW file (if rename completed) — never a half-written file.
  // Same dir is required so rename is atomic on POSIX (cross-fs rename
  // would copy+delete, defeating atomicity). Mirrors the pattern in
  // sessions.ts:rewriteSession. Suffix includes pid + random so two
  // concurrent Writes to the same file (rare) don't collide.
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, encodeWithMetadata(content, meta));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (err) { swallow(err); }
    throw err;
  }
  markRead(ctx, filePath);

  const rel = relToCwd(filePath, ctx.cwd);
  const action = exists ? 'Overwritten' : 'Created';
  const header = `${action} ${rel} (${content.length} chars, ${content.split('\n').length} lines).`;
  try {
    const { renderDiff } = require('../../diff-render');
    const diff = renderDiff(before, content, { filePath: rel, context: 3, maxLines: 120 });
    return `${header}\n${diff}`;
  } catch {
    return header;
  }
}

// Curly → straight quote map. Copy paste from editors (and some LLM
// prompt-injection hardening) turns real quotes into Unicode curly quotes;
// the file on disk typically still has straight ones. Normalising both
// sides during the match saves a lot of "old_string not found" failures.
// Port of Claude Code `src/tools/FileEditTool/utils.ts normalizeQuotes`.
