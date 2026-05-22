import { swallow } from '../utils/log';
/**
 * execute.ts
 *
 * `makestudio execute` — full project execution with topological sort.
 *
 * Executes ALL pending tasks of a project in dependency order:
 *   1. Fetch all DUMs + tasks from backend
 *   2. Write/update .makestudio/context/memory/ files
 *   3. Topological sort (CONTRACTS DUM-002 always first)
 *   4. For each DUM (in order):
 *      a. Hard gate: skip if deps not complete
 *      b. Verify dep artifacts exist on disk
 *      c. For each task (sorted by type priority):
 *         - Build prompt with DUM desc + contracts context + accumulated files
 *         - Run via local CLI
 *         - Track new files via git diff
 *         - Mark task completed
 *      d. Integration checkpoint (SWC / flutter analyze)
 *   5. Summary
 *
 * Usage:
 *   makestudio execute
 *   makestudio execute --project-id <id>
 *   makestudio execute --project-id <id> --cli gemini
 *   makestudio execute --project-id <id> --skip-checkpoint
 *   makestudio execute --project-id <id> --only-dum DUM-003
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureAuthenticated } from '../network/auth';
import { getApiClient } from '../network/api-client';
import { detectInstalledCLIs, getCLICommand } from '../core/cli-detector';
import { printBanner } from '../utils/banner';
import chalk from 'chalk';
import * as readline from 'readline';
import { askProjectLocation } from '../core/workspace-resolver';
import { runValidators, detectStackNames } from '../core/validators';
import {
  saveLastRun,
  loadLastRun,
  clearLastRun,
  updateLastRun,
  lastRunAgeMinutes,
  LastRunState,
} from '../core/last-run';
import {
  buildPlanPrompt,
  planFilePath,
  readPlan,
  revertNonPlanChanges,
  ensurePlanFile,
  promptPlanApproval,
  openInEditor,
} from '../core/plan-mode';
import {
  buildReviewPrompt,
  ensureReviewFile,
  readReview,
  hasBlockingFindings,
  buildFixPrompt as buildReviewFixPrompt,
} from '../core/code-reviewer';
import {
  enterWorktreeForDum,
  exitWorktreeAndMerge,
  exitWorktreeAndDiscard,
  shouldIsolate,
  canEnterWorktree,
  WorktreeHandle,
} from '../core/worktree';
import { ExecuteOptions, InProgressEntry, InProgressFile, LocalCLIResult } from './execute-types';
import {
  readInProgressFile, writeInProgressFile, addInProgressTask, removeInProgressTask,
  recoverOrphanedTasks, writeExecutionState, saveArtifacts,
} from './execute-state';
import {
  hasApiErrorText, isBlockingValidationIssue, remediationHintForCode, ask,
  typeRank, extractNumericPart, TASK_TYPE_PRIORITY,
} from './execute-helpers';
import {
  topologicalSort, assertDependenciesComplete, verifyArtifactsOnDisk,
  getChangedFiles, getCurrentSha, runIntegrationCheckpoint,
} from './execute-deps';
import { buildTaskPrompt, buildContractsContext } from './execute-prompt';
import {
  generateAgentRulesFiles, ensureContextFiles, ensureToolchain, runLocalCLI,
} from './execute-toolchain';
import { isAbortRequested, resetAbort, setAbortRequested } from './execute-abort';
export { isAbortRequested, resetAbort, runLocalCLI };
export type { LocalCLIResult };

const bold   = chalk.bold;
const dim    = chalk.hex('#64748B');
const cyan   = chalk.hex('#22D3EE');
const green  = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');
const purple = chalk.hex('#A78BFA');

export async function executeCommand(options: ExecuteOptions = {}): Promise<void> {
  await ensureAuthenticated();
  const api = getApiClient();

  // Recover orphaned tasks from previous crashed runs before starting
  await recoverOrphanedTasks(api);

  if (!process.env.MAKESTUDIO_REPL) printBanner();
  console.log(`${bold(cyan('◆  makestudio execute'))} ${dim('— execução completa do projeto')}`);
  console.log(dim('│'));

  // ── 1. Pick project ─────────────────────────────────────────────
  let projectId = options.projectId;
  let projectName = '';
  let tenantId = '';

  if (!projectId) {
    try {
      const res = await api.get('/dark-factory/projects', { params: { limit: 50 }, timeout: 10_000 });
      const projects: any[] = res.data?.data || res.data?.projects || res.data || [];
      if (projects.length === 0) {
        console.log(`${dim('│')}  ${red('✗')}  Nenhum projeto encontrado. Use ${cyan('makestudio refine')} primeiro.`);
        return;
      }

      console.log(`${dim('│')}  Projetos disponíveis:`);
      console.log(dim('│'));
      projects.slice(0, 30).forEach((p: any, i: number) => {
        const hasSpec = p.specDocument?.enrichedAt ? green('✓ spec') : yellow('✗ spec');
        const statusLabel = dim(`· ${p.status || 'intake'}`);
        console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(p.name)} ${dim(`(${p.id.slice(0, 8)})`)}  ${hasSpec}  ${statusLabel}`);
      });
      console.log(dim('│'));

      const answer = await ask(`  Qual projeto executar? ${dim('[número]')}: `);
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= projects.length || isNaN(idx)) {
        console.log(`${dim('│')}  ${yellow('⚠')}  Seleção inválida, saindo.`);
        return;
      }
      projectId = projects[idx].id;
      projectName = projects[idx].name;
      tenantId = projects[idx].tenantId;
    } catch (err: any) {
      console.log(`${dim('│')}  ${red('✗')} Erro ao listar projetos: ${err.message}`);
      return;
    }
  }

  // ── 2. Fetch project metadata ────────────────────────────────────
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
    const proj = res.data;
    projectName = proj.name || projectName;
    tenantId = proj.tenantId || tenantId;
  } catch (err) { swallow(err); }

  console.log(`${dim('│')}  Projeto: ${bold(projectName)} ${dim(`[${projectId?.slice(0, 8)}]`)}`);

  // ── 3. Resolve workspace ─────────────────────────────────────────
  let projectMeta: any = {};
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
    projectMeta = res.data;
  } catch (err) { swallow(err); }

  const workspace = await askProjectLocation({
    projectId: projectId!,
    projectName,
    repoUrl: projectMeta?.repoUrl,
    repoBranch: projectMeta?.repoBranch,
    localPath: projectMeta?.metadata?.localPath,
  });

  if (!workspace.hasCodebase) {
    console.log(`${red('✗')} Diretório do projeto necessário para execução local.`);
    return;
  }

  const cwd = workspace.repoPath;
  console.log(`${dim('│')}  Diretório: ${dim(cwd)}`);

  // ── 3b. Offer resume if last-run.json exists ─────────────────────
  let resumeState: LastRunState | null = null;
  const lastRun = loadLastRun(cwd);
  const lastRunAge = lastRunAgeMinutes(cwd);
  if (
    lastRun &&
    lastRunAge !== null &&
    lastRunAge < 24 * 60 &&
    lastRun.projectId === projectId &&
    !options.onlyDum &&
    !options.dryRun
  ) {
    const ageLabel =
      lastRunAge < 60
        ? `${lastRunAge}min atrás`
        : `${Math.round(lastRunAge / 60)}h atrás`;
    console.log(dim('│'));
    console.log(`${dim('│')}  ${cyan('◇')} Última execução detectada ${dim(`(${ageLabel})`)}`);
    console.log(`${dim('│')}    modo: ${dim(lastRun.executionMode)}  ·  cli: ${dim(lastRun.cli)}`);
    if (lastRun.lastActiveDum) {
      console.log(`${dim('│')}    último DUM: ${dim(lastRun.lastActiveDum)}`);
    }
    if (lastRun.completedDums && lastRun.completedDums.length > 0) {
      console.log(`${dim('│')}    concluídos nesta run: ${dim(String(lastRun.completedDums.length))}`);
    }
    const ans = await ask(`  ${cyan('Continuar de onde parou?')} [S/n]: `);
    if (!ans.toLowerCase().startsWith('n')) {
      resumeState = lastRun;
      options.cli = options.cli || lastRun.cli;
      options.skipCheckpoint = options.skipCheckpoint ?? lastRun.skipCheckpoint;
      options.skipDoctor = options.skipDoctor ?? lastRun.skipDoctor;
      options.doctorDeep = options.doctorDeep ?? lastRun.doctorDeep;
      options.plan = options.plan ?? lastRun.plan;
      options.planDums = options.planDums ?? lastRun.planDums;
      options.skipReview = options.skipReview ?? lastRun.skipReview;
      options.reviewFix = options.reviewFix ?? lastRun.reviewFix;
      options.isolate = options.isolate ?? lastRun.isolate;
      options.isolateDums = options.isolateDums ?? lastRun.isolateDums;
      if (lastRun.onlyDum) options.onlyDum = lastRun.onlyDum;
      console.log(`${dim('│')}  ${green('✓')} Retomando com as mesmas escolhas`);
    } else {
      clearLastRun(cwd);
    }
  }

  // ── 4. Detect CLI ────────────────────────────────────────────────
  const availableCLIs = await detectInstalledCLIs();
  const availableCLINames = availableCLIs.map(c => c.name);
  let cli = options.cli || 'makestudio';
  if (!availableCLINames.includes(cli)) {
    const requested = options.cli ? `"${options.cli}"` : 'padrão ("makestudio")';
    console.log(`${red('✗')} CLI ${requested} não encontrado entre os instalados: [${availableCLINames.join(', ') || 'nenhum'}].`);
    console.log(`${yellow('!')} Informe o backend ou usuário: CLI solicitado não está disponível neste ambiente.`);
    return;
  }
  console.log(`${dim('│')}  CLI: ${cyan(cli.toUpperCase())}`);
  console.log(dim('│'));

  // ── 4b. Pre-flight: ensure toolchain is configured ───────────────
  await ensureToolchain(cwd);

  // ── 4c. Pre-flight: ensure context files exist ───────────────────
  await ensureContextFiles(cwd, projectId!, api, tenantId);

  // ── 4d. Pre-flight: write CLAUDE.md / AGENTS.md / GEMINI.md ──────
  await generateAgentRulesFiles(cwd);
  console.log(`${dim('│')}  ${green('✓')} Agent rules: CLAUDE.md, AGENTS.md, GEMINI.md`);

  // ── 5. Fetch all DUMs ────────────────────────────────────────────
  console.log(`${dim('│')}  ${dim('Buscando DUMs e tasks...')}`);
  let allDums: any[] = [];
  try {
    const res = await api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 15_000 });
    allDums = res.data?.dums || res.data || [];
  } catch (err: any) {
    console.log(`${red('✗')} Erro ao buscar DUMs: ${err.message}`);
    return;
  }

  if (allDums.length === 0) {
    console.log(`${red('✗')} Nenhum DUM encontrado. Use ${cyan('makestudio refine')} primeiro.`);
    return;
  }

  // ── 6. Fetch all tasks ───────────────────────────────────────────
  const tasksMap = new Map<string, any[]>();
  try {
    const res = await api.get(`/dark-factory/tasks/project/${projectId}`, { timeout: 15_000 });
    const allTasks: any[] = res.data?.tasks || res.data || [];
    for (const t of allTasks) {
      if (!tasksMap.has(t.dumId)) tasksMap.set(t.dumId, []);
      tasksMap.get(t.dumId)!.push(t);
    }
  } catch (err: any) {
    console.log(`${yellow('!')} Aviso: não foi possível buscar tasks: ${err.message}`);
  }

  // ── 7. Update context files on disk ─────────────────────────────
  console.log(`${dim('│')}  ${dim('Atualizando .makestudio/context/memory/...')}`);
  try {
    const memDir = path.join(cwd, '.makestudio', 'context', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    for (const dum of allDums) {
      const tasks = tasksMap.get(dum.id) || [];
      const dumWithTasks = { ...dum, tasks };
      const dumId = (dum.dumNumber || dum.id).toLowerCase().replace('-', '_');
      const slug = (dum.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const fileName = `${dumId}-${slug}.json`;
      fs.writeFileSync(path.join(memDir, fileName), JSON.stringify(dumWithTasks, null, 2));
    }
    writeExecutionState(cwd, allDums, tasksMap);
    console.log(`${dim('│')}  ${green('✓')} ${dim(`${allDums.length} DUMs escritos em .makestudio/context/memory/`)}`);
  } catch (err: any) {
    console.log(`${yellow('!')} Aviso ao escrever context files: ${err.message}`);
  }

  // ── 8. Topological sort ──────────────────────────────────────────
  const featureDums = allDums.filter(d => d.level >= 2);
  const sorted = topologicalSort(featureDums);

  // Filter by --only-dum if specified
  const dumsToExecute = options.onlyDum
    ? sorted.filter(d => d.dumNumber === options.onlyDum)
    : sorted;

  if (dumsToExecute.length === 0 && options.onlyDum) {
    console.log(`${red('✗')} DUM "${options.onlyDum}" não encontrado.`);
    return;
  }

  // Count pending
  const pendingDums = dumsToExecute.filter(d => {
    const tasks = tasksMap.get(d.id) || [];
    return tasks.some(t => !['completed', 'done'].includes(t.status));
  });

  // ── 9. Show execution plan + ask how to proceed ─────────────────
  const totalPendingTasks = pendingDums.reduce((sum, d) => {
    const ts = (tasksMap.get(d.id) || []).filter(t => !['completed', 'done'].includes(t.status));
    return sum + ts.length;
  }, 0);

  // ── Group pending DUMs into logical phases by type ─────────────
  // Each phase is a human-readable bucket of related work.
  type Phase = {
    key: string;
    label: string;
    description: string;
    types: string[];
    dums: any[];
    taskCount: number;
    estimateMin: number;
  };

  // Complexity-based time estimate per task (rough):
  //   low = 3min, medium = 8min, high = 15min (default medium if unknown)
  const estimateTaskMinutes = (task: any): number => {
    const c = (task.metadata?.complexity || task.complexity || 'medium').toLowerCase();
    if (c === 'low') return 3;
    if (c === 'high') return 15;
    return 8;
  };

  const PHASE_DEFS: Array<{ key: string; label: string; description: string; types: string[] }> = [
    { key: 'contracts', label: 'Fundação',        description: 'Contratos e tipos compartilhados',         types: ['contracts'] },
    { key: 'database',  label: 'Banco de dados',  description: 'Entidades, relações, migrations',          types: ['database'] },
    { key: 'backend',   label: 'API Backend',     description: 'Auth, CRUD, lógica de negócio',            types: ['backend'] },
    { key: 'integration', label: 'Integrações',   description: 'Chat, notificações, pagamentos externos',  types: ['integration', 'flow'] },
    { key: 'infra',     label: 'Infraestrutura',  description: 'Docker, CI/CD, observabilidade, deploy',   types: ['infra'] },
    { key: 'visual',    label: 'Interfaces',      description: 'Web e mobile — telas do usuário',          types: ['visual', 'frontend'] },
    { key: 'mixed',     label: 'Outros',          description: 'DUMs sem classificação clara',             types: ['mixed'] },
  ];

  const phases: Phase[] = PHASE_DEFS.map(def => {
    const dumsInPhase = pendingDums.filter(d => def.types.includes(d.type || 'mixed'));
    let taskCount = 0;
    let estimateMin = 0;
    for (const d of dumsInPhase) {
      const ts = (tasksMap.get(d.id) || []).filter(t => !['completed', 'done'].includes(t.status));
      taskCount += ts.length;
      for (const t of ts) estimateMin += estimateTaskMinutes(t);
    }
    return { ...def, dums: dumsInPhase, taskCount, estimateMin };
  }).filter(p => p.dums.length > 0);

  const fmtTime = (mins: number): string => {
    if (mins < 60) return `~${mins}min`;
    const h = Math.round(mins / 60 * 10) / 10;
    return `~${h}h`;
  };
  const totalEstimateMin = phases.reduce((s, p) => s + p.estimateMin, 0);

  console.log(dim('│'));
  console.log(`${dim('│')}  ${bold('Plano de construção')} ${dim(`— ${projectName}`)}`);
  console.log(dim('│'));
  console.log(`${dim('│')}    ${cyan(String(pendingDums.length))} módulos pendentes  ·  ${cyan(String(totalPendingTasks))} implementações  ·  ${cyan(fmtTime(totalEstimateMin))} estimadas`);
  if (dumsToExecute.length - pendingDums.length > 0) {
    console.log(`${dim('│')}    ${dim(`(${dumsToExecute.length - pendingDums.length} módulos já concluídos — serão pulados)`)}`);
  }
  console.log(dim('│'));
  console.log(`${dim('│')}  ${dim('Fases da construção:')}`);
  console.log(dim('│'));

  phases.forEach((phase, idx) => {
    const num = String(idx + 1).padEnd(2, ' ');
    const label = phase.label.padEnd(16, ' ');
    const count = `${String(phase.dums.length).padStart(3, ' ')} módulos`;
    const time = fmtTime(phase.estimateMin).padStart(6, ' ');
    console.log(`${dim('│')}    ${cyan(num)} ${bold(label)} ${dim(count)}  ${dim(time)}`);
    console.log(`${dim('│')}       ${dim(phase.description)}`);
  });

  // If user already picked --only-dum or --dry-run, skip the interactive menu
  let executionMode: 'all' | 'dry-run' | 'by-phase' | 'from-phase' | 'single' = 'all';
  let fromPhaseIdx = 0;

  if (resumeState) {
    executionMode = resumeState.executionMode;
    fromPhaseIdx = resumeState.fromPhaseIdx ?? 0;
  } else if (options.onlyDum) {
    executionMode = 'single';
  } else if (options.dryRun) {
    executionMode = 'dry-run';
  } else {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${cyan('Como proceder?')}`);
    console.log(dim('│'));
    console.log(`${dim('│')}    ${cyan('1)')} ${green('Construir tudo')} ${dim('(roda até o fim + auditoria final)')}`);
    console.log(`${dim('│')}    ${cyan('2)')} Construir por fase ${dim('(pausa entre fases pra revisar)')}`);
    console.log(`${dim('│')}    ${cyan('3)')} Começar de uma fase específica ${dim('(pula as anteriores)')}`);
    console.log(`${dim('│')}    ${cyan('4)')} Construir um módulo só ${dim('(pra testar)')}`);
    console.log(`${dim('│')}    ${cyan('5)')} Dry-run ${dim('(mostra cada task sem executar)')}`);
    console.log(`${dim('│')}    ${dim('0)')} ${dim('Cancelar')}`);
    console.log(dim('│'));

    const answer = await ask(`  Opção: `);
    const choice = parseInt(answer, 10);

    if (choice === 0 || isNaN(choice)) {
      console.log(`${dim('│')}  ${dim('Cancelado.')}`);
      return;
    } else if (choice === 2) {
      executionMode = 'by-phase';
    } else if (choice === 3) {
      console.log(dim('│'));
      const n = await ask(`  Começar de qual fase? ${dim(`(1–${phases.length})`)}: `);
      const idx = parseInt(n, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= phases.length) {
        console.log(`${dim('│')}  ${dim('Fase inválida, cancelando.')}`);
        return;
      }
      fromPhaseIdx = idx;
      executionMode = 'from-phase';
    } else if (choice === 4) {
      const num = await ask(`  Qual módulo? ${dim('(ex: DUM-024 ou 024)')}: `);
      const normalized = num.trim().toUpperCase().match(/\d+/)?.[0];
      if (!normalized) {
        console.log(`${dim('│')}  ${dim('Formato inválido, cancelando.')}`);
        return;
      }
      const targetNumber = `DUM-${normalized.padStart(3, '0')}`;
      const found = dumsToExecute.find(d => d.dumNumber === targetNumber);
      if (!found) {
        console.log(`${dim('│')}  ${red('✗')} ${targetNumber} não encontrado nos módulos pendentes.`);
        return;
      }
      options.onlyDum = targetNumber;
      executionMode = 'single';
    } else if (choice === 5) {
      executionMode = 'dry-run';
    }
    // choice === 1 → executionMode stays 'all'
  }

  // Apply mode to dumsToExecute
  const pauseBetweenPhases = executionMode === 'by-phase';

  if (executionMode === 'single' && options.onlyDum) {
    (dumsToExecute as any) = dumsToExecute.filter(d => d.dumNumber === options.onlyDum);
    if (dumsToExecute.length === 0) {
      console.log(`${dim('│')}  ${red('✗')} Módulo ${options.onlyDum} não encontrado.`);
      return;
    }
  } else if (executionMode === 'from-phase') {
    const skipped = phases.slice(0, fromPhaseIdx).flatMap(p => p.dums.map(d => d.id));
    const skippedSet = new Set(skipped);
    (dumsToExecute as any) = dumsToExecute.filter(d => !skippedSet.has(d.id));
    console.log(`${dim('│')}  ${dim(`Pulando ${skipped.length} módulos das ${fromPhaseIdx} fase(s) anteriores`)}`);
  } else if (executionMode === 'dry-run') {
    options.dryRun = true;
  }

  // Build a quick lookup: dumId → phase index (for pause-between-phases feature)
  const dumIdToPhaseIdx = new Map<string, number>();
  phases.forEach((p, i) => p.dums.forEach(d => dumIdToPhaseIdx.set(d.id, i)));

  console.log(dim('│'));
  const modeLabel = executionMode === 'dry-run' ? 'dry-run' :
                    executionMode === 'single' ? `1 módulo (${options.onlyDum})` :
                    executionMode === 'from-phase' ? `a partir da fase ${fromPhaseIdx + 1}` :
                    executionMode === 'by-phase' ? 'por fase (com pausas)' :
                    `${(dumsToExecute as any).length} módulos`;
  console.log(`${dim('│')}  ${green('▶')} Iniciando construção ${dim(`(${modeLabel})`)}`);
  console.log(dim('│'));

  // ── 9b. Persist run state so /resume can restore menu choices ────
  if (!options.dryRun) {
    const now = new Date().toISOString();
    const runState: LastRunState = resumeState ?? {
      version: 1,
      projectId: projectId!,
      projectName,
      cli,
      executionMode,
      fromPhaseIdx,
      onlyDum: options.onlyDum,
      skipCheckpoint: options.skipCheckpoint,
      skipDoctor: options.skipDoctor,
      doctorDeep: options.doctorDeep,
      plan: options.plan,
      planDums: options.planDums,
      skipReview: options.skipReview,
      reviewFix: options.reviewFix,
      isolate: options.isolate,
      isolateDums: options.isolateDums,
      startedAt: now,
      lastUpdatedAt: now,
      completedDums: [],
      totalDumsPlanned: (dumsToExecute as any).length,
    };
    if (!resumeState) saveLastRun(cwd, runState);
  }

  // ── 10. Execute DUMs ─────────────────────────────────────────────
  // Claude reads everything from disk via its own tools — we only write execution-state.json
  // after every DUM so it reflects reality between passes.

  // Announce active stack validators so the user knows which quality gates apply
  try {
    const stacks = detectStackNames(cwd);
    if (stacks.length > 0) {
      console.log(dim('│'));
      console.log(`${dim('│')}  ${dim(`Validators ativos: ${stacks.join(', ')}`)}`);
    }
  } catch (err) { swallow(err); }

  let totalTasksDone = 0;
  let totalTasksSkipped = 0;
  const errors: string[] = [];
  let currentPhaseIdx = -1;

  // Cross-DUM file tracking: what each DUM created in this run, so execution-state.json
  // persists the convention for future DUMs to read.
  const runFilesByDum: Record<string, string[]> = {};

  resetAbort();
  for (const dum of dumsToExecute) {
    if (isAbortRequested()) {
      console.log(`${dim('│')}`);
      console.log(`${dim('│')}  ${red('✗')} Execucao abortada pelo usuario (Ctrl+C)`);
      break;
    }

    const tasks = (tasksMap.get(dum.id) || []).filter(
      t => !['completed', 'done'].includes(t.status),
    );
    if (tasks.length === 0) {
      console.log(`${dim('│')}  ${dim('·')} ${dum.dumNumber} ${dim(dum.title)} — ${green('todas tasks concluídas')}`);
      continue;
    }

    // Phase transition banner (+ pause in by-phase mode)
    const dumPhaseIdx = dumIdToPhaseIdx.get(dum.id) ?? -1;
    if (dumPhaseIdx !== currentPhaseIdx && dumPhaseIdx >= 0) {
      if (currentPhaseIdx >= 0 && pauseBetweenPhases) {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${green('✓')} ${bold(`Fase ${currentPhaseIdx + 1} (${phases[currentPhaseIdx].label}) concluída`)}`);
        console.log(dim('│'));
        const cont = await ask(`  ${cyan('Continuar para a próxima fase?')} [S/n]: `);
        if (cont.toLowerCase().startsWith('n')) {
          console.log(`${dim('│')}  ${dim('Execução pausada pelo usuário.')}`);
          break;
        }
      }
      const phase = phases[dumPhaseIdx];
      console.log(dim('│'));
      console.log(`${dim('│')}  ${bold(`── FASE ${dumPhaseIdx + 1}/${phases.length}: ${phase.label} ─`.padEnd(70, '─'))}`);
      console.log(`${dim('│')}  ${dim(phase.description)} ${dim(`· ${phase.dums.length} módulos · ${fmtTime(phase.estimateMin)}`)}`);
      currentPhaseIdx = dumPhaseIdx;
    }

    console.log(`${dim('│')}`);
    console.log(`${dim('│')}  ${purple('◆')} ${bold(dum.dumNumber)} — ${dum.title}`);
    console.log(`${dim('│')}    ${dim(`tipo: ${dum.type || 'mixed'} · ${tasks.length} tasks pendentes`)}`);

    if (!options.dryRun) updateLastRun(cwd, { lastActiveDum: dum.dumNumber });

    // ── pre-dum hook ────────────────────────────────────────────
    try {
      const { runHooks } = require('../repl/hooks');
      await runHooks('pre-dum', { projectPath: cwd, dum: dum.dumNumber });
    } catch (err) { swallow(err); }

    // Capture git HEAD BEFORE the DUM runs — used later to compute "what changed"
    const dumBaseSha = getCurrentSha(cwd);

    // Hard gate: check dependencies
    const gate = await assertDependenciesComplete(dum, api);
    if (!gate.ok) {
      console.log(`${dim('│')}    ${red('✗ BLOQUEADO')} — dependências não resolvidas:`);
      for (const b of gate.blocking) {
        console.log(`${dim('│')}      ${dim('·')} ${b}`);
      }
      console.log(`${dim('│')}    ${dim('→ Pulando. Execute as dependências primeiro.')}`);
      totalTasksSkipped += tasks.length;
      continue;
    }

    // Disk check for deps
    const diskCheck = await verifyArtifactsOnDisk(dum, cwd, api);
    if (!diskCheck.ok) {
      console.log(`${dim('│')}    ${yellow('!')} Arquivos de contratos não encontrados no disco:`);
      for (const f of diskCheck.missing.slice(0, 5)) {
        console.log(`${dim('│')}      ${dim('·')} ${f}`);
      }
      console.log(`${dim('│')}    ${dim('→ Continuando mesmo assim — agent pode gerar os arquivos.')}`);
    }

    // Sort tasks by type priority
    const sortedTasks = [...tasks].sort((a, b) => {
      const pa = TASK_TYPE_PRIORITY[a.type] ?? 99;
      const pb = TASK_TYPE_PRIORITY[b.type] ?? 99;
      return pa - pb;
    });

    const accumulatedFiles: string[] = [];

    // ── Plan phase ────────────────────────────────────────────────
    // Trigger when --plan is set OR --plan-dums includes this DUM number.
    const planDumSet = new Set((options.planDums || '').split(',').map(s => s.trim()).filter(Boolean));
    const wantPlan = (options.plan || planDumSet.has(dum.dumNumber)) && !options.dryRun;
    if (wantPlan) {
      const planPath = ensurePlanFile(cwd, dum.dumNumber);
      const planRel = path.relative(cwd, planPath).replace(/\\/g, '/');
      console.log(`${dim('│')}    ${cyan('◇')} Plan mode: gerando plano em ${dim(planRel)}...`);

      const planPrompt = buildPlanPrompt(dum, sortedTasks, projectName, planRel);
      const planBaseSha = getCurrentSha(cwd);
      const planResult = await runLocalCLI(cli, planPrompt, cwd);
      if (!planResult || planResult.exitCode !== 0) {
        console.log(`${dim('│')}    ${yellow('!')} Plan phase falhou ou retornou erro — revertendo mudanças e pulando DUM`);
        revertNonPlanChanges(cwd, planRel, planBaseSha);
        continue;
      }

      // Revert any files the CLI touched outside the plan file (post-hoc
      // enforcement via git since the external CLI has no permission gate).
      const { reverted } = revertNonPlanChanges(cwd, planRel, planBaseSha);
      if (reverted.length > 0) {
        console.log(`${dim('│')}    ${dim(`(revertidas ${reverted.length} mudança(s) fora do plano)`)}`);
      }

      const planContent = readPlan(cwd, dum.dumNumber);
      if (!planContent || planContent.trim().length < 50) {
        console.log(`${dim('│')}    ${yellow('!')} Plano vazio ou muito curto — pulando DUM`);
        continue;
      }

      // Display + approve loop
      let approved = false;
      while (!approved) {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${bold(`Plano para ${dum.dumNumber}`)} ${dim(`(${planRel})`)}`);
        console.log(dim('│'));
        for (const ln of planContent.split('\n').slice(0, 60)) {
          console.log(`${dim('│')}    ${ln}`);
        }
        if (planContent.split('\n').length > 60) {
          console.log(`${dim('│')}    ${dim(`... (${planContent.split('\n').length - 60} linhas a mais em ${planRel})`)}`);
        }
        console.log(dim('│'));

        const decision = await promptPlanApproval();
        if (decision === 'skip') {
          console.log(`${dim('│')}    ${yellow('·')} plano rejeitado — DUM pulado`);
          break;
        }
        if (decision === 'edit') {
          openInEditor(planPath);
          // Re-read and loop
          const updated = readPlan(cwd, dum.dumNumber);
          if (updated) {
            console.log(`${dim('│')}    ${green('✓')} plano atualizado`);
          }
          continue;
        }
        approved = true;
      }
      if (!approved) {
        totalTasksSkipped += sortedTasks.length;
        continue;
      }
      console.log(`${dim('│')}    ${green('✓')} plano aprovado — iniciando implementação`);
      console.log(dim('│'));
    }

    if (options.dryRun) {
      console.log(`${dim('│')}    ${dim('[dry-run] tarefas que seriam executadas:')}`);
      for (const task of sortedTasks) {
        console.log(`${dim('│')}      ${dim('·')} ${task.title} ${dim(`[${task.type}]`)}`);
      }
      continue;
    }

    // ── Worktree isolation ────────────────────────────────────────
    // Activated per-DUM via --isolate flag or --isolate-dums list.
    // Creates <repo>/.makestudio/worktrees/<dum>/ on branch dum/<dum>,
    // switches the task loop to run there, then merges back on success.
    let worktreeHandle: WorktreeHandle | null = null;
    let dumCwd = cwd;
    if (shouldIsolate(dum.dumNumber, options) && !options.dryRun) {
      const check = canEnterWorktree(cwd);
      if (!check.ok) {
        console.log(`${dim('│')}    ${yellow('!')} Worktree indisponivel: ${check.reason} — rodando sem isolamento`);
      } else {
        try {
          worktreeHandle = enterWorktreeForDum(cwd, dum.dumNumber);
          dumCwd = worktreeHandle.worktreePath;
          console.log(`${dim('│')}    ${cyan('◇')} Worktree: ${dim(path.relative(cwd, dumCwd))}  branch ${dim(worktreeHandle.branch)}`);
        } catch (e: any) {
          console.log(`${dim('│')}    ${yellow('!')} Nao foi possivel criar worktree: ${e.message} — rodando sem isolamento`);
        }
      }
    }

    // Execute each task
    let consecutiveFailures = 0;
    for (let ti = 0; ti < sortedTasks.length; ti++) {
      // Check abort flag before each task
      if (isAbortRequested()) {
        console.log(`${dim('│')}    ${red('✗')} Execucao abortada pelo usuario (Ctrl+C)`);
        break;
      }

      const task = sortedTasks[ti];
      const taskNum = `${ti + 1}/${sortedTasks.length}`;

      console.log(`${dim('│')}    ${dim(`[${taskNum}]`)} ${task.title} ${dim(`[${task.type || 'feature'}]`)}`);
      if (!options.dryRun) updateLastRun(cwd, { lastActiveTask: task.title });

      // Mark task in_progress (best effort — bypass transition validation via PUT :id)
      try {
        await api.put(`/dark-factory/tasks/${task.id}`, { status: 'in_progress' }, { timeout: 5_000 });
      } catch (err) { swallow(err); }

      // Save task to in-progress recovery file before running CLI
      // If CLI crashes, the next run will revert this task to pending
      addInProgressTask(task.id, dum.id);

      // ── pre-task hook ─────────────────────────────────────────
      try {
        const { runHooks } = require('../repl/hooks');
        const hookRes = await runHooks('pre-task', {
          projectPath: cwd,
          task: task.title,
          dum: dum.dumNumber,
        });
        if (!hookRes.ok) {
          console.log(`${dim('│')}      ${yellow('!')} pre-task hook falhou: ${hookRes.failures.join('; ').substring(0, 150)}`);
        }
      } catch (err) { swallow(err); }

      const prompt = buildTaskPrompt(dum, task, '', accumulatedFiles, projectName);
      const result = await runLocalCLI(cli, prompt, dumCwd);

      // ── Consecutive failure detection ──────────────────────
      // If 3+ tasks fail in a row (auth error, CLI crash, etc.), abort the entire run.
      // Prevents wasting hours retrying when Claude auth is expired.
      const isAuthError = result?.output?.includes('does not have access') ||
        result?.output?.includes('Please login again') ||
        result?.output?.includes('Unauthorized') ||
        result?.output?.includes('invalid_api_key');
      const isFailure = !result || result.hasApiError || result.exitCode !== 0 || isAuthError;

      if (isFailure) {
        // If CLI did real work (tool calls > 5) but exited with error, retry ONCE
        // Common case: Claude created files but failed on `flutter analyze` at the end
        const didRealWork = result && result.toolCalls > 5 && !isAuthError && !result.hasApiError;
        if (didRealWork && !task._retried) {
          console.log(`${dim('│')}      ${yellow('!')} CLI fez trabalho (${result.toolCalls} tool calls) mas saiu com erro — tentando correcao...`);
          task._retried = true;

          const fixPrompt = `The previous attempt at this task created some files but exited with an error.
Check what files were created, verify they compile, and commit if everything is OK.

## Toolchain reminder
- Flutter/Dart: ALWAYS \`fvm dart analyze <path>\`. NEVER bare \`flutter\` or \`dart\`.
- TypeScript: \`npx swc <file> -d /tmp/swc-check --strip-leading-paths\`
- If files look correct and compile, just commit: git add -A && git commit -m "feat: [${dum.dumNumber}] ${task.title}"
- If files have errors, fix them, then commit.`;

          const retryResult = await runLocalCLI(cli, fixPrompt, dumCwd);
          if (retryResult && retryResult.exitCode === 0) {
            console.log(`${dim('│')}      ${green('✓')} Correcao aplicada com sucesso`);
            consecutiveFailures = 0;
            // Fall through to success path below (don't continue)
          } else {
            console.log(`${dim('│')}      ${red('✗')} Correcao tambem falhou — pulando task`);
            consecutiveFailures++;
            removeInProgressTask(task.id);
            try { await api.put(`/dark-factory/tasks/${task.id}`, { status: 'pending' }, { timeout: 5_000 }); } catch (err) { swallow(err); }
            if (consecutiveFailures >= 3) {
              console.log(`${dim('│')}\n${dim('│')}  ${red('✗ ABORTADO — 3 tasks consecutivas falharam.')}`);
              setAbortRequested(true);
              break;
            }
            continue;
          }
        } else {
          consecutiveFailures++;

          if (isAuthError) {
            console.log(`${dim('│')}      ${red('✗')} Erro de autenticacao do CLI — verifique suas credenciais`);
            errors.push(`${dum.dumNumber}: ${task.title} (auth error)`);
          } else if (!result) {
            console.log(`${dim('│')}      ${red('✗')} CLI nao retornou resultado — pulando`);
            errors.push(`${dum.dumNumber}: ${task.title}`);
          } else if (result.hasApiError) {
            console.log(`${dim('│')}      ${red('✗')} CLI retornou erro de API do provedor — task nao sera concluida`);
            errors.push(`${dum.dumNumber}: ${task.title} (provider api error)`);
          } else {
            console.log(`${dim('│')}      ${red('✗')} CLI retornou exit code ${result.exitCode} — task nao sera concluida`);
            errors.push(`${dum.dumNumber}: ${task.title} (cli exit ${result.exitCode})`);
          }

          removeInProgressTask(task.id);
          try {
            await api.put(`/dark-factory/tasks/${task.id}`, { status: 'pending' }, { timeout: 5_000 });
          } catch (err) { swallow(err); }

          if (consecutiveFailures >= 3) {
            console.log(`${dim('│')}`);
            console.log(`${dim('│')}  ${red('✗ ABORTADO — 3 tasks consecutivas falharam.')}`);
            if (isAuthError) {
              console.log(`${dim('│')}  ${red('  Causa: credenciais do CLI expiradas ou invalidas.')}`);
              console.log(`${dim('│')}  ${yellow('  Solucao: saia e execute "claude /login" ou verifique ANTHROPIC_API_KEY')}`);
            } else {
              console.log(`${dim('│')}  ${yellow('  Verifique os logs acima e tente novamente.')}`);
            }
            console.log(`${dim('│')}  ${dim('  Tasks pendentes foram revertidas. Execute novamente quando o problema for resolvido.')}`);
            setAbortRequested(true);
            break;
          }
          continue;
        }
      }

      // Success — reset consecutive failure counter
      consecutiveFailures = 0;

      // Capture new files (since DUM's base SHA + working tree)
      const newFiles = getChangedFiles(dumCwd, dumBaseSha);
      for (const f of newFiles) {
        if (!accumulatedFiles.includes(f)) accumulatedFiles.push(f);
      }

      // ── Stack-aware validation ──
      // Runs universal + stack-specific validators (Dart/Flutter, Java/Spring, ...).
      // CRITICAL issues trigger an auto-fix retry (max 1 attempt).
      // HIGH/MEDIUM/LOW are logged and persisted as audit artifacts.
      let validationWarnings = await runValidators({
        cwd: dumCwd,
        changedFiles: newFiles,
        task,
        dum,
      });

      // ── Auto-fix loop for CRITICAL violations ──────────────────────
      const criticalNow = validationWarnings.filter(w => w.severity === 'critical');
      if (criticalNow.length > 0) {
        console.log(`${dim('│')}      ${red('✗')} ${red(`${criticalNow.length} violations CRÍTICAS detectadas — auto-fix em andamento...`)}`);
        for (const w of criticalNow) {
          console.log(`${dim('│')}        ${red('✗')} ${dim(`[${w.code}]`)} ${w.message}${w.file ? dim(` @ ${w.file}`) : ''}`);
        }

        const fixDesc = criticalNow.map(w =>
          `[${w.code}] ${w.message}${w.file ? ` | file: ${w.file}` : ''}${w.evidence ? ` | ${w.evidence}` : ''}`,
        ).join('\n');

        // Build targeted fix prompt
        const multiClassIssues = criticalNow.filter(w => w.code === 'DART_MULTI_CLASS_FILE' || w.code === 'UNIVERSAL_MULTI_CLASS_TS');
        const fixPrompt = multiClassIssues.length > 0
          ? `You previously created files that bundle multiple classes — this violates Clean Architecture.

## Violations to fix:
${fixDesc}

## Required fix: SPLIT INTO ONE FILE PER CLASS

For each bundled file listed above, you MUST:
1. Read the current file content
2. Create ONE NEW FILE per class/interface/DTO/enum found inside it, using the correct naming convention:
   TypeScript (NestJS): UserDto → user.dto.ts, CreateUserDto → create-user.dto.ts, UserEntity → user.entity.ts
   Dart (Flutter): UserModel → user_model.dart, AppointmentDto → appointment_dto.dart
3. DELETE the original bundled file (it must not remain)
4. Update any barrel/index files (index.ts, contracts.dart) to export the new individual files

IMPORTANT:
- Do NOT add logic or change behavior — only split the file structure
- Maintain identical content per class (just move, don't modify)
- Each new file must have exactly ONE primary exported class/interface/enum/mixin
- Commit when done`
          : `Fix the following critical code quality issues:

## Issues to fix:
${fixDesc}

Fix all issues. Do not change behavior, only fix structure.
Commit when done.`;

        console.log(`${dim('│')}        ${dim('→ Executando fix...')}`);
        const fixJobId = `fix-${task.id}-${Date.now()}`;
        const fixResult = await runLocalCLI(cli, fixPrompt, dumCwd, fixJobId);
        if (!fixResult || fixResult.hasApiError) {
          console.log(`${dim('│')}        ${red('✗')} fix falhou por erro de API/execução`);
        }

        // Re-validate after fix
        const newFilesAfterFix = getChangedFiles(dumCwd, dumBaseSha);
        for (const f of newFilesAfterFix) {
          if (!accumulatedFiles.includes(f)) accumulatedFiles.push(f);
        }
        validationWarnings = await runValidators({
          cwd: dumCwd,
          changedFiles: newFilesAfterFix,
          task,
          dum,
        });
        const remainingCritical = validationWarnings.filter(w => w.severity === 'critical');
        if (remainingCritical.length > 0) {
          console.log(`${dim('│')}      ${red('✗')} ${red(`Auto-fix incompleto — ${remainingCritical.length} issues críticas persistem (continuando mesmo assim)`)}`);
        } else {
          console.log(`${dim('│')}      ${green('✓')} Auto-fix concluído — violations críticas resolvidas`);
        }
      }

      if (validationWarnings.length > 0) {
        // Group by severity for console display
        const critical = validationWarnings.filter(w => w.severity === 'critical');
        const high = validationWarnings.filter(w => w.severity === 'high');
        const medium = validationWarnings.filter(w => w.severity === 'medium');
        const low = validationWarnings.filter(w => w.severity === 'low');

        const color = critical.length > 0 ? red : high.length > 0 ? yellow : dim;
        console.log(`${dim('│')}      ${color('⚠')} ${color(`Validators — ${validationWarnings.length} issue(s):`)} ${dim(`(${critical.length} crit · ${high.length} high · ${medium.length} med · ${low.length} low)`)}`);
        for (const w of validationWarnings.slice(0, 8)) {
          const icon = w.severity === 'critical' ? red('✗') : w.severity === 'high' ? yellow('⚠') : dim('·');
          const tag = dim(`[${w.code}]`);
          const where = w.file ? dim(` @ ${w.file}${w.line ? ':' + w.line : ''}`) : '';
          console.log(`${dim('│')}        ${icon} ${tag} ${w.message}${where}`);
        }
        if (validationWarnings.length > 8) {
          console.log(`${dim('│')}        ${dim(`... e mais ${validationWarnings.length - 8} warnings`)}`);
        }

        // Persist as audit artifact — future refine audit loop will pick this up
        try {
          const serialized = validationWarnings.map(w =>
            `[${w.severity.toUpperCase()}] ${w.code}: ${w.message}${w.file ? ` (${w.file})` : ''}${w.evidence ? ` | ${w.evidence}` : ''}`,
          ).join('\n');
          await api.post('/dark-factory/artifacts', {
            projectId: projectId!,
            dumId: dum.id,
            taskId: task.id,
            type: 'AUDIT',
            title: `Validators — ${task.title}`,
            content: serialized,
            status: critical.length > 0 ? 'ERROR' : 'WARNING',
          }, {
            headers: { 'x-tenant-id': tenantId },
            timeout: 10_000,
          }).catch(() => { /* best effort */ });
        } catch (err) { swallow(err); }
      }

      const blockingIssues = validationWarnings.filter(isBlockingValidationIssue);
      if (blockingIssues.length > 0) {
        console.log(`${dim('│')}      ${red('✗')} ${red(`task bloqueada por ${blockingIssues.length} issue(s) estrutural(is)`)}`);
        const shownHints = new Set<string>();
        for (const issue of blockingIssues.slice(0, 5)) {
          const where = issue.file ? dim(` @ ${issue.file}${issue.line ? ':' + issue.line : ''}`) : '';
          console.log(`${dim('│')}        ${red('✗')} ${dim(`[${issue.code}]`)} ${issue.message}${where}`);
          const hint = remediationHintForCode(issue.code);
          if (hint && !shownHints.has(issue.code || '')) {
            console.log(`${dim('│')}          ${yellow('→')} ${dim(hint)}`);
            shownHints.add(issue.code || '');
          }
        }
        errors.push(`${dum.dumNumber}: ${task.title} (validator gate)`);
        removeInProgressTask(task.id);
        try {
          await api.put(`/dark-factory/tasks/${task.id}`, { status: 'pending' }, { timeout: 5_000 });
        } catch (err) { swallow(err); }
        continue;
      }

      // Mark task completed (via PUT to bypass transition chain)
      try {
        await api.put(`/dark-factory/tasks/${task.id}`, { status: 'completed' }, { timeout: 5_000 });
        // Remove from in-progress recovery file now that it completed successfully
        removeInProgressTask(task.id);
        console.log(`${dim('│')}      ${green('✓')} task concluída`);

        // ── post-task hook ────────────────────────────────────
        try {
          const { runHooks } = require('../repl/hooks');
          const newFiles = getChangedFiles(dumCwd, dumBaseSha);
          const hookRes = await runHooks('post-task', {
            projectPath: dumCwd,
            task: task.title,
            dum: dum.dumNumber,
            files: newFiles,
          });
          if (!hookRes.ok) {
            console.log(`${dim('│')}      ${yellow('!')} post-task hook falhou: ${hookRes.failures.join('; ').substring(0, 150)}`);
          }
        } catch (err) { swallow(err); }
      } catch {
        // Try status endpoint as fallback
        try {
          await api.put(`/dark-factory/tasks/${task.id}/status`, { status: 'completed' }, { timeout: 5_000 });
          removeInProgressTask(task.id);
        } catch (err) { swallow(err); }
      }

      totalTasksDone++;
    }

    // Save artifacts for this DUM (diff against DUM's base SHA + working-tree state)
    await saveArtifacts(api, dum, projectId!, tenantId, dumCwd, dumBaseSha);

    // Track files this DUM created in the run-wide map (persisted via execution-state.json
    // so the NEXT DUM can read it via its Read tool and learn the convention)
    const dumFiles = getChangedFiles(dumCwd, dumBaseSha);
    if (dumFiles.length > 0 && dum.dumNumber) {
      runFilesByDum[dum.dumNumber] = dumFiles;
    }

    // Update execution-state.json (with filesCreated per DUM + convention hints)
    const updatedTasksRes = await api.get(`/dark-factory/tasks/project/${projectId}`, { timeout: 10_000 }).catch(() => null);
    if (updatedTasksRes) {
      const updatedTasks: any[] = updatedTasksRes.data?.tasks || updatedTasksRes.data || [];
      tasksMap.clear();
      for (const t of updatedTasks) {
        if (!tasksMap.has(t.dumId)) tasksMap.set(t.dumId, []);
        tasksMap.get(t.dumId)!.push(t);
      }
      writeExecutionState(cwd, allDums, tasksMap, runFilesByDum);
    } else {
      // Even if tasks refetch failed, write state so Claude sees files created
      writeExecutionState(cwd, allDums, tasksMap, runFilesByDum);
    }

    // Post-DUM code review (see core/code-reviewer.ts)
    // Runs before compilation checkpoint so that spec-compliance violations
    // are caught even when the code happens to compile.
    // When isolated in a worktree, the review runs inside the worktree so
    // `git diff` sees the real changes; the review file is written there and
    // gets carried back on merge (or lost on discard — backend AUDIT is kept).
    const dumChangedFilesForReview = getChangedFiles(dumCwd, dumBaseSha);
    if (!options.skipReview && !options.dryRun && dumChangedFilesForReview.length > 0) {
      try {
        const reviewPath = ensureReviewFile(dumCwd, dum.dumNumber);
        const reviewRel = path.relative(dumCwd, reviewPath).replace(/\\/g, '/');
        console.log(`${dim('│')}    ${cyan('◇')} Code review: gerando relatório em ${dim(reviewRel)}...`);

        const reviewPrompt = buildReviewPrompt(dum, sortedTasks, dumCwd, dumBaseSha, reviewPath);
        const reviewResult = await runLocalCLI(cli, reviewPrompt, dumCwd);
        if (!reviewResult || reviewResult.exitCode !== 0) {
          console.log(`${dim('│')}    ${yellow('!')} Review CLI retornou erro — pulando review desta DUM`);
        } else {
          const report = readReview(dumCwd, dum.dumNumber);
          if (!report) {
            console.log(`${dim('│')}    ${yellow('!')} Review vazio — pulando`);
          } else {
            const blockingCount = report.findings.filter(f =>
              (f.severity === 'critical' || f.severity === 'high') && f.confidence >= 7,
            ).length;
            const icon = report.verdict === 'PASS' ? green('✓') : red('✗');
            console.log(`${dim('│')}    ${icon} Review: ${bold(report.verdict)} ${dim(`(${report.findings.length} findings, ${blockingCount} blocking)`)}`);
            for (const f of report.findings.slice(0, 5)) {
              const sevColor = f.severity === 'critical' ? red : f.severity === 'high' ? yellow : dim;
              const where = f.file ? dim(` @ ${f.file}${f.line ? ':' + f.line : ''}`) : '';
              console.log(`${dim('│')}      ${sevColor('•')} ${dim(`[${f.severity}]`)} ${f.description.substring(0, 100)}${where}`);
            }

            // Save as AUDIT artifact
            try {
              await api.post('/dark-factory/artifacts', {
                projectId: projectId!,
                dumId: dum.id,
                type: 'AUDIT',
                title: `Code Review — ${dum.dumNumber}`,
                content: report.rawMarkdown.substring(0, 10_000),
                status: report.verdict === 'PASS' ? 'APPROVED' : 'ERROR',
              }, {
                headers: { 'x-tenant-id': tenantId },
                timeout: 10_000,
              }).catch(() => { /* best effort */ });
            } catch (err) { swallow(err); }

            // Auto-fix loop if blocking findings and --review-fix
            if (hasBlockingFindings(report) && options.reviewFix) {
              console.log(`${dim('│')}    ${yellow('→')} Review-fix habilitado — agent vai corrigir findings bloqueantes...`);
              const fixPrompt = buildReviewFixPrompt(dum, report);
              const fixResult = await runLocalCLI(cli, fixPrompt, dumCwd);
              if (fixResult && fixResult.exitCode === 0) {
                console.log(`${dim('│')}    ${green('✓')} Review-fix concluído`);
              } else {
                console.log(`${dim('│')}    ${red('✗')} Review-fix falhou — findings permanecem no relatório`);
                errors.push(`review: ${dum.dumNumber}`);
              }
            } else if (hasBlockingFindings(report)) {
              errors.push(`review: ${dum.dumNumber} (blocking findings, use --review-fix to auto-correct)`);
            }
          }
        }
      } catch (err: any) {
        console.log(`${dim('│')}    ${yellow('!')} Erro no code review: ${err.message}`);
      }
    }

    // Integration checkpoint (FASE 4)
    if (!options.skipCheckpoint) {
      console.log(`${dim('│')}    ${dim('⚙ checkpoint de integração...')}`);
      const checkpoint = await runIntegrationCheckpoint(dum, dumCwd);
      if (!checkpoint.passed) {
        console.log(`${dim('│')}    ${yellow('!')} Checkpoint falhou — tentando auto-fix...`);
        const fixPrompt = `Fix compilation errors in the project.

## Errors to fix:
${checkpoint.errors}

Fix all errors. Do not change behavior — only fix type errors and missing imports.
After fixing, verify the files compile cleanly.
Commit with: git add -A && git commit -m "fix: [${dum.dumNumber}] resolve compilation errors"`;

        await runLocalCLI(cli, fixPrompt, dumCwd);

        const recheck = await runIntegrationCheckpoint(dum, dumCwd);
        if (recheck.passed) {
          console.log(`${dim('│')}    ${green('✓')} auto-fix bem-sucedido`);
        } else {
          console.log(`${dim('│')}    ${red('✗')} auto-fix não resolveu — continuando mesmo assim`);
          errors.push(`checkpoint: ${dum.dumNumber}`);
        }
      } else {
        console.log(`${dim('│')}    ${green('✓')} checkpoint OK`);
      }
    }

    // ── post-dum hook ──────────────────────────────────────────
    try {
      const { runHooks } = require('../repl/hooks');
      const dumFilesHook = getChangedFiles(dumCwd, dumBaseSha);
      await runHooks('post-dum', { projectPath: dumCwd, dum: dum.dumNumber, files: dumFilesHook });
    } catch (err) { swallow(err); }

    // ── Worktree exit: merge or discard ──────────────────────────
    // Success heuristic: this DUM did not add entries to `errors`. Uses
    // the prefix of the array before this DUM's own additions.
    if (worktreeHandle) {
      const dumHadErrors = errors.some(e =>
        e.includes(dum.dumNumber) ||
        e.includes(`review: ${dum.dumNumber}`) ||
        e.includes(`checkpoint: ${dum.dumNumber}`),
      );
      if (dumHadErrors) {
        console.log(`${dim('│')}    ${yellow('!')} Worktree preservada (branch ${worktreeHandle.branch}) — DUM teve erros, inspecione manualmente`);
      } else {
        const exit = exitWorktreeAndMerge(worktreeHandle);
        if (exit.ok) {
          console.log(`${dim('│')}    ${green('✓')} Worktree: ${exit.message}`);
        } else {
          console.log(`${dim('│')}    ${yellow('!')} Worktree: ${exit.message}`);
          errors.push(`worktree-merge: ${dum.dumNumber}`);
        }
      }
    }

    // Persist that this DUM is done (for resume of the NEXT DUM)
    if (!options.dryRun) {
      const current = loadLastRun(cwd);
      const already = current?.completedDums || [];
      if (dum.dumNumber && !already.includes(dum.dumNumber)) {
        updateLastRun(cwd, { completedDums: [...already, dum.dumNumber] });
      }
    }
  }

  // ── 11. Summary ──────────────────────────────────────────────────
  console.log(dim('│'));
  console.log(`${dim('│')}  ${bold('Resumo de execução:')}`);
  console.log(`${dim('│')}    ${green('✓')} ${totalTasksDone} tasks concluídas`);
  if (totalTasksSkipped > 0) {
    console.log(`${dim('│')}    ${yellow('·')} ${totalTasksSkipped} tasks puladas (DUMs bloqueados)`);
  }
  if (errors.length > 0) {
    console.log(`${dim('│')}    ${red('✗')} ${errors.length} erros:`);
    for (const e of errors.slice(0, 5)) {
      console.log(`${dim('│')}      ${dim('·')} ${e}`);
    }
  }
  console.log(dim('│'));

  // ── 12. Doctor (runtime smoke test with auto-fix) ───────────────
  if (!options.skipDoctor && !options.dryRun && totalTasksDone > 0) {
    try {
      const { runDoctor } = await import('../core/doctor');
      const doctorReport = await runDoctor({
        repoPath: cwd,
        cli,
        deep: options.doctorDeep,
        maxPasses: 3,
      });
      if (doctorReport.passed) {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${green('✓')} ${bold('Sistema verificado:')} todas as stacks sobem corretamente`);
      } else {
        console.log(dim('│'));
        console.log(`${dim('│')}  ${red('✗')} ${bold('Sistema não sobe:')} auto-fix não resolveu após 3 passadas`);
        console.log(`${dim('│')}  ${dim('Rode')} ${cyan('makestudio doctor')} ${dim('manualmente ou revise os erros acima')}`);
      }
    } catch (err: any) {
      console.log(`${dim('│')}  ${yellow('⚠')} Doctor falhou: ${err.message}`);
    }
  } else if (options.skipDoctor) {
    console.log(`${dim('│')}  ${dim('Doctor pulado (--skip-doctor)')}`);
  }

  console.log(dim('│'));
  if (totalTasksDone > 0) {
    console.log(`${dim('│')}  ${green('✓')} Execução concluída! Use ${cyan('makestudio status')} para acompanhar.`);
  } else {
    console.log(`${dim('│')}  ${dim('Nenhuma task nova foi executada.')}`);
  }

  // Clear last-run on clean finish (no aborts, no errors that block future runs)
  if (!options.dryRun && !isAbortRequested() && errors.length === 0) {
    clearLastRun(cwd);
  }

  console.log(dim('╰─'));
}
