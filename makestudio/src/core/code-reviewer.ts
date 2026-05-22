import { swallow } from '../utils/log';
/**
 * code-reviewer.ts
 *
 * Post-DUM code review.
 *
 * After all tasks of a DUM complete + validators pass, spawn the local CLI
 * in a fresh session as a reviewer. The reviewer reads the DUM spec, task
 * descriptions, and git diff since the DUM started, then produces a
 * markdown report: PASS/FAIL + findings grouped by severity.
 *
 * If HIGH/CRITICAL findings exist, the orchestrator triggers an auto-fix
 * loop (bounded). The full report is saved as an AUDIT artifact.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  file?: string;
  line?: number;
  description: string;
  recommendation: string;
  confidence: number; // 1-10
}

export interface ReviewReport {
  verdict: 'PASS' | 'FAIL';
  summary: string;
  findings: ReviewFinding[];
  rawMarkdown: string;
}

function reviewFilePath(projectPath: string, dumNumber: string): string {
  const slug = dumNumber.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(projectPath, '.makestudio', 'reviews', `${slug}.md`);
}

export function ensureReviewFile(projectPath: string, dumNumber: string): string {
  const f = reviewFilePath(projectPath, dumNumber);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');
  return f;
}

/**
 * Build the reviewer prompt.
 * Structure:
 *  - Git diff + status injected inline
 *  - Explicit objective (DUM compliance, not security)
 *  - Critical instructions (minimize noise)
 *  - Categories to examine
 *  - Strict output format
 *  - Confidence scoring
 *  - False positive filtering
 *  - 3-step methodology
 */
export function buildReviewPrompt(
  dum: any,
  tasks: any[],
  cwd: string,
  baseSha: string | undefined,
  reviewPath: string,
): string {
  const reviewRel = path.relative(cwd, reviewPath).replace(/\\/g, '/');
  const diffHeadRef = baseSha || 'HEAD~1';

  let gitDiff = '';
  let filesChanged = '';
  try {
    filesChanged = execSync(`git diff --name-only ${diffHeadRef}`, { cwd, timeout: 10_000 }).toString();
  } catch (err) { swallow(err); }
  try {
    gitDiff = execSync(`git diff ${diffHeadRef}`, { cwd, timeout: 20_000, maxBuffer: 10 * 1024 * 1024 }).toString();
    // Cap very large diffs so we don't blow CLI context
    if (gitDiff.length > 80_000) {
      gitDiff = gitDiff.slice(0, 80_000) + '\n\n[... truncated, diff too large ...]';
    }
  } catch (err) { swallow(err); }

  const tasksBlock = (tasks || []).map((t: any, i: number) => {
    const ac = Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length
      ? '\n     Acceptance:\n' + t.acceptanceCriteria.map((c: string) => `       - ${c}`).join('\n')
      : '';
    return `  ${i + 1}. [${t.type || 'feature'}] ${t.title}${ac}`;
  }).join('\n');

  return `You are a senior engineer conducting a focused code review of the implementation of a single DUM.

# DUM ${dum.dumNumber}: ${dum.title}

${dum.description || '(no description)'}

## Tasks claimed as completed in this DUM
${tasksBlock || '  (no tasks listed)'}

## Files changed since DUM start
\`\`\`
${filesChanged || '(no files changed)'}
\`\`\`

## Full diff
\`\`\`diff
${gitDiff || '(empty diff)'}
\`\`\`

## Objective

Verify that the diff above IMPLEMENTS THE DUM. This is a DUM compliance review — not a generic style pass. Focus on:

1. **Spec compliance** — does the code fulfil the DUM description and each task's acceptance criteria? Any task silently skipped?
2. **Integrity** — are there placeholders, TODOs, stubbed functions, or mock data left in production code?
3. **Contract usage** — if the DUM references shared contracts (interfaces, DTOs, event names), are they used exactly, or were new names invented?
4. **Obvious correctness bugs** — null derefs, wrong conditionals, missed await, infinite loops, unused branches that bypass the happy path.
5. **Existing patterns** — does the code follow the surrounding codebase's conventions (naming, file layout, error handling)?

## Critical instructions

- **ZERO FALSE POSITIVES**: only report issues where you are ≥80% confident (on a 0-100 scale). If below 80, OMIT the finding entirely.
- **PRE-FILTER BY CHANGE SIZE**: skip files with < 3 lines changed — they are formatting fixes, imports, or trivial renames.
- **AVOID NOISE**: skip style nits, alternative-design opinions, or hypothetical edge cases that the spec does not require.
- **FOCUS ON THE DIFF**: do not report pre-existing issues outside the changed files.
- **NO STYLE BIKESHED**: no "I would name this differently", no "could be more DRY".
- **NO CONFIDENCE BELOW 80**: any finding with confidence < 80 is OMITTED. Only impactful, verified findings are reported.

## Methodology (follow in order)

**Phase 0 — Pre-filter:** skip any file with ≤ 2 lines changed. These are not review-worthy.

**Phase 1 — Understand the spec:** re-read the DUM description and every task's acceptance criteria. Build a mental checklist of what must exist in the diff.

**Phase 2 — Walk the diff file by file:** for each substantive change (> 2 lines), determine what it is supposed to do according to the spec. Flag missing pieces.

**Phase 3 — Sanity check:** scan for leftover TODO/FIXME/placeholder/mock/stub markers, hardcoded test values, unimplemented method bodies.

**Phase 4 — Write the report** to \`${reviewRel}\`.

## Output file

Write your report to: \`${reviewRel}\`

## Required markdown structure

\`\`\`markdown
# Code Review — ${dum.dumNumber}

## Verdict: PASS | FAIL

One-line summary of the result.

## Summary
2-4 sentences: what the DUM set out to do and whether the diff actually delivers it.

## Findings

### 1. <short title>
- **Severity**: critical | high | medium | low
- **Category**: spec_missing | placeholder_left | contract_mismatch | correctness_bug | pattern_divergence | other
- **File**: path/to/file.ts:line
- **Description**: what's wrong and why it matters for the DUM.
- **Recommendation**: concrete fix.
- **Confidence (0-100)**: 80-100

### 2. <next finding>
...

## Checklist
- [x] Task 1 acceptance criterion 1 met
- [ ] Task 2 acceptance criterion 2 NOT met — see finding #3
- ...
\`\`\`

## Severity guide
- **critical**: DUM is fundamentally unimplemented (task silently skipped, feature doesn't run)
- **high**: feature implemented but has a concrete bug that will break under realistic use
- **medium**: partial compliance with spec — a required behaviour missing
- **low**: minor deviation that a reviewer would raise but not block on

## Confidence scoring (0-100)
- 95-100: certain; the code literally does/doesn't contain the thing
- 85-94: strong pattern evidence
- 80-84: plausible — include only if severity is critical/high
- < 80: OMIT — do not report

## Verdict rule
Verdict is **FAIL** if there is any finding of severity \`critical\` or \`high\` with confidence ≥7. Otherwise **PASS**.

## Do not do
- Do NOT run build, test, or lint commands.
- Do NOT edit source code — your job is just the review.
- Do NOT write anything outside \`${reviewRel}\`.
- Do NOT report issues in files that were not part of the diff.

Write the review now.`;
}

