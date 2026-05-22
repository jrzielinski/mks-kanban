/**
 * diff-render.ts
 *
 * Colored unified diff rendering for file changes performed by the agent.
 * Emits ANSI strings with green additions / red removals and a subtle gutter.
 *
 * Used by Edit / Write / MultiEdit tool result summaries so the chat shows
 * a visual preview instead of just "Edited file.ts".
 */

import chalk from 'chalk';

const green = chalk.hex('#22C55E');
const red = chalk.hex('#EF4444');
const dim = chalk.hex('#64748B');
const gray = chalk.hex('#94A3B8');
const addBg = chalk.bgHex('#052e16').hex('#BBF7D0');
const delBg = chalk.bgHex('#450a0a').hex('#FECACA');

export interface DiffOptions {
  context?: number;        // lines of context around each hunk (default 3)
  maxLines?: number;       // cap total output lines (default 200)
  showHeader?: boolean;    // include file-path header (default true)
  filePath?: string;
}

interface HunkLine {
  type: '+' | '-' | ' ';
  oldNum?: number;
  newNum?: number;
  text: string;
}

/**
 * Produce a colored unified diff between two strings. Simple LCS-based
 * algorithm — fine for typical file-edit sizes (hundreds of lines).
 */
export function renderDiff(before: string, after: string, opts: DiffOptions = {}): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 200;
  const showHeader = opts.showHeader ?? true;

  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffLines(a, b);

  // Walk ops, grouping into hunks with N context lines around each change.
  const hunks: HunkLine[][] = [];
  let current: HunkLine[] = [];
  let aIdx = 0;
  let bIdx = 0;
  let runContext = 0;

  const pushHunk = () => {
    if (current.length > 0) hunks.push(current);
    current = [];
    runContext = 0;
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === ' ') {
      // context line
      aIdx++; bIdx++;
      const nextIsChange = (i + 1 < ops.length && ops[i + 1].type !== ' ');
      if (current.length > 0) {
        current.push({ type: ' ', oldNum: aIdx, newNum: bIdx, text: op.text });
        runContext++;
        if (runContext > 2 * context && !nextIsChange) {
          // Trim trailing context and close
          current = current.slice(0, current.length - (runContext - context));
          pushHunk();
        }
      } else if (nextIsChange || (i < ops.length - 1 && lookAheadHasChange(ops, i, context))) {
        // Start collecting leading context
        current.push({ type: ' ', oldNum: aIdx, newNum: bIdx, text: op.text });
        // Trim to last `context` lines
        if (current.length > context) current = current.slice(-context);
      }
    } else if (op.type === '-') {
      aIdx++;
      current.push({ type: '-', oldNum: aIdx, text: op.text });
      runContext = 0;
    } else {
      bIdx++;
      current.push({ type: '+', newNum: bIdx, text: op.text });
      runContext = 0;
    }
  }
  pushHunk();

  if (hunks.length === 0) return dim('  (no textual changes)');

  const out: string[] = [];
  if (showHeader && opts.filePath) {
    out.push(gray('──── ') + chalk.bold(opts.filePath) + gray(' ────'));
  }

  let added = 0, removed = 0;
  let linesEmitted = 0;
  hunksLoop: for (const hunk of hunks) {
    const firstOld = hunk.find(h => h.oldNum !== undefined)?.oldNum;
    const firstNew = hunk.find(h => h.newNum !== undefined)?.newNum;
    const oldCount = hunk.filter(h => h.type !== '+').length;
    const newCount = hunk.filter(h => h.type !== '-').length;
    out.push(dim(`@@ -${firstOld ?? 0},${oldCount} +${firstNew ?? 0},${newCount} @@`));
    linesEmitted++;
    for (const line of hunk) {
      const safe = line.text.replace(/\t/g, '  ');
      if (line.type === '+') {
        out.push(addBg(green('+') + ' ' + padVisibleRight(safe, 120)));
        added++;
      } else if (line.type === '-') {
        out.push(delBg(red('-') + ' ' + padVisibleRight(safe, 120)));
        removed++;
      } else {
        out.push(gray('  ') + dim(safe));
      }
      linesEmitted++;
      if (linesEmitted >= maxLines) {
        out.push(dim(`  … truncated (${totalChanges(ops) - (added + removed)} more changes)`));
        break hunksLoop;
      }
    }
  }

  out.push(dim(`  ${green('+' + added)} ${red('-' + removed)}`));
  return out.join('\n');
}

function padVisibleRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function totalChanges(ops: Array<{ type: string }>): number {
  return ops.filter(o => o.type === '+' || o.type === '-').length;
}

function lookAheadHasChange(ops: Array<{ type: string }>, fromIdx: number, n: number): boolean {
  const end = Math.min(ops.length, fromIdx + n + 1);
  for (let i = fromIdx + 1; i < end; i++) {
    if (ops[i].type !== ' ') return true;
  }
  return false;
}

// ── LCS-based line diff ────────────────────────────────────────────────────
// For typical file-edit sizes this is O(n*m) which is fine.

interface DiffOp { type: '+' | '-' | ' '; text: string; }

function diffLines(a: string[], b: string[]): DiffOp[] {
  // Very cheap fast-path: if identical, no ops
  if (a.length === b.length && a.every((l, i) => l === b[i])) {
    return a.map(l => ({ type: ' ' as const, text: l }));
  }

  // Myers-ish: build LCS table
  const n = a.length;
  const m = b.length;
  // Cap to avoid O(n*m) blow-up on very large files
  const CAP = 2000;
  if (n > CAP || m > CAP) {
    // Fallback: brute "everything removed, everything added"
    return [
      ...a.map(l => ({ type: '-' as const, text: l })),
      ...b.map(l => ({ type: '+' as const, text: l })),
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) lcs[i][j] = lcs[i - 1][j - 1] + 1;
      else lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: ' ', text: a[i - 1] });
      i--; j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.push({ type: '-', text: a[i - 1] });
      i--;
    } else {
      ops.push({ type: '+', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.push({ type: '-', text: a[i - 1] }); i--; }
  while (j > 0) { ops.push({ type: '+', text: b[j - 1] }); j--; }
  ops.reverse();
  return ops;
}
