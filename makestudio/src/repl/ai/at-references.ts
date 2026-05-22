import { swallow } from '../../utils/log';
/**
 * at-references.ts
 *
 * Parses `@path` tokens out of user messages and resolves them to absolute
 * paths. The LLM is told (via buildAtReferenceHint) that these are file
 * pointers — it decides whether to Read them based on relevance.
 *
 * This is Option B (lazy) — the opposite of Claude Code's claudemd.ts
 * behaviour, which eagerly inlines @imports into the system prompt. Here
 * nothing is read up-front; the agent fetches on demand.
 *
 * Accepted forms (ported from claudemd.ts token-validation logic):
 *   @./relative/path
 *   @~/home/path
 *   @/absolute/path       (but not bare `@/`)
 *   @bare/path            (must contain `.` or `/` so @alice etc. are ignored)
 *
 * Fragment identifiers (`@docs/foo.md#section`) are stripped. Backslash-
 * escaped spaces (`@dir/\ with\ space/file.md`) are unescaped.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AtReference {
  /** The raw token as it appeared in the message, including the `@`. */
  raw: string;
  /** The path part without the `@`. */
  spec: string;
  /** Resolved absolute path. */
  absolute: string;
  /** Does the file/dir exist on disk right now. */
  exists: boolean;
  /** Size in bytes when exists && is a regular file. */
  sizeBytes?: number;
  /** True when the resolved target is a directory. */
  isDirectory?: boolean;
}

// (?:^|\s) — token must start at line start or after whitespace so email
// addresses (foo@bar.com) never match.
// ((?:[^\s\\]|\\ )+) — the path, allowing backslash-escaped spaces.
const AT_REGEX = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

function expandPath(spec: string, cwd: string): string {
  if (spec.startsWith('~/')) return path.join(os.homedir(), spec.slice(2));
  if (spec.startsWith('/')) return spec;
  if (spec.startsWith('./')) return path.resolve(cwd, spec.slice(2));
  return path.resolve(cwd, spec);
}

export function extractAtReferences(text: string, cwd: string): AtReference[] {
  if (!text || text.indexOf('@') < 0) return [];
  const refs: AtReference[] = [];
  const seen = new Set<string>();
  AT_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_REGEX.exec(text)) !== null) {
    let spec = m[1];
    if (!spec) continue;
    const hash = spec.indexOf('#');
    if (hash !== -1) spec = spec.substring(0, hash);
    if (!spec) continue;
    spec = spec.replace(/\\ /g, ' ');

    const isPath =
      spec.startsWith('./') ||
      spec.startsWith('~/') ||
      (spec.startsWith('/') && spec !== '/') ||
      (
        !spec.startsWith('@') &&
        !/^[#%^&*()]+/.test(spec) &&
        /^[a-zA-Z0-9._-]/.test(spec) &&
        // Bare path must look like a file/dir reference (avoids @alice etc.).
        (spec.includes('.') || spec.includes('/'))
      );
    if (!isPath) continue;

    const absolute = expandPath(spec, cwd);
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    let exists = false;
    let sizeBytes: number | undefined;
    let isDirectory = false;
    try {
      const s = fs.statSync(absolute);
      exists = true;
      isDirectory = s.isDirectory();
      if (s.isFile()) sizeBytes = s.size;
    } catch (err) { swallow(err); }

    refs.push({ raw: `@${m[1]}`, spec, absolute, exists, sizeBytes, isDirectory });
  }
  return refs;
}

/**
 * Build the hint block appended to the user message before it's sent to
 * the LLM. Returns '' when no references were found (no overhead).
 *
 * Wrapped in a clearly-delimited tag so the model can recognise the
 * system-generated resolution vs the user's own words.
 */
export function buildAtReferenceHint(text: string, cwd: string): string {
  const refs = extractAtReferences(text, cwd);
  if (refs.length === 0) return '';
  const lines = refs.map(r => {
    const kind = r.isDirectory ? 'directory' : 'file';
    const size = r.sizeBytes !== undefined ? `, ${r.sizeBytes} bytes` : '';
    const status = r.exists ? `exists · ${kind}${size}` : 'MISSING';
    return `  - ${r.raw} → ${r.absolute} (${status})`;
  });
  return [
    '',
    '<at_references>',
    'The message above contains @ references. Each is a POINTER to a file or directory — not inlined content.',
    'If the path is relevant to answering, use the Read (file) or Glob (directory) tool to fetch it. Do not guess at contents.',
    'Resolved paths:',
    ...lines,
    '</at_references>',
  ].join('\n');
}
