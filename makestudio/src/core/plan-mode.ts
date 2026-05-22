import { swallow } from '../utils/log';
/**
 * plan-mode.ts
 *
 * Plan mode for DUMs.
 *
 * Before executing a DUM's tasks, optionally run a "plan phase" where the
 * local CLI is invoked in a read-mostly mode and asked to produce a plan
 * document at `.makestudio/plans/<dum-number>.md`. The user reviews and
 * approves (or edits) before implementation starts.
 *
 * Since we can't enforce tool-level permission gates on the external CLI,
 * we rely on (1) prompt discipline and (2) post-phase git reset of any
 * files outside the plans dir that the CLI touched.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as readline from 'readline';

function plansDir(projectPath: string): string {
  return path.join(projectPath, '.makestudio', 'plans');
}

export function planFilePath(projectPath: string, dumNumber: string): string {
  const slug = dumNumber.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(plansDir(projectPath), `${slug}.md`);
}

export function readPlan(projectPath: string, dumNumber: string): string | null {
  const f = planFilePath(projectPath, dumNumber);
  try {
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Prompt for the planning phase. Instructs the agent to only read/explore
 * and write a single plan file. Deliberately strict on scope.
 *
 */
export function buildPlanPrompt(
  dum: any,
  tasks: any[],
  projectName: string,
  planPath: string,
): string {
  const tasksList = (tasks || [])
    .map((t: any, i: number) => `  ${i + 1}. [${t.type || 'feature'}] ${t.title}`)
    .join('\n');

  return `You are in PLAN MODE for a single DUM of project "${projectName}".

# DUM ${dum.dumNumber}: ${dum.title}

${dum.description || '(no description)'}

## Pending tasks in this DUM
${tasksList || '  (no pending tasks)'}

## What you MUST do in plan mode

1. Thoroughly explore the codebase using Read/Glob/Grep tools to understand existing patterns, files, and conventions.
2. Read \`.makestudio/context/memory/\` files (especially the CONTRACTS DUM) if they exist.
3. Understand what each task of this DUM requires and how they connect.
4. Design an implementation approach for the whole DUM.
5. Write ONE file only: \`${planPath}\` (relative to cwd).

## What you MUST NOT do in plan mode

- Do NOT edit or create ANY file other than the plan file at \`${planPath}\`.
- Do NOT run build/test/lint commands.
- Do NOT commit.
- Do NOT start implementing the tasks.
- Do NOT ask the user questions — write the plan, note ambiguities inside it.

Any file touched outside \`${planPath}\` will be reverted by the orchestrator.

## Plan file structure (Markdown)

\`\`\`markdown
# Plano — ${dum.dumNumber}: ${dum.title}

## 1. Overview
Short paragraph: what this DUM accomplishes and why.

## 2. Files to create or modify
- \`path/to/file.ts\` — what changes and why
- ...

## 3. Approach per task
### Task 1 — <title>
- Step-by-step approach
- Key interfaces / functions involved
- Contract references (if using shared types from CONTRACTS DUM)

### Task 2 — <title>
...

## 4. Risks & open questions
- Things that could break / edge cases
- Ambiguities you'd want to clarify

## 5. Acceptance
- How we'll know the DUM is done
\`\`\`

Write the plan file now, then stop. Do not proceed to implementation.`;
}

/**
 * Revert any files modified/created during the plan phase EXCEPT the plan file itself.
 * Uses git to detect changes.
 */
export function revertNonPlanChanges(
  projectPath: string,
  planRelativePath: string,
  baseSha: string | undefined,
): { reverted: string[]; kept: string[] } {
  const reverted: string[] = [];
  const kept: string[] = [];
  if (!baseSha) return { reverted, kept };
  try {
    // Changed files (staged, unstaged, untracked) since baseSha
    const diffOut = execSync(`git diff --name-only ${baseSha}`, { cwd: projectPath }).toString();
    const untrackedOut = execSync('git ls-files --others --exclude-standard', { cwd: projectPath }).toString();
    const all = new Set(
      [...diffOut.split('\n'), ...untrackedOut.split('\n')]
        .map(s => s.trim())
        .filter(Boolean),
    );

    for (const f of all) {
      const norm = f.replace(/\\/g, '/');
      if (norm === planRelativePath || norm.startsWith(planRelativePath + '/')) {
        kept.push(f);
        continue;
      }
      // Revert tracked changes to HEAD; delete untracked
      try {
        const isTracked = (() => {
          try {
            execSync(`git cat-file -e ${baseSha}:${f}`, { cwd: projectPath, stdio: 'pipe' });
            return true;
          } catch { return false; }
        })();
        if (isTracked) {
          execSync(`git checkout ${baseSha} -- "${f}"`, { cwd: projectPath, stdio: 'pipe' });
        } else {
          const abs = path.join(projectPath, f);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        }
        reverted.push(f);
      } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }
  return { reverted, kept };
}

/**
 * Ensure the plans directory and an empty plan file exist so the CLI
 * can write to a known location.
 */
export function ensurePlanFile(projectPath: string, dumNumber: string): string {
  const f = planFilePath(projectPath, dumNumber);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');
  return f;
}

/**
 * Ask user to approve/edit/skip the plan.
 * Returns: 'approve' | 'edit' | 'skip'
 */
export async function promptPlanApproval(): Promise<'approve' | 'edit' | 'skip'> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(res => rl.question(q, (a) => res(a)));
  try {
    const a = (await ask('  Aprovar plano? [S=aprovar · E=editar · N=pular]: ')).trim().toLowerCase();
    if (a.startsWith('n')) return 'skip';
    if (a.startsWith('e')) return 'edit';
    return 'approve';
  } finally {
    rl.close();
  }
}

export function openInEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  try {
    execSync(`${editor} "${filePath}"`, { stdio: 'inherit' });
  } catch (err) { swallow(err); }
}