/**
 * Parse a review markdown into structured findings + verdict.
 * Deliberately tolerant — LLM output varies.
 */
export function parseReviewMarkdown(md: string): ReviewReport {
  const verdictMatch = md.match(/##\s*Verdict[:\s]*(PASS|FAIL)/i);
  const verdict: 'PASS' | 'FAIL' = (verdictMatch?.[1] || 'PASS').toUpperCase() as any;

  const summaryMatch = md.match(/##\s*Summary\s*\n+([\s\S]*?)(?=\n##\s)/);
  const summary = (summaryMatch?.[1] || '').trim();

  const findings: ReviewFinding[] = [];
  const findingBlocks = md.split(/\n###\s+\d+\.\s+/).slice(1);
  for (const block of findingBlocks) {
    const sev = block.match(/Severity\*\*?:\s*`?(critical|high|medium|low)/i)?.[1]?.toLowerCase();
    const cat = block.match(/Category\*\*?:\s*`?([a-z_]+)/i)?.[1] || 'other';
    const fileLine = block.match(/File\*\*?:\s*`?([^`\n]+?)`?\s*\n/);
    const conf = parseInt(block.match(/Confidence\*\*?:\s*(\d+)/i)?.[1] || '7', 10);
    const desc = block.match(/Description\*\*?:\s*([\s\S]*?)(?=\n-\s*\*\*|$)/)?.[1]?.trim() || '';
    const rec = block.match(/Recommendation\*\*?:\s*([\s\S]*?)(?=\n-\s*\*\*|$)/)?.[1]?.trim() || '';

    if (!sev) continue;
    let file: string | undefined;
    let line: number | undefined;
    if (fileLine) {
      const m = fileLine[1].trim().match(/^(.+?)(?::(\d+))?$/);
      if (m) {
        file = m[1];
        if (m[2]) line = parseInt(m[2], 10);
      }
    }
    findings.push({
      severity: sev as any,
      category: cat,
      file,
      line,
      description: desc,
      recommendation: rec,
      confidence: Math.min(10, Math.max(1, conf || 0)),
    });
  }

  return { verdict, summary, findings, rawMarkdown: md };
}

export function readReview(projectPath: string, dumNumber: string): ReviewReport | null {
  const f = reviewFilePath(projectPath, dumNumber);
  if (!fs.existsSync(f)) return null;
  const md = fs.readFileSync(f, 'utf8');
  if (!md.trim()) return null;
  return parseReviewMarkdown(md);
}

export function hasBlockingFindings(report: ReviewReport): boolean {
  return report.findings.some(f =>
    (f.severity === 'critical' || f.severity === 'high') && f.confidence >= 7,
  );
}

/**
 * Build a targeted fix prompt from blocking findings, to be fed back into
 * the CLI for an auto-fix pass.
 */
export function buildFixPrompt(dum: any, report: ReviewReport): string {
  const blocking = report.findings.filter(f =>
    (f.severity === 'critical' || f.severity === 'high') && f.confidence >= 7,
  );
  const list = blocking.map((f, i) =>
    `### Issue ${i + 1} — [${f.severity.toUpperCase()}] ${f.category}
File: ${f.file || '(n/a)'}${f.line ? ':' + f.line : ''}
Problem: ${f.description}
Fix: ${f.recommendation}`,
  ).join('\n\n');

  return `The post-DUM code review found blocking issues in your implementation of ${dum.dumNumber}.

You MUST fix every issue below. Do not ignore any. Do not change unrelated code.
Do not revert the review file — it is the audit trail.
After fixing, commit with: git add -A && git commit -m "fix: [${dum.dumNumber}] address code review findings"

${list}

Each fix must address exactly what the review points out. If a fix requires
introducing a helper, keep it in the appropriate existing file, do not create
parallel abstractions.`;
}
