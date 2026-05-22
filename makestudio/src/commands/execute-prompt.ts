import { swallow } from '../utils/log';
/**
 * `execute` command — prompt module. Extracted from execute.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const cyan = chalk.hex('#22D3EE');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');

export function buildTaskPrompt(
  dum: any,
  task: any,
  _unused: string,
  _unusedFiles: string[],
  projectName: string,
): string {
  const acLines = (task.acceptanceCriteria || []).map((ac: string) => `- ${ac}`).join('\n');
  const depRefs = (dum.dependsOn || [])
    .map((d: string) => {
      const m = d.match(/\d+/);
      return m ? `.makestudio/dums/dum_${m[0].padStart(3, '0')}.json` : null;
    })
    .filter(Boolean);
  const depRefsBlock = depRefs.length > 0
    ? `\n## Dependencies (MUST read before acting)\n${depRefs.map((f: string) => `- ${f}`).join('\n')}\n`
    : '';

  // Reminder pointing to the rules file — the CLI has already loaded it.
  const RULES_REMINDER = `The project rules are loaded from CLAUDE.md / AGENTS.md / GEMINI.md.
Follow them strictly. Key rules: boilerplate-style inspection, FVM for Flutter,
SWC for TS checks, one class per file, no parallel sub-agents.`;

  // AUDIT/CONSOLIDATION DUMs get a slim audit-specific prompt
  if (dum.type === 'audit' || dum.metadata?.mode === 'consolidation') {
    return `You are AUDITING and CONSOLIDATING existing work in ${dum.dumNumber}: ${dum.title}.
Working directory: the current directory IS the project root.

${RULES_REMINDER}

⚠️ AUDIT TASK — NOT A CREATION TASK
- DO NOT create new modules/contracts/DTOs/files
- READ existing files, IDENTIFY duplicates, EDIT/MERGE/DELETE
- If you need to create a file, STOP and emit a CONTRACT_GAP artifact

## Audit goal
${dum.description || ''}
${depRefsBlock}

## Task: ${task.title}
${task.description || ''}

## Acceptance Criteria
${acLines || '(none specified)'}

## Technical Context
${task.techContext || task.metadata?.techContext || ''}

## What to do
1. Read \`.makestudio/execution-state.json\` to see what files exist
2. For each file referenced in the audit, read it before editing
3. Delete duplicates. Merge overlapping definitions. Preserve the BEST version.
4. Commit: \`git add -A && git commit -m "refactor: [${dum.dumNumber}] ${task.title}"\`
`;
  }

  // Visual references — inject for visual/frontend/mobile DUMs
  const isVisualDum = ['visual', 'frontend'].includes(dum.type) ||
    (task.layer && ['frontend', 'mobile'].includes(task.layer)) ||
    /\b(tela|screen|page|widget|component|ui|layout|dashboard)\b/i.test(task.title || '');
  const visualHint = isVisualDum
    ? `\n⚠️ UI task — read \`.makestudio/context/visual-references.md\` BEFORE designing. Match the reference style.\n`
    : '';

  const dumFile = `.makestudio/dums/dum_${(dum.dumNumber || '').replace(/\D/g, '').padStart(3, '0')}.json`;

  // Normal implementation DUM — slim, rules live in CLAUDE.md/AGENTS.md/GEMINI.md
  return `You are implementing ONE task of ${dum.dumNumber}: ${dum.title}.
Working directory: the current directory IS the project root.

${RULES_REMINDER}
${visualHint}
## DUM context
${dum.description || ''}
${depRefsBlock}

## Full DUM spec
Read \`${dumFile}\` for the complete specification of this DUM.

## Task: ${task.title}
Type: ${task.type || 'feature'}

${task.description || ''}

## Acceptance Criteria
${acLines || '(none specified)'}

## Technical Context
${task.techContext || task.metadata?.techContext || ''}

## What to do
1. Follow the MANDATORY INSPECTION PROTOCOL from CLAUDE.md (read 2+ existing similar files, extract patterns, match exactly).
2. Implement ONLY this task — do not touch unrelated files.
3. Run compilation check (\`npx swc <file> -d /tmp/check\` or \`fvm dart analyze <path>\`).
4. Commit: \`git add -A && git commit -m "feat: [${dum.dumNumber}] ${task.title}"\`
`;
}

export async function buildContractsContext(
  dums: any[],
  cwd: string,
): Promise<string> {
  const contractsDum = dums.find(d => d.type === 'contracts');
  if (!contractsDum) return '';

  // Try to read from disk first (complete, no truncation)
  const memoryDir = path.join(cwd, '.makestudio', 'context', 'memory');
  if (fs.existsSync(memoryDir)) {
    const files = fs.readdirSync(memoryDir);
    const contractsFile = files.find(f =>
      f.toLowerCase().startsWith('dum_002') || f.toLowerCase().includes('contracts'),
    );
    if (contractsFile) {
      try {
        const content = fs.readFileSync(path.join(memoryDir, contractsFile), 'utf8');
        const parsed = JSON.parse(content);
        const tasks = (parsed.tasks || []).map((t: any) => `- ${t.title}: ${(t.description || '').slice(0, 300)}`).join('\n');
        return `### ${contractsDum.dumNumber}: ${contractsDum.title}\n\n${(contractsDum.description || '').slice(0, 600)}\n\n**Tasks:**\n${tasks}`;
      } catch (err) { swallow(err); }
    }
  }

  // Fallback: inline from memory
  const tasks = (contractsDum.tasks || [])
    .map((t: any) => `- ${t.title}: ${(t.description || '').slice(0, 200)}`)
    .join('\n');
  return `### ${contractsDum.dumNumber}: ${contractsDum.title}\n\n${(contractsDum.description || '').slice(0, 500)}\n\n**Tasks:**\n${tasks}`;
}
