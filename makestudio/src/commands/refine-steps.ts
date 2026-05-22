import { swallow } from '../utils/log';
/**
 * Refine pipeline — steps topic. Extracted from refine.ts.
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
import { printBanner } from '../utils/banner';
import { ensureAuthenticated } from '../network/auth';
import { detectInstalledCLIs } from '../core/cli-detector';
import { askProjectLocation, cleanupWorkspace } from '../core/workspace-resolver';
import { ask, askWithTimeout, spinner, runLocalCLI } from './refine-prompts';
import { syncDiskDumsToBackend } from './refine-sync';
import { auditDumsPackage, displayAuditReport } from './refine-audit';
import { regenerateWeakDums, generateCorrectiveDums } from './refine-fix';
import { runDecompose } from './refine-decompose';

const CLI_TO_PROVIDER: Record<string, string> = {
  claude: 'anthropic',
  codex:  'openai',
  gemini: 'google',
};

export async function _refineCommandInner(options: {
  projectId?: string;
  cli?: string;
  noDecompose?: boolean;
  requirementsOnly?: boolean;
  repo?: string;
}): Promise<void> {
  if (!process.env.MAKESTUDIO_REPL) printBanner('Refinamento de Projeto');
  console.log(dim('│'));

  await ensureAuthenticated();
  const api = getApiClient();

  // ── Resolve CLI / provider ────────────────────────────────────
  let selectedCli = options.cli?.toLowerCase();
  if (!selectedCli) {
    const installed = await detectInstalledCLIs();
    if (installed.length === 0) {
      console.log(`${dim('│')}  ${yellow('⚠')}  Nenhum CLI de IA encontrado. Instale claude, codex ou gemini.`);
      process.exit(1);
    }
    if (installed.length === 1) {
      selectedCli = installed[0].name;
      console.log(`${dim('│')}  ${dim('→')} CLI: ${cyan(selectedCli)} ${dim('(único disponível)')}`);
    } else {
      console.log(`${dim('│')}  CLIs disponíveis:`);
      installed.forEach((c, i) => console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(c.name)} ${dim(c.version)}`));
      console.log(dim('│'));
      const answer = await ask(`  Qual CLI usar para enriquecimento? ${dim('[número]')}: `);
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= installed.length) {
        console.log(`${dim('│')}  ${yellow('⚠')}  Seleção inválida, saindo.`);
        process.exit(0);
      }
      selectedCli = installed[idx].name;
    }
  }
  const preferredProvider = CLI_TO_PROVIDER[selectedCli] || selectedCli;
  console.log(`${dim('│')}  CLI: ${cyan(selectedCli)} ${dim(`→ provider: ${preferredProvider}`)}`);
  console.log(dim('│'));

  // ── Select project ────────────────────────────────────────────
  let projectId = options.projectId;
  let projectName = '';

  if (!projectId) {
    const stop = spinner('Buscando projetos...');
    let projects: any[] = [];
    try {
      const res = await api.get('/dark-factory/projects', { params: { limit: 50 }, timeout: 10_000 });
      projects = res.data?.data || res.data || [];
    } catch (err) { swallow(err); }
    stop();

    if (projects.length === 0) {
      console.log(`${dim('│')}  ${red('✗')}  Nenhum projeto encontrado. Crie um projeto primeiro.`);
      process.exit(1);
    }

    console.log(`${dim('│')}  Projetos disponíveis:`);
    console.log(dim('│'));
    projects.slice(0, 30).forEach((p: any, i: number) => {
      const hasSpec = p.specDocument?.enrichedAt ? green('✓ spec') : yellow('✗ spec');
      const statusLabel = dim(`· ${p.status || 'intake'}`);
      console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(p.name)} ${dim(`(${p.id.slice(0, 8)})`)}  ${hasSpec}  ${statusLabel}`);
    });
    console.log(dim('│'));

    const answer = await ask(`  Qual projeto refinar? ${dim('[número]')}: `);
    const idx = parseInt(answer, 10) - 1;
    if (idx < 0 || idx >= projects.length) {
      console.log(`${dim('│')}  ${yellow('⚠')}  Seleção inválida, saindo.`);
      process.exit(0);
    }
    projectId = projects[idx].id;
    projectName = projects[idx].name;
  } else {
    // Fetch project name
    try {
      const res = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
      projectName = res.data.name;
    } catch {
      projectName = projectId.slice(0, 8);
    }
  }

  console.log(`${dim('│')}  Projeto: ${cyan(projectName)} ${dim(`(${projectId!.slice(0, 8)})`)}`);
  console.log(dim('│'));

  await runDumAndSpecEnrichmentSteps({ api, projectId: projectId!, projectName, selectedCli, options });

  // ── Step 2: Load + display requirements ─────────────────────
  console.log(`${dim('│')}  ${blue('2/3')} Carregando requisitos...`);
  let reqs: any[] = [];
  try {
    const reqRes = await api.get(`/dark-factory/analyst/requirements/${projectId}`, { timeout: 10_000 });
    const raw = reqRes.data;
    reqs = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.requirements) ? raw.requirements
      : Array.isArray(raw?.data) ? raw.data
      : [];
  } catch (err: any) {
    console.log(`${dim('│')}  ${yellow('⚠')} Não foi possível carregar: ${dim(err.message)}`);
  }

  // Color palette shared between Step 2 (table) and Step 3 (pending list)
  const white2 = chalk.hex('#E2E8F0');
  const slate2 = chalk.hex('#94A3B8');

  if (reqs.length === 0) {
    console.log(`${dim('│')}  ${yellow('⚠')}  Nenhum requisito encontrado. Execute a análise primeiro:`);
    console.log(`${dim('│')}     ${cyan('makestudio analyze --deep --project-id')} ${projectId}`);
  } else {
    // ── Tabela de requisitos ─────────────────────────────────

    const shallow = reqs.filter((r: any) => (r.description || '').length < 150 || (r.acceptanceCriteria || []).length < 2);
    const okCount = reqs.length - shallow.length;

    // Build set of requirement IDs already covered by existing DUMs
    // Source of truth: UNION of backend DUMs + disk DUMs in .makestudio/dums/
    // (disk may have DUMs that were generated but never persisted to backend)
    let decomposedReqIds = new Set<string>();
    let diskDumCount = 0;
    let backendDumCount = 0;
    try {
      const dumsRes = await api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 8_000 });
      const dums = (dumsRes.data?.dums || dumsRes.data || []).filter((d: any) => d.level >= 2);
      backendDumCount = dums.length;
      for (const d of dums) {
        for (const rid of (d.requirementIds || [])) decomposedReqIds.add(rid);
      }
    } catch (err) { swallow(err); }
    // Also read disk DUMs — they are the source of truth if refine was interrupted
    try {
      // Walk up from cwd to find .makestudio/dums (user may run from subfolder)
      const candidateRoots = [process.cwd(), path.resolve(process.cwd(), '..')];
      let dumsDirLocal: string | null = null;
      for (const root of candidateRoots) {
        const d = path.join(root, '.makestudio', 'dums');
        if (fs.existsSync(d)) { dumsDirLocal = d; break; }
      }
      if (dumsDirLocal) {
        const diskFiles = fs.readdirSync(dumsDirLocal).filter(f => /^dum_\d+\.json$/.test(f));
        diskDumCount = diskFiles.length;
        for (const file of diskFiles) {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(dumsDirLocal, file), 'utf8'));
            for (const rid of (content.requirementIds || [])) decomposedReqIds.add(rid);
          } catch (err) { swallow(err); }
        }
      }
    } catch (err) { swallow(err); }

    const decomposedCount = reqs.filter((r: any) => decomposedReqIds.has(r.id)).length;
    if (diskDumCount > backendDumCount) {
      console.log(`${dim('│')}  ${yellow('⚠')} ${yellow(`Disco tem ${diskDumCount} DUMs mas backend só tem ${backendDumCount} — há DUMs não sincronizados`)}`);
    }

    console.log(`${dim('│')}  ${cyan(String(reqs.length))} requisitos  ${green('✓')} ${green(String(okCount))} completos  ${red('✗')} ${red(String(shallow.length))} rasos${decomposedCount > 0 ? `  ${chalk.hex('#A78BFA')('◆')} ${chalk.hex('#A78BFA')(String(decomposedCount))} decompostos` : ''}`);
    console.log(dim('│'));
    console.log(`${dim('│')}  ${slate2(' St  Dc    #   Categoria        Título')}`);
    console.log(`${dim('│')}  ${dim('─────────────────────────────────────────────────────────────')}`);

    reqs.forEach((r: any, i: number) => {
      const num      = String(i + 1).padStart(3, ' ');
      const rawCat   = (r.category || r.type || 'GERAL').toUpperCase();
      const catLabel = rawCat.substring(0, 13).padEnd(13, ' ');
      const title    = (r.title || r.name || r.description || '').substring(0, 46);
      const isShallow = (r.description || '').length < 150 || (r.acceptanceCriteria || []).length < 2;
      const isDecomposed = decomposedReqIds.has(r.id);
      const status   = isShallow ? red('✗') : green('✓');
      const dcMark   = isDecomposed ? chalk.hex('#A78BFA')('◆') : ' ';
      console.log(`${dim('│')}  ${status}   ${dcMark}    ${dim(num)}  ${catColor(rawCat)(catLabel)}  ${white2(title)}`);
    });

    console.log(dim('│'));
    console.log(`${dim('│')}  ${green('✓')} ${slate2('completo — descrição detalhada + critérios de aceite')}`)
    console.log(`${dim('│')}  ${red('✗')} ${slate2('raso — descrição curta ou sem critérios (será enriquecido na decomposição)')}`)
    if (decomposedCount > 0) {
      console.log(`${dim('│')}  ${chalk.hex('#A78BFA')('◆')} ${slate2('decomposto — já possui DUM gerado')}`);
    }
  }

  await runDecompositionAndAuditStep({ api, projectId: projectId!, projectName, selectedCli, reqs, options });

  // ── Summary ───────────────────────────────────────────────────
  console.log(dim('│'));
  console.log(`${dim('│')}  ${green('✓')} Refinamento concluído para ${cyan(projectName)}`);
  console.log(`${dim('│')}  ${dim('→ Acesse o painel web para revisar os requisitos e o pipeline')}`);
  console.log('');
}

export function catColor(cat: string) {
  const c = cat.toUpperCase();
  if (c.includes('AUTH') || c.includes('SECURITY')) return chalk.hex('#F472B6');    // pink
  if (c.includes('NON_FUNC') || c.includes('PERFORMANCE')) return chalk.hex('#FBBF24'); // yellow
  if (c.includes('DATA') || c.includes('DATABASE')) return chalk.hex('#34D399');    // emerald
  if (c.includes('UI') || c.includes('DESIGN') || c.includes('SCREEN')) return chalk.hex('#A78BFA'); // violet
  if (c.includes('FUNC')) return chalk.hex('#60A5FA');                               // blue
  return chalk.hex('#94A3B8');                                                        // slate default
}

export async function runDumAndSpecEnrichmentSteps(ctx: {
  api: any;
  projectId: string;
  projectName: string;
  selectedCli: string | undefined;
  options: { requirementsOnly?: boolean };
}): Promise<void> {
  const { api, projectId, projectName, selectedCli, options } = ctx;
// ── Step 0: Rewrite shallow DUM descriptions ─────────────────
if (!options.requirementsOnly) {
  process.stdout.write(`${dim('│')}  ${blue('0/3')} Verificando DUMs... `);
  let project0: any = {};
  let dums: any[] = [];
  try {
    const [projRes, dumsRes] = await Promise.all([
      api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 }),
      api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 10_000 }),
    ]);
    project0 = projRes.data;
    dums = dumsRes.data?.dums || dumsRes.data || [];
  } catch (err) { swallow(err); }

  // Detect shallow DUMs: template text OR very short description
  const SHALLOW_PATTERNS = [
    /DUM mestre.*nível.*contendo/i,
    /Master DUM.*level.*containing/i,
    /nível \d+ contendo/i,
    /definições gerais do projeto/i,
    /epics from which level/i,
  ];
  const shallowDums = dums.filter((d: any) => {
    const desc = d.description || '';
    return desc.length < 400 || SHALLOW_PATTERNS.some(p => p.test(desc));
  });

  if (shallowDums.length === 0) {
    console.log(`${green('✓')} ${dim('Todas as descrições estão OK')}`);
  } else {
    console.log(`${yellow('⚠')} ${dim(`${shallowDums.length} DUMs com descrição rasa`)}`);
    console.log(dim('│'));

    // ── Gravar briefing completo em arquivo tmp ──────────────
    const briefingFull = project0.briefing || project0.description || '';
    const briefingFile = `${os.tmpdir()}/makestudio_briefing_${projectId}.md`;
    if (briefingFull) {
      fs.writeFileSync(briefingFile, briefingFull, 'utf8');
      console.log(`${dim('│')}  ${dim(`→ Briefing gravado: ${briefingFile} (${Math.round(Buffer.byteLength(briefingFull) / 1024)}KB)`)}`);
    }

    for (const dum of shallowDums) {
      const dumOutputFile = `${os.tmpdir()}/makestudio_dum_${dum.id}.txt`;
      console.log(`${dim('│')}  ${dim('→')} Reescrevendo: ${cyan((dum.title || dum.id).substring(0, 60))}`);

      const dumPrompt = briefingFull
        ? `You are a senior software architect and technical writer producing documentation for a real software project.

You must write a COMPLETE, DETAILED technical specification for this DUM (Deliverable Unit of Work).

DUM TITLE: ${dum.title}
DUM LEVEL: ${dum.level || 1}
PROJECT: ${projectName}

FIRST: Read the COMPLETE project briefing from this file:
${briefingFile}
Use the Read tool to read it entirely — it may be large, read it all.

FORMAT RULES (MANDATORY):
- Use MARKDOWN formatting — headings with ##/###, bullet lists with -, bold with **text**, code with \`code\`
- Do NOT use ASCII separators like ====, ----, ────, or ████
- Do NOT write "TÍTULO:", "NÍVEL:", "DATA:" as plain text headers — use ## Markdown headings instead
- Structure with clear ## and ### headings for each section
- Use - bullet lists for features and criteria (not • or [F-001] style)

Then write a comprehensive description with these sections as ## Markdown headings:

## Overview
What this DUM represents in the full system. Be precise about scope and boundaries.

## Covered Functionality
List every feature, screen, endpoint, or component this DUM delivers. Use - bullet lists. Be exhaustive.

## Architecture & Technical Decisions
Stack choices, design patterns, data models, API contracts, key algorithms. Cite specific technologies from the briefing.

## Implementation Requirements
What needs to be coded, configured, or integrated. Include edge cases and business rules extracted from the briefing.

## Integrations & Dependencies
What this DUM depends on and what other DUMs depend on it.

## Acceptance Criteria
Concrete, testable criteria that define "done" for this DUM. Use - bullet lists.

Write as much as necessary to be complete — there is NO length limit. This is a real technical document, not a summary.
Do NOT use generic placeholder text. Every sentence must reference specific details from the briefing.
Always respond in the language the user is currently using (pt-BR, en, or es).

Save the full result to: ${dumOutputFile}
Use the Write tool to save it, then print: DONE`
        : `You are a senior software architect. Write a complete technical specification for this DUM using MARKDOWN formatting (## headings, - bullet lists, **bold**). Do NOT use ASCII separators like ==== or ────.
DUM: ${dum.title} (level ${dum.level || 1}) — Project: ${projectName}
Cover with ## sections: Overview, Covered Functionality, Architecture, Implementation Requirements, Dependencies, Acceptance Criteria.
No length limit — write as much as needed to fully specify the work.
Always respond in the language the user is currently using (pt-BR, en, or es).
Save to: ${dumOutputFile} then print: DONE`;

      const result = await runLocalCLI(selectedCli!, dumPrompt, os.tmpdir());

      // Read from file first, fallback to result text
      let newDesc = '';
      if (fs.existsSync(dumOutputFile)) {
        newDesc = fs.readFileSync(dumOutputFile, 'utf8').trim();
      }
      if (!newDesc && result) {
        newDesc = result.trim();
      }

      if (newDesc.length > 100) {
        try {
          await api.put(`/dark-factory/dums/${dum.id}`, { description: newDesc }, { timeout: 15_000 });
          const kb = Math.round(Buffer.byteLength(newDesc) / 1024);
          console.log(`${dim('│')}  ${green('✓')} ${dim(`${(dum.title || '').substring(0, 40)} — ${kb > 0 ? kb + 'KB' : newDesc.length + ' chars'}`)}`);
        } catch (err: any) {
          console.log(`${dim('│')}  ${red('✗')} ${dim(`Falha ao salvar: ${err.message}`)}`);
        }
      } else {
        console.log(`${dim('│')}  ${yellow('⚠')} ${dim('CLI não retornou descrição válida — pulando')}`);
      }
    }
  }
  console.log(dim('│'));
}

// ── Step 1: Enrich spec locally via CLI ──────────────────────
if (!options.requirementsOnly) {
  // Fetch project data for the prompt
  let project: any = {};
  try {
    const r = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
    project = r.data;
  } catch (err) { swallow(err); }

  // Check if spec already exists — ask before regenerating
  const existingSpec = project.specDocument;
  const hasSpec = existingSpec?.enrichedAt && existingSpec?.functionalAreas?.length >= 1;
  let skipSpec = false;

  if (hasSpec) {
    const areas = existingSpec.functionalAreas?.length || 0;
    const goals = existingSpec.projectGoals?.length || 0;
    const enrichedAt = new Date(existingSpec.enrichedAt).toLocaleString('pt-BR');
    console.log(`${dim('│')}  ${green('✓')} Spec já existe: ${dim(`${areas} áreas, ${goals} objetivos (gerada em ${enrichedAt})`)}`);
    const answer = await ask(`${dim('│')}  Deseja regerar a spec? [s/N]: `);
    skipSpec = !answer.match(/^[sS]$/);
    if (skipSpec) {
      console.log(`${dim('│')}  ${dim('Pulando geração de spec — usando a existente.')}`);
    }
  }

  if (!skipSpec) {
  console.log(`${dim('│')}  ${blue('1/3')} Gerando spec com ${cyan(selectedCli!.toUpperCase())}...`);
  console.log(dim('│'));

  const briefing = project.briefing || project.description || '';
  const stack = JSON.stringify(project.stack || {});
  const outputFile = `${os.tmpdir()}/makestudio_spec_${projectId}.json`;

  // ── Gravar briefing em arquivo para o CLI ler completo ───────
  const briefingContextFile = `${os.tmpdir()}/makestudio_briefing_${projectId}.md`;
  if (briefing) {
    fs.writeFileSync(briefingContextFile, briefing, 'utf8');
  }
  const briefingInstruction = briefing
    ? `Read the COMPLETE project briefing from this file before generating the spec:
${briefingContextFile}
(${Math.round(Buffer.byteLength(briefing) / 1024)}KB — use the Read tool or bash to read it fully)`
    : '(no briefing provided — infer from project name and stack)';

  const prompt = `You are a senior product manager and software architect.
Analyze this project briefing and produce a comprehensive specification document.

PROJECT NAME: ${project.name || projectName}
STACK: ${stack}

BRIEFING FILE:
${briefingInstruction}

Generate a detailed specification covering ALL aspects. Be specific to THIS project.
Extract REAL features from the briefing — do not write generic examples.

Build the JSON object with this exact structure:
{
"version": "1.0",
"enrichedAt": "${new Date().toISOString()}",
"projectGoals": ["goal 1", "goal 2", "goal 3"],
"userPersonas": [
  { "name": "persona name", "description": "who they are", "mainNeeds": ["need 1", "need 2"] }
],
"functionalAreas": [
  { "name": "area name", "description": "what this covers", "features": ["feature 1", "feature 2", "feature 3"] }
],
"nonFunctionalRequirements": [
  { "category": "performance|security|scalability|usability", "description": "specific requirement" }
],
"constraints": ["constraint 1", "constraint 2"],
"successCriteria": ["measurable criterion 1", "measurable criterion 2"],
"outOfScope": ["what is NOT in this version"],
"suggestedStack": { "backend": [], "frontend": [], "mobile": [], "database": [] }
}

Requirements:
- projectGoals: 3-6 SPECIFIC goals for THIS project (not generic)
- userPersonas: 2-4 personas from the briefing context
- functionalAreas: 5-10 areas covering the full system, each with 3-6 concrete features
- nonFunctionalRequirements: minimum 4, covering performance, security, scalability
- constraints: 2-5 real constraints (technical, business, time)
- successCriteria: 3-6 measurable outcomes
- outOfScope: what will NOT be built in this version

IMPORTANT: Save the complete JSON to this file: ${outputFile}
Use the Write tool (or bash) to write the JSON to that path.
After saving, print a single line: DONE`;

  const specResult = await runLocalCLI(selectedCli!, prompt, os.tmpdir());

  if (specResult) {
    try {
      // Priority 1: CLI saved to tmp file (expected path)
      let rawJson = '';
      if (fs.existsSync(outputFile)) {
        rawJson = fs.readFileSync(outputFile, 'utf8').trim();
      }
      // Priority 2: extract JSON from result text
      if (!rawJson) {
        const jsonMatch = specResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) rawJson = jsonMatch[0];
      }

      if (!rawJson) throw new Error('No JSON in output — CLI ran but produced no structured spec');

      const spec = JSON.parse(rawJson);
      spec.enrichedAt = new Date().toISOString();

      await api.put(`/dark-factory/projects/${projectId}`, { specDocument: spec }, { timeout: 15_000 });
      console.log(dim('│'));
      console.log(`${dim('│')}  ${green('✓')} Spec salva: ${dim(`${spec.functionalAreas?.length || 0} áreas, ${spec.projectGoals?.length || 0} objetivos`)}`);
    } catch (err: any) {
      console.log(dim('│'));
      console.log(`${dim('│')}  ${red('✗')} Erro ao processar spec: ${dim(err.message)}`);
      console.log(`${dim('│')}  ${yellow('→')} Acionando ${cyan(selectedCli!.toUpperCase())} para diagnosticar...`);
      console.log(dim('│'));

      // Auto-diagnose: ask the CLI to analyze the error
      const diagPrompt = `A previous attempt to generate a spec document failed with this error: "${err.message}"

The CLI output was:
${specResult.substring(0, 2000)}

Please:
1. Explain what went wrong
2. Generate the complete spec JSON directly in your response (no file saving needed)

PROJECT: ${project.name || projectName}
BRIEFING: ${(project.briefing || project.description || '').substring(0, 1000)}

Return the spec as a plain JSON object with keys: version, enrichedAt, projectGoals, userPersonas, functionalAreas, nonFunctionalRequirements, constraints, successCriteria, outOfScope`;

      const diagResult = await runLocalCLI(selectedCli!, diagPrompt, os.tmpdir());
      if (diagResult) {
        const jsonMatch = diagResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const spec = JSON.parse(jsonMatch[0]);
            spec.enrichedAt = new Date().toISOString();
            await api.put(`/dark-factory/projects/${projectId}`, { specDocument: spec }, { timeout: 15_000 });
            console.log(dim('│'));
            console.log(`${dim('│')}  ${green('✓')} Spec recuperada: ${dim(`${spec.functionalAreas?.length || 0} áreas`)}`);
          } catch {
            console.log(`${dim('│')}  ${yellow('⚠')} Diagnóstico concluído mas spec ainda inválida — verifique output acima`);
          }
        }
      }
    }
  } else {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${red('✗')} CLI não retornou output`);
    console.log(`${dim('│')}  ${dim('→ Verifique se o CLI está autenticado: claude /login')}`);
  }
  console.log(dim('│'));
  } // end if (!skipSpec)
} else {
  console.log(`${dim('│')}  ${dim('1/3 Enriquecimento de spec pulado (--requirements-only)')}`);
}

}

export async function runDecompositionAndAuditStep(ctx: {
  api: any;
  projectId: string;
  projectName: string;
  selectedCli: string | undefined;
  reqs: any[];
  options: { noDecompose?: boolean; requirementsOnly?: boolean; repo?: string };
}): Promise<void> {
  const { api, projectId, projectName, selectedCli, reqs, options } = ctx;
// ── Step 3: Decomposition mode ────────────────────────────
if (options.noDecompose || options.requirementsOnly) {
  const reason = options.noDecompose ? '--no-decompose' : '--requirements-only';
  console.log(`${dim('│')}`);
  console.log(`${dim('│')}  ${dim(`3/3 Decomposição pulada (${reason})`)}`);
} else if (reqs.length === 0) {
  console.log(`${dim('│')}  ${dim('3/3 Decomposição pulada (sem requisitos)')}`);
} else {
  console.log(dim('│'));
  console.log(`${dim('│')}  ${blue('3/3')} Decomposição de pipeline`);
  console.log(dim('│'));

  // Fetch project data for workspace resolution
  let projectForDecomp: any = {};
  try {
    const r = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
    projectForDecomp = r.data;
  } catch (err) { swallow(err); }

  // ── Resolve workspace ONCE before the loop ──
  const workspace = await askProjectLocation({
    projectId: projectId!,
    projectName: projectForDecomp?.name || projectName || 'Unknown',
    repoUrl: projectForDecomp?.repoUrl,
    repoBranch: projectForDecomp?.repoBranch,
    localPath: projectForDecomp?.metadata?.localPath,
    repoOverride: options?.repo,
  });

  // Save localPath to backend for future runs
  if (workspace.hasCodebase && workspace.repoPath !== os.tmpdir()) {
    try {
      await api.patch(`/dark-factory/projects/${projectId}`, {
        metadata: { ...projectForDecomp?.metadata, localPath: workspace.repoPath },
      }, { timeout: 5_000 });
    } catch (err) { swallow(err); }
  }

  // ── Show existing DUMs (from previous runs) ──
  let existingDumsList: any[] = [];
  try {
    const dumsRes = await api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 8_000 });
    existingDumsList = (dumsRes.data?.dums || dumsRes.data || []).filter((d: any) => d.level >= 2);
  } catch (err) { swallow(err); }

  // ── Sync disk → backend (disk is source of truth) ──
  // DUMs that exist on disk (.makestudio/dums/) but not in backend get POSTed.
  // Then DUMs with empty requirementIds get a batch LLM pass to fill them.
  // Sync fetches ALL backend DUMs internally (including level=1 master) — no filter.
  const syncResult = await syncDiskDumsToBackend({
    api,
    projectId: projectId!,
    workspace,
    reqs,
    cli: selectedCli || 'claude',
  });
  if (syncResult.synced > 0 || syncResult.reconciled > 0) {
    // Refetch backend DUMs after sync
    try {
      const dumsRes = await api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 8_000 });
      existingDumsList = (dumsRes.data?.dums || dumsRes.data || []).filter((d: any) => d.level >= 2);
    } catch (err) { swallow(err); }
  }

  // Fetch task counts per DUM
  let tasksByDum: Record<string, number> = {};
  if (existingDumsList.length > 0) {
    try {
      const tasksRes = await api.get(`/dark-factory/tasks/project/${projectId}`, { timeout: 8_000 });
      const tasks = tasksRes.data?.tasks || tasksRes.data || [];
      for (const t of tasks) {
        const dumId = t.dumId || t.dum_id || '';
        tasksByDum[dumId] = (tasksByDum[dumId] || 0) + 1;
      }
    } catch (err) { swallow(err); }
  }

  if (existingDumsList.length > 0) {
    const totalExistingTasks = Object.values(tasksByDum).reduce((a, b) => a + b, 0);
    console.log(dim('│'));
    console.log(`${dim('│')}  ${green('✓')} ${cyan(String(existingDumsList.length))} DUMs já existentes ${dim(`(${totalExistingTasks} tasks)`)}:`);

    // Show first 15 DUMs for context. Quality/truncation detection is handled
    // by Step 4 auditoria (weakDums rubric) — no manual prompts, fully autonomous.
    for (let i = 0; i < Math.min(15, existingDumsList.length); i++) {
      const d = existingDumsList[i];
      const tc = tasksByDum[d.id] ?? 0;
      const descLen = (d.description || '').length;
      console.log(`${dim('│')}    ${dim('·')} ${dim(d.dumNumber || '?')}: ${(d.title || '').substring(0, 50)} ${dim(`(${tc} tasks, ${descLen} chars)`)}`);
    }
    if (existingDumsList.length > 15) {
      console.log(`${dim('│')}    ${dim(`... e mais ${existingDumsList.length - 15}`)}`);
    }

    console.log(`${dim('│')}  ${dim('→ DUMs fracos/truncados serão detectados e regenerados automaticamente na auditoria (Step 4)')}`);
  }

  // ── Analyze which requirements are already covered ──
  // Union of backend DUMs + disk DUMs (.makestudio/dums/) — disk is source of truth
  const coveredReqIds = new Set<string>();
  for (const d of existingDumsList) {
    if (d.requirementIds?.length) {
      for (const rid of d.requirementIds) coveredReqIds.add(rid);
    }
  }
  try {
    const dumsDirLocal = path.join(workspace.repoPath, '.makestudio', 'dums');
    if (fs.existsSync(dumsDirLocal)) {
      const diskFiles = fs.readdirSync(dumsDirLocal).filter(f => /^dum_\d+\.json$/.test(f));
      // Count disk DUMs at level >= 2 to match existingDumsList filter (which excludes master DUM-001)
      let diskLevel2Count = 0;
      for (const file of diskFiles) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(dumsDirLocal, file), 'utf8'));
          for (const rid of (content.requirementIds || [])) coveredReqIds.add(rid);
          if ((content.level || 2) >= 2) diskLevel2Count++;
        } catch (err) { swallow(err); }
      }
      if (diskLevel2Count > existingDumsList.length) {
        console.log(`${dim('│')}  ${yellow('⚠')} ${yellow(`Disco tem ${diskLevel2Count} DUMs — backend tem ${existingDumsList.length} — verifique sincronização`)}`);
      }
    }
  } catch (err) { swallow(err); }
  // Build uncovered list WITH original indices (for display)
  const uncoveredWithIdx = reqs
    .map((r: any, idx: number) => ({ req: r, idx: idx + 1 }))
    .filter(({ req }) => !coveredReqIds.has(req.id));
  const uncoveredReqs = uncoveredWithIdx.map(x => x.req);

  if (existingDumsList.length > 0 && uncoveredReqs.length > 0) {
    const pendingNums = uncoveredWithIdx.map(x => `#${x.idx}`).join(', ');
    console.log(dim('│'));
    console.log(`${dim('│')}  ${green(String(coveredReqIds.size))}/${reqs.length} requisitos cobertos  ·  ${yellow(`${uncoveredReqs.length} pendentes`)}`);
    console.log(dim('│'));
    console.log(`${dim('│')}  ${yellow('Requisitos pendentes:')}`);
    for (const { req, idx } of uncoveredWithIdx) {
      const cat = (req.category || req.type || 'GERAL').toUpperCase().substring(0, 13).padEnd(13, ' ');
      const title = (req.title || req.name || '').substring(0, 55);
      console.log(`${dim('│')}    ${yellow('○')} ${dim(`#${String(idx).padStart(3, ' ')}`)}  ${catColor(cat.trim())(cat)}  ${title}`);
    }
  } else if (existingDumsList.length > 0 && uncoveredReqs.length === 0) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${green('✓')} Todos os ${reqs.length} requisitos já estão cobertos por DUMs existentes.`);
  }

  const allCovered = uncoveredReqs.length === 0 && existingDumsList.length > 0;

  console.log(dim('│'));
  console.log(`${dim('│')}  ${cyan('Como proceder?')}`);
  console.log(dim('│'));
  if (uncoveredReqs.length > 0 && uncoveredReqs.length < reqs.length) {
    console.log(`${dim('│')}    ${cyan('1)')} ${green('Decompor apenas os pendentes')} ${dim(`(${uncoveredReqs.length} requisito${uncoveredReqs.length > 1 ? 's' : ''} faltantes) + auditoria`)}`);
  } else if (uncoveredReqs.length === reqs.length) {
    console.log(`${dim('│')}    ${cyan('1)')} Decompor todos ${dim(`(${reqs.length} requisitos) + auditoria`)}`);
  } else {
    console.log(`${dim('│')}    ${cyan('1)')} ${green('Apenas auditar qualidade')} ${dim(`(tudo coberto — fábrica vai analisar e corrigir automaticamente)`)}`);
  }
  console.log(`${dim('│')}    ${cyan('2)')} Decompor faixa personalizada ${dim('(ex: 5-12) + auditoria')}`);
  console.log(`${dim('│')}    ${cyan('3)')} Decompor em lotes ${dim('(N por vez) + auditoria')}`);
  console.log(`${dim('│')}    ${cyan('4)')} Decompor um por um ${dim('+ auditoria')}`);
  console.log(`${dim('│')}    ${cyan('5)')} Re-decompor TODOS ${dim('(ignora cobertura) + auditoria')}`);
  console.log(`${dim('│')}    ${dim('0)')} ${dim('Sair sem auditar')}`);
  console.log(dim('│'));

  const modeAnswer = await ask(`  Opção: `);
  const mode = parseInt(modeAnswer, 10);

  if (mode === 0 || isNaN(mode)) {
    console.log(`${dim('│')}  ${dim('Pulando tudo.')}`);
  } else if (mode === 1) {
    // ── Pendentes (ou apenas auditoria se tudo coberto) ────────────────
    if (allCovered) {
      // Nothing to decompose — audit runs below
      console.log(`${dim('│')}  ${dim('Pulando decomposição — todos requisitos cobertos. Rodando apenas auditoria...')}`);
    } else {
      const targetReqs = uncoveredReqs;
      const targetLabel = uncoveredReqs.length === reqs.length
        ? `1–${reqs.length}`
        : `pendentes (${uncoveredReqs.length})`;
      await runDecompose(api, projectId!, targetReqs.map((r: any) => r.id), targetLabel, selectedCli, workspace);
    }
  } else if (mode === 5) {
    // ── Re-decompor TODOS ────────────────────────────────────
    console.log(dim('│'));
    const confirm = await ask(`${dim('│')}  ${yellow('⚠')} Isso vai gerar DUMs para todos os ${reqs.length} requisitos, mesmo os já cobertos. Continuar? [s/N]: `);
    if (confirm.match(/^[sS]$/)) {
      await runDecompose(api, projectId!, reqs.map((r: any) => r.id), `1–${reqs.length}`, selectedCli, workspace);
    } else {
      console.log(`${dim('│')}  ${dim('Cancelado.')}`);
    }
  } else if (mode === 2) {
    // ── Faixa personalizada ───────────────────────────────
    console.log(dim('│'));
    const rangeInput = await ask(`  Faixa ${dim(`(1–${reqs.length}, ex: 1-10)`)}: `);
    if (!rangeInput.trim()) {
      console.log(`${dim('│')}  ${dim('Decomposição pulada.')}`);
    } else {
      const match = rangeInput.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (!match) {
        console.log(`${dim('│')}  ${yellow('⚠')} Formato inválido. Use: 1-10`);
      } else {
        const startFrom = Math.max(1, parseInt(match[1], 10));
        const endAt = Math.min(reqs.length, parseInt(match[2], 10));
        if (startFrom > endAt) {
          console.log(`${dim('│')}  ${yellow('⚠')} Faixa inválida.`);
        } else {
          // Process the initial range, then auto-continue with remaining
          let cursor = startFrom;
          while (cursor <= endAt) {
            const batchEnd = Math.min(cursor + 4, endAt); // batches of 5 reqs
            const batch = reqs.slice(cursor - 1, batchEnd).map((r: any) => r.id);
            await runDecompose(api, projectId!, batch, `${cursor}–${batchEnd}`, selectedCli, workspace);
            cursor = batchEnd + 1;

            if (cursor <= endAt) {
              const cont = await askWithTimeout(`Continuar com ${cursor}–${endAt}? [S/n]`);
              if (cont.toLowerCase().startsWith('n')) break;
            }
          }
        }
      }
    }
  } else if (mode === 3) {
    // ── Em lotes de N ────────────────────────────────────
    const batchInput = await ask(`  Tamanho do lote ${dim('(ex: 5)')}: `);
    const batchSize  = parseInt(batchInput, 10) || 5;
    const totalBatches = Math.ceil(reqs.length / batchSize);

    for (let b = 0; b < totalBatches; b++) {
      const from  = b * batchSize;
      const to    = Math.min(from + batchSize, reqs.length);
      const batch = reqs.slice(from, to).map((r: any) => r.id);
      const label = `${from + 1}–${to} ${dim(`(lote ${b + 1}/${totalBatches})`)}`;

      await runDecompose(api, projectId!, batch, label, selectedCli, workspace);

      if (b < totalBatches - 1) {
        console.log(dim('│'));
        const cont = await askWithTimeout(`Continuar com lote ${b + 2}/${totalBatches}? [S/n]`);
        if (cont.toLowerCase().startsWith('n')) {
          console.log(`${dim('│')}  ${dim(`Decomposição pausada no lote ${b + 1}/${totalBatches}. Retome pelo painel web.`)}`);
          break;
        }
      }
    }
  } else if (mode === 4) {
    // ── Um por um ────────────────────────────────────────
    for (let i = 0; i < reqs.length; i++) {
      const r = reqs[i];
      const title = (r.title || r.name || r.description || '').substring(0, 60);
      console.log(dim('│'));
      console.log(`${dim('│')}  ${dim(`[${i + 1}/${reqs.length}]`)} ${cyan(title)}`);
      const cont = await askWithTimeout(`Decompor este requisito? [S/n/q]`, 's', 30);
      if (cont.toLowerCase() === 'q') break;
      if (cont.toLowerCase().startsWith('n')) continue;
      await runDecompose(api, projectId!, [r.id], `req ${i + 1}`, selectedCli, workspace);
    }
  }

  // ── Step 4: Audit + AUTO-FIX (fábrica autônoma) ──
  if (mode !== 0 && !isNaN(mode)) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${blue('4/4')} Auditoria de cobertura e correção automática`);
    console.log(dim('│'));

    // Pass-aware state:
    // - regeneratedThisRun: DUMs que foram fixados com sucesso (LLM sabe que não precisa re-flagar)
    // - createdThisRun: DUMs corretivos criados
    // - failedToRegenerate: DUMs que o LLM tentou fixar e falhou (não re-tentar no pass 2)
    const regeneratedThisRun = new Set<string>();
    const createdThisRun = new Set<string>();
    const failedToRegenerate = new Set<string>();

    const MAX_AUDIT_PASSES = 2;
    let previousWeakSignature = '';

    for (let pass = 1; pass <= MAX_AUDIT_PASSES; pass++) {
      const auditReport = await auditDumsPackage({
        api,
        projectId: projectId!,
        workspace,
        reqs,
        cli: selectedCli || 'claude',
        projectName: projectForDecomp?.name || projectName,
        stack: projectForDecomp?.stack,
        regeneratedThisRun,
        createdThisRun,
      });

      if (!auditReport) break;

      if (pass === 1) displayAuditReport(auditReport);

      // Filter out DUMs that already failed in previous passes — don't retry them
      const rawWeakDums = auditReport.weakDums || [];
      const weakDums = rawWeakDums.filter(w => !failedToRegenerate.has(w.dumNumber));
      const skipped = rawWeakDums.length - weakDums.length;
      if (skipped > 0) {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${dim(`Pulando ${skipped} DUMs que já falharam na passada anterior (intervenção manual necessária)`)}`);
      }

      const blockers = auditReport.blockers || [];
      const weakSignature = weakDums.map(w => w.dumNumber).sort().join(',');

      // Estável → sai
      if (weakDums.length === 0 && blockers.length === 0) {
        if (pass > 1) {
          console.log(dim('│'));
          console.log(`${dim('│')}  ${green('✓')} ${dim(`Pacote estabilizado após ${pass - 1} passada(s) de correção`)}`);
        }
        break;
      }

      // Sem progresso → sai (LLM não conseguiu melhorar os DUMs fracos)
      if (pass > 1 && weakSignature === previousWeakSignature) {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${yellow('⚠')} ${dim('Sem progresso — os DUMs fracos restantes precisam de intervenção manual')}`);
        break;
      }

      console.log(dim('│'));
      console.log(`${dim('│')}  ${cyan(`Passada ${pass}/${MAX_AUDIT_PASSES} — corrigindo automaticamente:`)}`);

      // 1. Regenera DUMs fracos (reescreve disco + backend via replace endpoint)
      if (weakDums.length > 0) {
        const attempted = new Set(weakDums.map(w => w.dumNumber));
        const regenResult = await regenerateWeakDums({
          api,
          projectId: projectId!,
          workspace,
          weakDums,
          reqs,
          cli: selectedCli || 'claude',
          projectName: projectForDecomp?.name || projectName,
          stack: projectForDecomp?.stack,
        });
        regenResult.regeneratedNumbers.forEach(n => {
          regeneratedThisRun.add(n);
          attempted.delete(n); // removed from "attempted" → only failures remain
        });
        // What wasn't successfully regenerated gets marked as failed
        attempted.forEach(n => failedToRegenerate.add(n));
      }

      // 2. Gera DUMs corretivos APENAS na passada 1
      if (pass === 1 && blockers.length > 0) {
        const fixResult = await generateCorrectiveDums({
          api,
          projectId: projectId!,
          workspace,
          blockers,
          reqs,
          cli: selectedCli || 'claude',
          projectName: projectForDecomp?.name || projectName,
          stack: projectForDecomp?.stack,
        });
        fixResult.createdNumbers.forEach(n => createdThisRun.add(n));
      }

      previousWeakSignature = weakSignature;

      if (pass === MAX_AUDIT_PASSES) {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${green('✓')} ${dim('Correção automática concluída')}`);
        if (failedToRegenerate.size > 0) {
          console.log(`${dim('│')}  ${yellow('⚠')} ${dim(`${failedToRegenerate.size} DUMs não puderam ser corrigidos automaticamente: ${Array.from(failedToRegenerate).sort().join(', ')}`)}`);
        }
      }
    }
  }

  // ── Cleanup workspace: restore original branch ──
  if (workspace) {
    cleanupWorkspace(workspace);
  }
  }
}
