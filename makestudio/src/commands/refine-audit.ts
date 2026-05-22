import { swallow } from '../utils/log';
/**
 * Refine pipeline — audit topic. Extracted from refine.ts.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import chalk from 'chalk';
import { getApiClient } from '../network/api-client';
import type { AuditReport, AuditBlocker } from './refine-types';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const cyan = chalk.hex('#22D3EE');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');
import { runLocalCLI, spinner } from './refine-prompts';
import { snapshotBoilerplate } from './refine-sync';

export async function auditDumsPackage(opts: {
  api: any;
  projectId: string;
  workspace: any;
  reqs: any[];
  cli: string;
  projectName: string;
  stack?: any;
  /** DUMs regenerated in a previous pass of this run — LLM must judge their CURRENT state */
  regeneratedThisRun?: Set<string>;
  /** DUMs created as corrective in a previous pass of this run */
  createdThisRun?: Set<string>;
}): Promise<AuditReport | null> {
  const { workspace, reqs, cli, projectName, stack, regeneratedThisRun, createdThisRun } = opts;

  if (!workspace?.repoPath) {
    console.log(`${dim('│')}  ${yellow('⚠')} Sem workspace local — auditoria pulada`);
    return null;
  }

  const dumsDir = path.join(workspace.repoPath, '.makestudio', 'dums');
  if (!fs.existsSync(dumsDir)) {
    console.log(`${dim('│')}  ${yellow('⚠')} Nenhum DUM encontrado em ${dumsDir}`);
    return null;
  }

  const diskFiles = fs.readdirSync(dumsDir).filter(f => /^dum_\d+\.json$/.test(f)).sort();
  if (diskFiles.length === 0) {
    console.log(`${dim('│')}  ${yellow('⚠')} Nenhum DUM para auditar`);
    return null;
  }

  // Build RICH DUM payload: real content (description snippet + task details).
  // LLM judges based on ACTUAL quality, not just metric counts.
  // For 100+ DUMs we need to stay within context budget, so we send a rich summary
  // per DUM rather than full content.
  const dumsRich: any[] = [];

  for (const file of diskFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(dumsDir, file), 'utf8'));
      const dumNumber = `DUM-${file.match(/^dum_(\d+)/)?.[1] || '???'}`;

      dumsRich.push({
        dumNumber,
        title: content.title,
        type: content.type,
        level: content.level,
        priority: content.priority,
        // First 800 chars of description — enough for LLM to judge if it's actionable
        descriptionSnippet: (content.description || '').substring(0, 800),
        descriptionLen: (content.description || '').length,
        // Full task info (title + first 150 chars of description + AC count)
        tasks: (content.tasks || []).map((t: any) => ({
          title: t.title,
          summary: (t.description || '').substring(0, 150),
          acCount: (t.acceptanceCriteria || []).length,
          hasTechContext: !!t.techContext,
          type: t.type,
          layer: t.layer,
        })),
        hasMermaid: !!content.mermaidDiagram,
        dependsOn: content.dependsOn || [],
        requirementIdsCount: (content.requirementIds || []).length,
      });
    } catch (err) { swallow(err); }
  }

  const boilerplateSnapshot = snapshotBoilerplate(workspace.repoPath);

  const reqsCompact = reqs.map((r: any, i: number) => ({
    idx: i + 1,
    id: r.id,
    title: (r.title || r.name || '').substring(0, 80),
    category: r.category || r.type || 'functional',
  }));

  // Pass-aware context: tell the LLM what was regenerated/created so it doesn't flip-flop
  const passContext = (regeneratedThisRun?.size || 0) > 0 || (createdThisRun?.size || 0) > 0
    ? `
## PASS-AWARE CONTEXT (critical — read before judging)
In a previous pass of THIS SAME AUDIT RUN, the following DUMs were modified:
${regeneratedThisRun && regeneratedThisRun.size > 0 ? `- REGENERATED (rewritten from stub): ${Array.from(regeneratedThisRun).sort().join(', ')}` : ''}
${createdThisRun && createdThisRun.size > 0 ? `- CREATED (new corrective DUMs): ${Array.from(createdThisRun).sort().join(', ')}` : ''}

CRITICAL RULE: You must evaluate these DUMs based on their CURRENT content (shown below),
not your memory of their prior state. A DUM that was a stub and is now rewritten is NOT weak
just because it used to be. Only flag it if the CURRENT content is genuinely deficient.

Your weak detection across passes must be STABLE: if you would not have flagged a given DUM
with its current content on pass 1, you cannot flag it on pass 2 either.
`
    : '';

  const auditPrompt = `You are a senior software architect doing a technical audit of a DUM package.
You judge DUM quality semantically — titles, descriptions, tasks, and architectural coherence.

⚠️ CODEBASE EXPLORATION IS FORBIDDEN
DO NOT use Glob, Read, Bash, Grep or ANY file tool. ALL context is in this prompt.
Exploring the filesystem wastes 10+ minutes and is a failed run.

⚠️ DO NOT WRITE FILES
Return JSON DIRECTLY in your response text. Do NOT use Write, Edit or any file creation tool.

⚠️ NO SUB-AGENTS
DO NOT use the Agent or Task tool. Perform this audit yourself in this single session.
Parallel sub-agents produce divergent judgments.

## PROJECT
Name: ${projectName}
Stack: ${JSON.stringify(stack || {})}
Total DUMs: ${dumsRich.length}
Total requirements: ${reqsCompact.length}

## BOILERPLATE STRUCTURE (complete view — do NOT explore further)
\`\`\`
${boilerplateSnapshot}
\`\`\`

## REQUIREMENTS
${JSON.stringify(reqsCompact, null, 2)}
${passContext}
## DUMS (rich — title, description snippet, full task list with AC counts)
${JSON.stringify(dumsRich, null, 2)}

## WEAK DUM RUBRIC (semantic, not metric)
A DUM is WEAK if it exhibits ANY of these qualitative defects:
1. **Placeholder content**: title contains "FILL_IN", "TODO", "...", or is generic ("Module X")
2. **Non-actionable description**: description does not explain what to build, where, and why
3. **Task soup**: tasks have no real content — just titles repeating the DUM name, or no AC
4. **Clear ownership conflict**: DUM's tasks clearly implement scope owned by another DUM
   (cite BOTH DUM numbers in the reason when flagging)
5. **Incoherent scope**: DUM mixes unrelated concerns (e.g., "Auth + Reports + Payments")
   that cannot be executed as one unit of work
6. **Missing critical sections**: a level-2 feature DUM without any tasks, or without any
   acceptance criteria across all tasks, or without techContext in any task

A DUM is NOT weak merely because:
- Its description is "short" (as long as it's actionable)
- It has "only" 2 or 3 tasks (if the scope genuinely fits in 2-3 tasks)
- It's a level-1 overview DUM (master DUMs are documentation, not executable)
- It's a contracts/infra DUM without requirement IDs (infra doesn't map to functional reqs)

## YOUR JUDGMENT (4 dimensions)
1. **Weak DUMs** — apply the rubric above to each DUM. For each weak DUM, cite EVIDENCE
   (specific task title, sentence from description, or ownership conflict with another DUM).
2. **Coverage** — does every critical flow have a DUM? list specific gaps with flow names.
3. **Integration** — are dependsOn coherent? is there a contracts DUM referenced by others?
4. **Blockers** — specific missing pieces that MUST be resolved before implementation.
   For each blocker, propose a suggested DUM (title, area, short description, type).

## OUTPUT FORMAT (STRICT JSON — no markdown, no code fences, no commentary)
{
  "score": 7.5,
  "verdict": "SIM|SIM_COM_RESSALVAS|NAO",
  "summary": "one paragraph overview",
  "inventory": "one paragraph with counts and distribution",
  "coverage": "one paragraph on functional coverage with specific gaps",
  "integration": "one paragraph on cross-DUM coherence",
  "weakDums": [
    { "dumNumber": "DUM-024", "reason": "Task 'Contratos Compartilhados' duplicates DUM-002 scope — empty tasks array" }
  ],
  "gaps": [
    { "area": "LGPD compliance", "description": "no DUM covers data export or consent" }
  ],
  "blockers": [
    {
      "id": "B1",
      "title": "Payment gateway choice not specified",
      "severity": "critical",
      "description": "DUM-011 assumes generic gateway",
      "suggestedDum": {
        "title": "Payment Gateway Integration (Stripe)",
        "description": "Integrate Stripe with webhook reconciliation",
        "type": "backend",
        "area": "payment"
      }
    }
  ],
  "recommendation": "2-3 sentence practical next step"
}

Return ONLY the JSON. Cite evidence for every weak DUM. Be consistent across passes.`;

  const stopSpin = spinner(`Auditando ${dumsRich.length} DUMs via ${cli.toUpperCase()}`);
  const llmOut = await runLocalCLI(cli, auditPrompt, workspace.repoPath, 8 * 60 * 1000);
  stopSpin();

  if (!llmOut) {
    console.log(`${dim('│')}  ${red('✗')} LLM não retornou output para auditoria`);
    return null;
  }

  try {
    const jsonMatch = llmOut.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON with "verdict" in LLM output');
    const parsed = JSON.parse(jsonMatch[0]) as AuditReport;
    // LLM is authoritative for weakDums — no override. Just ensure array shape.
    if (!Array.isArray(parsed.weakDums)) parsed.weakDums = [];
    return parsed;
  } catch (err: any) {
    console.log(`${dim('│')}  ${red('✗')} Falha ao parsear auditoria: ${err.message}`);
    return null;
  }
}

