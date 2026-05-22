/**
 * dnd-path-rewrite.ts — detect drag-and-dropped file paths in the
 * terminal and rewrite them as @-refs so the agent's at-references
 * resolver picks them up automatically.
 *
 * Most terminals (Terminal.app, iTerm2, GNOME Terminal, Konsole)
 * insert the file path as plain text when a file is dropped onto the
 * window. Paths with spaces are typically wrapped in single quotes.
 *
 * Heuristic for "looks like a dropped path":
 *   - input is a SINGLE token (no whitespace separator outside of an
 *     enclosing quote pair)
 *   - starts with "/", "./", "../", "~/", or is a Windows drive
 *     ("C:\..." / "C:/...")
 *   - resolves to an existing file or directory on disk
 *
 * If those conditions hold AND the path doesn't already start with
 * "@", we prepend "@" so at-references picks it up. Otherwise the
 * input is returned unchanged — paste of arbitrary text never gets
 * mangled because it always fails one of the gates.
 *
 * Toggle via settings.dndAutoAtRef. Default false (the heuristic is
 * conservative but path-like paste is still occasionally what the
 * user wants verbatim).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadSettings } from '../settings';

const PATH_PREFIX = /^(?:\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/;

/**
 * Strip a single layer of matched single OR double quotes. macOS
 * Terminal wraps paths-with-spaces in single quotes; some shells use
 * double. Returns { value, wasQuoted } so the caller can decide
 * whether to allow whitespace inside (quoted = yes, unquoted = no).
 */
function unwrapQuotes(s: string): { value: string; wasQuoted: boolean } {
  if (s.length < 2) return { value: s, wasQuoted: false };
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return { value: s.slice(1, -1), wasQuoted: true };
  }
  return { value: s, wasQuoted: false };
}

let cachedEnabled: boolean | null = null;

export function isDndRewriteEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  // Env override
  const env = (process.env.MAKESTUDIO_DND_AT_REF || '').toLowerCase().trim();
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  try {
    const s = loadSettings() as any;
    cachedEnabled = !!s?.dndAutoAtRef;
    return cachedEnabled;
  } catch { cachedEnabled = false; return false; }
}

export function resetDndRewriteCache(): void { cachedEnabled = null; }

/**
 * Try to interpret `input` as a dropped file path. Returns the @-ref
 * form if the heuristic matches, or `null` if input isn't a path
 * (caller should keep the raw input).
 */
export function maybeRewriteDroppedPath(input: string): string | null {
  if (!input || typeof input !== 'string') return null;

  const { value: stripped, wasQuoted } = unwrapQuotes(input.trim());
  if (!stripped) return null;

  // Already an @-ref — leave alone.
  if (stripped.startsWith('@')) return null;

  // Must be a single non-whitespace token UNLESS the input was
  // explicitly quoted (terminal wraps paths-with-spaces in quotes
  // when drag-dropped). Quoted whitespace = part of the path; raw
  // whitespace = multi-token paste, not a drop.
  if (!wasQuoted && /\s/.test(stripped)) return null;

  // Must look like a path, not a URL or a shell command.
  if (!PATH_PREFIX.test(stripped)) return null;

  // Resolve ~/ to homedir for the existence check.
  let resolved = stripped;
  if (stripped.startsWith('~/')) {
    resolved = path.join(os.homedir(), stripped.slice(2));
  }

  try {
    if (!fs.existsSync(resolved)) return null;
  } catch { return null; }

  return '@' + stripped;
}
