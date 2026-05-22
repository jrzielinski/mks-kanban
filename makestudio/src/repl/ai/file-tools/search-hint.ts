import { swallow } from '../../../utils/log';
/**
 * search-hint.ts — actionable hints when Glob/Grep return zero results.
 *
 * The model's typical reaction to "No matches" is to retry the same
 * call with a tiny tweak (different casing, swapped extension, slightly
 * different path) — burning a tool call. By including a hint INLINE
 * in the empty-result tool_result, we give the model the information
 * it would have asked for next, in the same round-trip.
 *
 * Hints are heuristic, never speculative. They're appended to the
 * "No matches" string only when the heuristic finds something concrete
 * to point at. Empty hint → no extra text added.
 *
 * Examples:
 *   pattern="**\/Foo.ts"         → no matches → "but found 12 .js files in cwd; did you mean *.js?"
 *   pattern="*.tsx"              → no matches → "did you mean .ts? (45 .ts files in cwd, 0 .tsx)"
 *   pattern looks like a literal → "pattern has no wildcards — did you forget the leading **\/?"
 *   grep regex looks like literal → "pattern has no special chars — try a fixed string with literal: true"
 */

import * as fs from 'fs';
import * as path from 'path';

const MAX_DIR_SCAN = 1500; // hard cap so we don't walk huge trees
const HINT_MAX_LINES = 4;

/**
 * Cheap shallow scan: walk up to MAX_DIR_SCAN files under root,
 * counting extensions. Skips standard heavy directories.
 */
function sampleExtensions(root: string): { byExt: Map<string, number>; total: number } {
  const byExt = new Map<string, number>();
  let total = 0;
  const stack: string[] = [root];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache']);

  while (stack.length > 0 && total < MAX_DIR_SCAN) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (total >= MAX_DIR_SCAN) break;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        total++;
        const dot = e.name.lastIndexOf('.');
        const ext = dot > 0 ? e.name.slice(dot).toLowerCase() : '';
        if (ext) byExt.set(ext, (byExt.get(ext) || 0) + 1);
      }
    }
  }
  return { byExt, total };
}

function extractExtFromPattern(pattern: string): string | null {
  // Match patterns ending in *.ext
  const m = pattern.match(/\*\.([A-Za-z0-9]+)$/);
  if (m) return '.' + m[1].toLowerCase();
  // Patterns ending in /name.ext (no wildcard)
  const m2 = pattern.match(/\.([A-Za-z0-9]{1,6})$/);
  if (m2) return '.' + m2[1].toLowerCase();
  return null;
}

/**
 * Sister-extension suggestions — common LLM mistakes (`.tsx` → `.ts`,
 * `.jsx` → `.js`, `.mjs` → `.js`, etc.). Keyed by the LOOKED-FOR ext;
 * value is the list of ALTERNATIVE exts to check.
 */
const EXT_SISTERS: Record<string, string[]> = {
  '.tsx': ['.ts', '.jsx'],
  '.ts': ['.tsx', '.js'],
  '.jsx': ['.js', '.tsx'],
  '.js': ['.ts', '.mjs', '.cjs'],
  '.mjs': ['.js'],
  '.cjs': ['.js'],
  '.py': ['.pyi'],
  '.cpp': ['.cc', '.cxx', '.c'],
  '.c': ['.cpp', '.cc'],
  '.h': ['.hpp', '.hh'],
  '.yml': ['.yaml'],
  '.yaml': ['.yml'],
};

export function globHint(pattern: string, cwd: string): string {
  const hints: string[] = [];

  // 1) No wildcard at all → likely a literal path lookup that should
  // have been Read instead.
  if (!/[*?[]/.test(pattern)) {
    hints.push(`Hint: pattern has no wildcards — if you want to read a specific file, call Read directly. To search recursively, prefix with **/`);
  }

  // 2) Sister-extension check.
  const askedExt = extractExtFromPattern(pattern);
  if (askedExt) {
    const sample = sampleExtensions(cwd);
    const askedCount = sample.byExt.get(askedExt) || 0;
    if (askedCount === 0) {
      const sisters = EXT_SISTERS[askedExt] || [];
      const present = sisters
        .map((s) => ({ ext: s, n: sample.byExt.get(s) || 0 }))
        .filter((s) => s.n > 0)
        .sort((a, b) => b.n - a.n);
      if (present.length > 0) {
        const lead = present[0];
        hints.push(`Hint: 0 ${askedExt} files in cwd; did you mean ${lead.ext}? (${lead.n} match${lead.n === 1 ? '' : 'es'})`);
      } else if (sample.total > 0) {
        // Show top 3 extensions actually present
        const top = Array.from(sample.byExt.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([e, n]) => `${e} (${n})`)
          .join(', ');
        hints.push(`Hint: 0 ${askedExt} files in cwd. Common extensions here: ${top}.`);
      }
    }
  }

  // 3) Pattern with leading "/" relative to cwd — usually wrong.
  if (pattern.startsWith('/') && !pattern.startsWith('/**')) {
    hints.push(`Hint: leading "/" makes the glob absolute. To search from cwd, drop the slash; to search recursively use "**/" prefix.`);
  }

  return hints.slice(0, HINT_MAX_LINES).join('\n');
}

export function grepHint(pattern: string, searchPath: string, opts: { caseInsensitive?: boolean; multiline?: boolean }): string {
  const hints: string[] = [];

  // 1) Pattern is a plain identifier (no regex metacharacters): rg
  // treats it as regex anyway, so this is a hint about strategy not
  // syntax — but flagging it helps the model decide whether to
  // broaden with -i or with a glob narrowing. Suggest -i and
  // multiline only when those flags ARE NOT already enabled, so
  // the hint stays actionable.
  const hasRegex = /[.*+?^${}()|[\]\\]/.test(pattern);
  if (!hasRegex && !opts.caseInsensitive) {
    const parts = ['Hint: pattern is a plain string with no regex metacharacters.'];
    if (!opts.caseInsensitive) parts.push('If a case mismatch might be the issue, retry with -i:true.');
    if (!opts.multiline) parts.push('If the symbol could span lines, retry with multiline:true.');
    hints.push(parts.join(' '));
  }

  // 2) Mixed-case pattern often matches lowercase files only; suggest -i
  if (/[A-Z]/.test(pattern) && /[a-z]/.test(pattern) && !opts.caseInsensitive) {
    hints.push(`Hint: mixed-case pattern. Many codebases lower-case identifier prefixes — retry with -i:true if you're unsure of the casing.`);
  }

  // 3) Pattern looks like a multi-word string — likely a phrase that
  // won't match across line breaks unless multiline is on.
  if (/\s/.test(pattern) && !opts.multiline) {
    hints.push(`Hint: pattern contains whitespace. By default rg won't match across line breaks — retry with multiline:true if the phrase could span lines.`);
  }

  // 4) Path doesn't exist
  try {
    if (!fs.existsSync(searchPath)) {
      hints.push(`Hint: search path "${searchPath}" does not exist.`);
    }
  } catch (err) { swallow(err); }

  return hints.slice(0, HINT_MAX_LINES).join('\n');
}

export function readHint(filePath: string): string {
  // For Read: file not found → suggest a Glob with the basename.
  try {
    const base = path.basename(filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      return `Hint: parent directory does not exist: ${dir}. Use Glob with a higher-up path to locate the file.`;
    }
    return `Hint: file not found. Try Glob("**/${base}") to locate it, or list the parent directory with Glob("${dir}/*").`;
  } catch {
    return '';
  }
}