export function displayAuditReport(report: AuditReport): void {
  const scoreColor = report.score >= 8 ? green : report.score >= 6 ? yellow : red;
  const verdictLabel = {
    SIM: green('✓ SIM — executável sem ressalvas'),
    SIM_COM_RESSALVAS: yellow('⚠ SIM, com ressalvas'),
    NAO: red('✗ NÃO — precisa ajustes antes de implementar'),
  }[report.verdict] || dim(report.verdict);

  console.log(`${dim('│')}  ${cyan('Nota geral:')} ${scoreColor(`${report.score}/10`)}  ·  ${verdictLabel}`);
  console.log(dim('│'));
  console.log(`${dim('│')}  ${cyan('Resumo:')} ${dim(report.summary)}`);
  console.log(dim('│'));

  if (report.inventory) {
    console.log(`${dim('│')}  ${cyan('Inventário:')} ${dim(report.inventory)}`);
    console.log(dim('│'));
  }

  if (report.coverage) {
    console.log(`${dim('│')}  ${cyan('Cobertura:')} ${dim(report.coverage)}`);
    console.log(dim('│'));
  }

  if (report.integration) {
    console.log(`${dim('│')}  ${cyan('Integração:')} ${dim(report.integration)}`);
    console.log(dim('│'));
  }

  if (report.weakDums?.length) {
    console.log(`${dim('│')}  ${yellow('DUMs fracos/quebrados:')}`);
    for (const w of report.weakDums) {
      console.log(`${dim('│')}    ${yellow('⚠')} ${w.dumNumber}: ${dim(w.reason)}`);
    }
    console.log(dim('│'));
  }

  if (report.gaps?.length) {
    console.log(`${dim('│')}  ${yellow('Lacunas de escopo:')}`);
    for (const g of report.gaps) {
      console.log(`${dim('│')}    ${yellow('○')} ${g.area}: ${dim(g.description)}`);
    }
    console.log(dim('│'));
  }

  if (report.blockers?.length) {
    console.log(`${dim('│')}  ${red(`Bloqueios (${report.blockers.length}):`)}`);
    for (const b of report.blockers) {
      const sevColor = b.severity === 'critical' ? red : b.severity === 'high' ? yellow : dim;
      console.log(`${dim('│')}    ${sevColor('●')} ${cyan(b.id)} [${sevColor(b.severity)}] ${b.title}`);
      console.log(`${dim('│')}       ${dim(b.description)}`);
      if (b.suggestedDum) {
        console.log(`${dim('│')}       ${dim(`→ DUM sugerido: ${b.suggestedDum.title} (${b.suggestedDum.type})`)}`);
      }
    }
    console.log(dim('│'));
  }

  if (report.recommendation) {
    console.log(`${dim('│')}  ${cyan('Recomendação:')} ${report.recommendation}`);
  }
}
