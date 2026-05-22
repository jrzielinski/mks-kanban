import { swallow } from '../utils/log';
/**
 * Refine pipeline — fix topic. Extracted from refine.ts.
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

export async function generateCorrectiveDums(opts: {
  api: any;
  projectId: string;
  workspace: any;
  blockers: AuditBlocker[];
  reqs: any[];
  cli: string;
  projectName: string;
  stack?: any;
}): Promise<{ created: number; createdNumbers: Set<string> }> {
  const { api, projectId, workspace, blockers, reqs, cli, projectName, stack } = opts;

  if (!workspace?.repoPath || blockers.length === 0) return { created: 0, createdNumbers: new Set() };

  const dumsDir = path.join(workspace.repoPath, '.makestudio', 'dums');
  fs.mkdirSync(dumsDir, { recursive: true });

  // Determine next DUM number from disk
  const existingNumbers = fs.readdirSync(dumsDir)
    .map(f => f.match(/^dum_(\d+)\.json$/)?.[1])
    .filter(Boolean)
    .map(n => parseInt(n!, 10));
  let nextNum = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 2;

  // Build ONE batch prompt for all blockers
  const blockerSeeds = blockers.map(b => ({
    id: b.id,
    title: b.suggestedDum?.title || b.title,
    description: b.suggestedDum?.description || b.description,
    type: b.suggestedDum?.type || 'backend',
    area: b.suggestedDum?.area || 'general',
    severity: b.severity,
  }));

  const reqsCompact = reqs.map((r: any) => ({
    id: r.id,
    title: (r.title || r.name || '').substring(0, 80),
  }));

  const boilerplateSnapshot = snapshotBoilerplate(workspace.repoPath);

  const fixPrompt = `You are generating corrective DUMs to fill gaps identified by a technical audit.

⚠️ CODEBASE EXPLORATION IS FORBIDDEN
DO NOT use Glob, Read, Bash, Grep or ANY file tool. The boilerplate structure below is COMPLETE.
Exploring the filesystem wastes 10+ minutes. Use ONLY the context in this prompt.

⚠️ DO NOT WRITE FILES
Return JSON DIRECTLY in your response text. Do NOT use Write, Edit or any file creation tool.
Your entire answer must be a JSON object parsable from your text response.

⚠️ NO SUB-AGENTS
DO NOT use the Agent or Task tool. Generate all corrective DUMs yourself in one response.
Parallel sub-agents produce divergent DUM structures.

## PROJECT
Name: ${projectName}
Stack: ${JSON.stringify(stack || {})}

## BOILERPLATE STRUCTURE (complete view — do NOT explore further)
\`\`\`
${boilerplateSnapshot}
\`\`\`

## REQUIREMENTS (to map relevant ones to new DUMs)
${JSON.stringify(reqsCompact, null, 2)}

## BLOCKERS TO FIX (one DUM per blocker)
${JSON.stringify(blockerSeeds, null, 2)}

## YOUR TASK
For each blocker, generate ONE complete DUM. Each DUM must have:
- Long description (≥1500 chars) with sections: "## O que já existe", "## O que este DUM adiciona", "## Arquivos a criar/modificar", "## Regras de Negócio", "## Escopo (fora deste DUM)", "## Resultado esperado"
- 3-6 tasks, each with:
  - title (action verb + specific target)
  - description (≥500 chars with code examples where appropriate)
  - acceptanceCriteria (3-6 items in GIVEN/WHEN/THEN format)
  - techContext (specific file paths, not generic)
  - type (feature|test|infra|database|architecture)
  - layer (backend|frontend|mobile|infra)
  - complexity (low|medium|high)
- mermaidDiagram (valid Mermaid flowchart describing the main flow)
- requirementIds (UUIDs from the requirements list — only those this DUM actually implements)
- type (backend|visual|flow|integration|contracts|mixed)
- priority ("critical" for severity=critical, "high" for high, "medium" otherwise)

## OUTPUT FORMAT (STRICT JSON — no markdown, no commentary)
{
  "dums": [
    {
      "blockerId": "B1",
      "title": "...",
      "description": "...",
      "type": "backend",
      "priority": "critical",
      "level": 2,
      "tasks": [
        {
          "title": "...",
          "description": "...",
          "acceptanceCriteria": ["..."],
          "techContext": "...",
          "type": "feature",
          "layer": "backend",
          "complexity": "medium"
        }
      ],
      "mermaidDiagram": "flowchart TD\\n  ...",
      "dependsOn": [],
      "requirementIds": []
    }
  ]
}

Return ONLY the JSON. Every DUM must be implementable without guesswork.`;

  console.log(dim('│'));
  const stopSpin = spinner(`Gerando ${blockers.length} DUMs corretivos via ${cli.toUpperCase()}`);
  const llmOut = await runLocalCLI(cli, fixPrompt, workspace.repoPath, 10 * 60 * 1000);
  stopSpin();

  if (!llmOut) {
    console.log(`${dim('│')}  ${red('✗')} LLM não retornou DUMs corretivos`);
    return { created: 0, createdNumbers: new Set() };
  }

  let generated: any[] = [];
  try {
    const jsonMatch = llmOut.match(/\{[\s\S]*"dums"[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON with "dums" in LLM output');
    const parsed = JSON.parse(jsonMatch[0]);
    generated = parsed.dums || [];
  } catch (err: any) {
    console.log(`${dim('│')}  ${red('✗')} Falha ao parsear DUMs corretivos: ${err.message}`);
    return { created: 0, createdNumbers: new Set() };
  }

  // Save each corrective DUM to disk + backend
  const validReqIds = new Set(reqs.map((r: any) => r.id));
  const createdNumbers = new Set<string>();
  let created = 0;

  for (const dum of generated) {
    const dumNum = String(nextNum).padStart(3, '0');
    const tempId = `dum_${dumNum}`;
    const filename = `${tempId}.json`;
    const filePath = path.join(dumsDir, filename);

    // Filter hallucinated requirement IDs
    const cleanReqIds = (dum.requirementIds || []).filter((id: string) => validReqIds.has(id));

    // Detect consolidation/audit DUMs by title/description keywords.
    // These DUMs should NOT create new files — they audit, merge, deduplicate existing work.
    // The executor uses a completely different prompt for type='audit'.
    const combinedText = `${dum.title || ''} ${dum.description || ''}`.toLowerCase();
    const isAudit = /\bconsolida|\bmerge\b|\bdedup|\baudit|\brefator|\bunific|\bresolver.*conflict|\bownership.*conflict|remover\s+duplic/i.test(combinedText);
    const resolvedType = isAudit ? 'audit' : (dum.type || 'backend');

    const fullDum: any = {
      tempId,
      title: dum.title,
      description: dum.description || '',
      type: resolvedType,
      level: dum.level || 2,
      priority: dum.priority || 'high',
      tasks: dum.tasks || [],
      mermaidDiagram: dum.mermaidDiagram || '',
      dependsOn: dum.dependsOn || [],
      requirementIds: cleanReqIds,
    };

    if (isAudit) {
      fullDum.metadata = { ...(fullDum.metadata || {}), mode: 'consolidation' };
    }

    // VALIDATION: reject if LLM produced weak output (would just get flagged again)
    const descLen = (fullDum.description || '').length;
    const taskCount = (fullDum.tasks || []).length;
    const hasAnyAc = fullDum.tasks.some((t: any) => (t.acceptanceCriteria || []).length > 0);
    if (descLen < 800 || taskCount < 3 || !hasAnyAc) {
      console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`DUM-${dumNum} (${dum.title?.substring(0, 40)}): LLM produziu output fraco — descartado (${descLen} chars, ${taskCount} tasks, AC: ${hasAnyAc})`)}`);
      continue;
    }

    try {
      // Write to disk
      fs.writeFileSync(filePath, JSON.stringify(fullDum, null, 2), 'utf8');

      // Post to backend
      await api.post(
        `/dark-factory/projects/${projectId}/save-decomposition`,
        { dums: [fullDum], requirementIds: cleanReqIds },
        { timeout: 30_000 },
      );

      const dumNumber = `DUM-${dumNum}`;
      createdNumbers.add(dumNumber);
      created++;
      console.log(`${dim('│')}    ${green('✓')} ${dim(`${dumNumber}: ${(dum.title || '').substring(0, 55)}`)}`);
      nextNum++;
    } catch (err: any) {
      console.log(`${dim('│')}    ${red('✗')} ${dim(`DUM-${dumNum}: ${err.response?.data?.message || err.message}`)}`);
    }
  }

  console.log(`${dim('│')}  ${green('✓')} ${dim(`${created}/${generated.length} DUMs corretivos gerados (disco + backend)`)}`);
  return { created, createdNumbers };
}

export async function regenerateWeakDums(opts: {
  api: any;
  projectId: string;
  workspace: any;
  weakDums: Array<{ dumNumber: string; reason: string }>;
  reqs: any[];
  cli: string;
  projectName: string;
  stack?: any;
}): Promise<{ fixed: number; regeneratedNumbers: Set<string> }> {
  const { api, projectId, workspace, weakDums, reqs, cli, projectName, stack } = opts;

  if (!workspace?.repoPath || weakDums.length === 0) return { fixed: 0, regeneratedNumbers: new Set() };

  const dumsDir = path.join(workspace.repoPath, '.makestudio', 'dums');
  const memoryDir = path.join(workspace.repoPath, '.makestudio', 'context', 'memory');

  // Load each weak DUM + its neighbors (by dependsOn) for context
  const loadDum = (dumNumber: string): any | null => {
    const num = dumNumber.replace(/^DUM-/i, '');
    const file = path.join(dumsDir, `dum_${num.padStart(3, '0')}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };

  // Preserve the audit's reason per DUM — the LLM must know WHAT to fix
  const weakByNumber = new Map<string, string>();
  for (const w of weakDums) weakByNumber.set(w.dumNumber.toUpperCase(), w.reason);

  const stubs: Array<{ dumNumber: string; file: string; stub: any; neighbors: any[]; reason: string }> = [];
  for (const { dumNumber } of weakDums) {
    const stub = loadDum(dumNumber);
    if (!stub) continue;
    const num = dumNumber.replace(/^DUM-/i, '').padStart(3, '0');
    const file = path.join(dumsDir, `dum_${num}.json`);

    // Collect neighbors: DUMs this stub depends on + DUMs that depend on this stub
    const neighbors: any[] = [];
    for (const depTempId of (stub.dependsOn || [])) {
      const dep = loadDum(depTempId.replace(/^dum_/i, 'DUM-'));
      if (dep) neighbors.push({
        dumNumber: dep.tempId?.toUpperCase().replace('_', '-'),
        title: dep.title,
        description: (dep.description || '').substring(0, 400),
      });
    }

    stubs.push({
      dumNumber,
      file,
      stub,
      neighbors,
      reason: weakByNumber.get(dumNumber.toUpperCase()) || 'quality issue detected by audit',
    });
  }

  if (stubs.length === 0) return { fixed: 0, regeneratedNumbers: new Set() };

  // Build batch prompt for all DUMs at once
  const boilerplateSnapshot = snapshotBoilerplate(workspace.repoPath);

  // RICH payload: full current content + audit's specific reason per DUM.
  // The LLM needs to see the ACTUAL current DUM (not just a snippet) to fix issues in-place
  // without losing existing work.
  const dumsPayload = stubs.map(s => ({
    dumNumber: s.dumNumber,
    auditIssue: s.reason,  // ← THE SPECIFIC PROBLEM TO FIX
    current: {
      title: s.stub.title,
      description: s.stub.description || '',
      type: s.stub.type,
      priority: s.stub.priority,
      requirementIds: s.stub.requirementIds || [],
      dependsOn: s.stub.dependsOn || [],
      tasks: (s.stub.tasks || []).map((t: any) => ({
        title: t.title,
        description: t.description || '',
        acceptanceCriteria: t.acceptanceCriteria || [],
        techContext: t.techContext || '',
        type: t.type,
        layer: t.layer,
        complexity: t.complexity,
      })),
      mermaidDiagram: s.stub.mermaidDiagram || '',
    },
    neighbors: s.neighbors,
  }));

  const reqsCompact = reqs.map((r: any) => ({
    id: r.id,
    title: (r.title || r.name || '').substring(0, 80),
  }));

  const regenPrompt = `You are a senior architect FIXING specific issues in existing DUMs.

⚠️ THESE ARE NOT STUBS — they are FULL DUMs with specific issues identified by an audit.
DO NOT shrink them. DO NOT replace them with summaries. DO NOT downsize.
Your job is TARGETED REPAIR — keep everything that works, fix only what the audit flagged.

⚠️ CODEBASE EXPLORATION IS FORBIDDEN
DO NOT use Glob, Read, Bash, Grep or ANY file tool. The boilerplate structure below is COMPLETE.

⚠️ DO NOT WRITE FILES
Return JSON DIRECTLY in your response text. Do NOT use Write, Edit or any file creation tool.

⚠️ NO SUB-AGENTS
DO NOT use the Agent or Task tool. Fix all DUMs yourself in one response.
Parallel sub-agents produce divergent fixes.

## PROJECT
Name: ${projectName}
Stack: ${JSON.stringify(stack || {})}

## BOILERPLATE STRUCTURE (complete — do NOT explore further)
\`\`\`
${boilerplateSnapshot}
\`\`\`

## REQUIREMENTS (for mapping if needed)
${JSON.stringify(reqsCompact, null, 2)}

## DUMS TO FIX
Each entry has:
- \`auditIssue\`: the SPECIFIC problem to fix (read this CAREFULLY)
- \`current\`: the FULL current content (preserve everything unless the audit says to change it)
- \`neighbors\`: DUMs this one depends on (for context)

${JSON.stringify(dumsPayload, null, 2)}

## YOUR TASK — TARGETED REPAIR

For each DUM:
1. Read the \`auditIssue\` — this tells you EXACTLY what to fix
2. Read \`current\` — this is what already exists
3. Produce a FIXED version that:
   - Preserves ALL tasks that aren't broken (keep their titles, descriptions, AC)
   - Fixes the specific issue (e.g. if auditIssue says "wrong paths mobile/lib/ → app/lib/", replace them)
   - Adds missing fields (e.g. if auditIssue says "tasks lack techContext", ADD techContext pointing to real file paths based on the boilerplate above)
   - Never shrinks task count below current
   - Never produces description shorter than 80% of current

CRITICAL: If auditIssue mentions "wrong paths", find-replace the wrong paths in ALL task fields.
If auditIssue mentions "missing techContext", ADD techContext to each task with specific file paths.
If auditIssue mentions "ownership conflict", note it in description but do NOT delete tasks — mark them.
If auditIssue mentions "scope overlap", consolidate related tasks but keep all unique work.

## OUTPUT FORMAT (STRICT JSON — no markdown, no code fences, no commentary)
{
  "dums": [
    {
      "dumNumber": "DUM-086",
      "title": "...",
      "description": "...",  // preserved or improved, never shorter than 80% of current
      "type": "...",
      "priority": "...",
      "requirementIds": [...],  // preserved unless audit says to change
      "dependsOn": [...],  // preserved unless audit says to change
      "tasks": [
        {
          "title": "...",
          "description": "...",
          "acceptanceCriteria": [...],
          "techContext": "...",  // REQUIRED — never empty
          "type": "feature|test|infra|database|architecture",
          "layer": "backend|frontend|mobile|infra",
          "complexity": "low|medium|high"
        }
      ],
      "mermaidDiagram": "..."
    }
  ]
}

Return ONLY the JSON. Fix SPECIFIC issues. Preserve everything else.`;

  console.log(`${dim('│')}    ${dim(`Corrigindo ${stubs.length} DUM(s) baseado nas issues do audit...`)}`);
  const stopSpin = spinner(`Corrigindo DUMs via ${cli.toUpperCase()}`);
  const llmOut = await runLocalCLI(cli, regenPrompt, workspace.repoPath, 12 * 60 * 1000);
  stopSpin();

  if (!llmOut) {
    console.log(`${dim('│')}    ${red('✗')} LLM não retornou regeneração`);
    return { fixed: 0, regeneratedNumbers: new Set() };
  }

  let regenerated: any[] = [];
  try {
    const jsonMatch = llmOut.match(/\{[\s\S]*"dums"[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON with "dums" in LLM output');
    regenerated = (JSON.parse(jsonMatch[0]).dums || []);
  } catch (err: any) {
    console.log(`${dim('│')}    ${red('✗')} Parse falhou: ${err.message}`);
    return { fixed: 0, regeneratedNumbers: new Set() };
  }

  const validReqIds = new Set(reqs.map((r: any) => r.id));
  const regeneratedNumbers = new Set<string>();
  let fixed = 0;

  for (const regen of regenerated) {
    const entry = stubs.find(s => s.dumNumber.toUpperCase() === (regen.dumNumber || '').toUpperCase());
    if (!entry) continue;

    // Preserve identity + deps from stub, inherit new content from regen (with fallbacks)
    const cleanReqIds = regen.requirementIds?.length
      ? regen.requirementIds.filter((id: string) => validReqIds.has(id))
      : (entry.stub.requirementIds || []);

    const rebuilt = {
      ...entry.stub,
      title: regen.title || entry.stub.title,
      description: regen.description || entry.stub.description || '',
      type: regen.type || entry.stub.type,
      tasks: (Array.isArray(regen.tasks) && regen.tasks.length > 0) ? regen.tasks : (entry.stub.tasks || []),
      mermaidDiagram: regen.mermaidDiagram || entry.stub.mermaidDiagram || '',
      requirementIds: cleanReqIds,
      // dependsOn preserved from stub (spread)
    };

    // VALIDATION: smart — accept fixes that improve the audit issue, not just metrics.
    const oldDescLen = (entry.stub.description || '').length;
    const newDescLen = (rebuilt.description || '').length;
    const oldTaskCount = (entry.stub.tasks || []).length;
    const newTaskCount = (rebuilt.tasks || []).length;
    const hasAnyAc = rebuilt.tasks.some((t: any) => (t.acceptanceCriteria || []).length > 0);

    // Hard rejects — the regen is structurally broken
    if (newTaskCount === 0) {
      console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${entry.dumNumber}: LLM não retornou tasks — mantendo original`)}`);
      continue;
    }
    if (!hasAnyAc) {
      console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${entry.dumNumber}: LLM retornou tasks sem AC — mantendo original`)}`);
      continue;
    }

    // Soft check: did the audit issue get addressed?
    // If audit mentions specific fixes (paths, techContext, etc), verify they were applied.
    const reasonLower = entry.reason.toLowerCase();
    const oldTechContextCount = (entry.stub.tasks || []).filter((t: any) => t.techContext).length;
    const newTechContextCount = rebuilt.tasks.filter((t: any) => t.techContext).length;

    if (/lack.*techcontext|sem techcontext|missing techcontext/.test(reasonLower)) {
      if (newTechContextCount <= oldTechContextCount) {
        console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${entry.dumNumber}: audit pedia techContext mas LLM não adicionou — mantendo original`)}`);
        continue;
      }
    }

    // Path fix check
    if (/mobile\/lib|wrong path|incorrect path/.test(reasonLower)) {
      const oldHasWrongPath = JSON.stringify(entry.stub).includes('mobile/lib');
      const newHasWrongPath = JSON.stringify(rebuilt).includes('mobile/lib');
      if (oldHasWrongPath && newHasWrongPath) {
        console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${entry.dumNumber}: paths 'mobile/lib/' ainda presentes — mantendo original`)}`);
        continue;
      }
    }

    // Generic quality floor: new version must preserve at least 80% of task count
    // and description shouldn't collapse to less than 50% of original
    if (newTaskCount < oldTaskCount * 0.8) {
      console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${entry.dumNumber}: LLM reduziu tasks (${oldTaskCount}→${newTaskCount}) — mantendo original`)}`);
      continue;
    }
    if (oldDescLen > 500 && newDescLen < oldDescLen * 0.5) {
      console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${entry.dumNumber}: LLM colapsou descrição (${oldDescLen}→${newDescLen}) — mantendo original`)}`);
      continue;
    }

    try {
      // 1. Overwrite disk file
      fs.writeFileSync(entry.file, JSON.stringify(rebuilt, null, 2), 'utf8');

      // 2. Delete + rewrite memory file (exception: stubs are not sacred memory)
      const memFile = path.join(memoryDir, `${rebuilt.tempId}.json`);
      try { if (fs.existsSync(memFile)) fs.unlinkSync(memFile); } catch (err) { swallow(err); }
      try {
        fs.mkdirSync(memoryDir, { recursive: true });
        fs.writeFileSync(memFile, JSON.stringify(rebuilt, null, 2), 'utf8');
      } catch (err) { swallow(err); }

      // 3. Replace backend DUM content via dedicated endpoint
      //    (POST /save-decomposition skips duplicates by title — we need REPLACE, not CREATE)
      await api.post(
        `/dark-factory/projects/${projectId}/dums/${entry.dumNumber}/replace`,
        { dum: rebuilt },
        { timeout: 30_000 },
      );

      regeneratedNumbers.add(entry.dumNumber);
      fixed++;
      console.log(`${dim('│')}    ${green('✓')} ${dim(`${entry.dumNumber}: ${(rebuilt.title || '').substring(0, 48)} (${newTaskCount} tasks, ${newDescLen} chars)`)}`);
    } catch (err: any) {
      console.log(`${dim('│')}    ${red('✗')} ${dim(`${entry.dumNumber}: ${err.response?.data?.message || err.message}`)}`);
    }
  }

  console.log(`${dim('│')}  ${green('✓')} ${dim(`${fixed}/${stubs.length} DUMs fracos regenerados (disco + backend)`)}`);
  return { fixed, regeneratedNumbers };
}

export async function rewriteDumDescription(dum: any, fullContext: any, cli: string, cwd: string): Promise<string | null> {
  const project = fullContext.project || {};
  const stack = project.stack ? JSON.stringify(project.stack) : 'not defined';
  const briefing = (project.briefing || project.description || '').substring(0, 2000);
  const tasks = (dum.tasks || []).map((t: any) => `- ${t.title}: ${(t.description || '').substring(0, 100)}`).join('\n');

  const prompt = `You are a senior software architect. Write a detailed DUM (Development Unit of Meaning) description.

Project: ${project.name || 'Unknown'}
Stack: ${stack}
Briefing: ${briefing}

DUM to describe:
- Title: ${dum.title}
- Type: ${dum.type}
- Tasks: ${tasks}

Write a description of 1500+ characters in structured Markdown with ALL of these sections:
## Escopo
What this DUM covers and what it explicitly does NOT cover.

## Contexto Técnico
What already exists in the boilerplate/codebase. Exact file paths this DUM builds on.

## Arquivos
Exact file paths to create/modify (e.g. src/auth/auth.module.ts, src/auth/auth.service.ts).

## Regras de Negócio
Specific domain rules with concrete values, field names, limits, and conditions.

## Dependências
Which other DUMs must complete first and why.

## Resultado Esperado
What the system looks like after this DUM completes. Which future DUMs this enables.

Return ONLY the description text (no JSON, no code fences).`;

  const result = await runLocalCLI(cli || 'claude', prompt, cwd);
  if (!result || result.length < 800) return null;
  // Strip any code fences if model wrapped it
  return result.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
}
