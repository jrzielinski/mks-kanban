import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureAuthenticated } from '../network/auth';
import { getApiClient } from '../network/api-client';
import { getCLICommand } from '../core/cli-detector';
import { detectInstalledCLIs } from '../core/cli-detector';
import { enqueue } from '../core/offline-queue';
import { saveProjectLink } from '../core/project-prep';
import { findBestBoilerplate, copyBoilerplate } from '../core/boilerplate-registry';
import { logInfo, logSuccess, logError, logWarning, logTool } from '../ui/terminal';
import chalk from 'chalk';

import { swallow } from '../utils/log';
// ── CodebaseAnalysis JSON shape ──────────────────────────
export interface CodebaseAnalysis {
  name: string;
  stack: {
    backend?: string[];
    frontend?: string[];
    mobile?: string[];
    database?: string[];
    infra?: string[];
  };
  dependencies: string[];
  entities: Array<{
    name: string;
    fields: string[];
    file: string;
  }>;
  endpoints: Array<{
    method: string;
    path: string;
    file: string;
    description?: string;
  }>;
  components: Array<{
    name: string;
    file: string;
    type?: string;
  }>;
  patterns: string[];
  description: string;
  summary: string;
}

// ── Analyze prompt sent to the AI CLI ────────────────────


// ── Audit prompt ─────────────────────────────────────────

// ── Heartbeat — prints status every 60s of silence ───────
// ── Progress parsing for stream-json ─────────────────────


// ── Helper: build prompt for requirements generation ─────────────────────────

// ── Helper: extract requirements array from CLI output ────────────────────────

// ── Generate requirements for new project using local AI CLI ─────────────────

/**
 * Called when the project has no code yet (new project from DarkFactory interview).
 * Synthesizes a CodebaseAnalysis from the project's briefing + stack stored in the backend,
 * scaffolds a git repo at targetPath, and saves the localPath back to the project.
 */

export async function analyzeCommand(options: {
  path?: string;
  deep?: boolean;
  audit?: boolean;
  cli?: string;
  projectId?: string;
  force?: boolean;
}): Promise<void> {
  const targetPath = options.path
    ? path.resolve(options.path)
    : process.cwd();

  // Validate directory
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    logError(`Directory not found: ${targetPath}`);
    process.exit(1);
  }

  // Check for code indicators
  const codeIndicators = [
    'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
    'pom.xml', 'build.gradle', 'composer.json', 'Gemfile',
    'pyproject.toml', 'setup.py', 'CMakeLists.txt', 'Makefile',
    'src', 'lib', 'app',
  ];
  const hasCode = codeIndicators.some((f) =>
    fs.existsSync(path.join(targetPath, f)),
  );
  if (!hasCode) {
    if (options.projectId) {
      // New project with no code yet — synthesize analysis from backend briefing + stack
      await analyzeNewProject(targetPath, options.projectId);
      return;
    }
    logWarning(`No code project detected in ${targetPath}`);
    logWarning('Expected: package.json, requirements.txt, go.mod, src/, etc.');
    process.exit(1);
  }

  const isCombo = !!(options.deep && options.audit);

  if (await tryResumeFromCache(targetPath, options)) return;

  logInfo(`Analyzing project at: ${targetPath}`);
  logInfo(`Mode: ${isCombo ? 'deep + audit' : options.audit ? 'audit' : options.deep ? 'deep' : 'standard'}`);

  // Detect CLI
  const clis = await detectInstalledCLIs();
  const preferredCli = options.cli || 'claude';
  const cliInfo = clis.find((c) => c.name === preferredCli) || clis[0];

  if (!cliInfo) {
    logError('No AI CLI found. Install claude, codex, or gemini.');
    process.exit(1);
  }

  logInfo(`Using CLI: ${cliInfo.name} v${cliInfo.version}`);

  await runAnalysisPipeline(targetPath, options, isCombo, cliInfo, Date.now());
}

/**
 * If a recent cache exists for the target path, resume from it (send
 * to project, generate requirements if missing) and return true so
 * the caller short-circuits. Returns false when no cache or when the
 * `--force` flag is set.
 */
async function tryResumeFromCache(
  targetPath: string,
  options: { force?: boolean; projectId?: string },
): Promise<boolean> {
// ── Cache resume ────────────────────────────────────────
if (!options.force) {
  let cached = readCache(targetPath);

  // If no local cache, check if the agent's temp file is recent (< 24h)
  if (!cached) {
    const TEMP_FILE = '/tmp/codebase_analysis.json';
    if (fs.existsSync(TEMP_FILE)) {
      try {
        const stat = fs.statSync(TEMP_FILE);
        const ageH = (Date.now() - stat.mtimeMs) / 3600000;
        if (ageH < 24) {
          const parsed = JSON.parse(fs.readFileSync(TEMP_FILE, 'utf-8'));
          if (parsed?.name) {
            cached = parsed;
            // Promote to local cache
            saveCache(targetPath, cached!);
            logInfo(`Cache promovido de ${TEMP_FILE} → ${getCachePath(targetPath)}`);
          }
        }
      } catch (err) { swallow(err); }
    }
  }

  if (cached) {
    const cachePath = getCachePath(targetPath);
    const stat = fs.statSync(cachePath);
    const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
    const ageStr = ageMin < 60 ? `${ageMin}min atrás` : `${Math.round(ageMin / 60)}h atrás`;
    console.log();
    logSuccess(`Cache encontrado (${ageStr}) — pulando análise do agente`);
    logInfo(`  ${getCachePath(targetPath)}`);
    logInfo(`  Use --force para forçar nova análise`);
    console.log();
    if (options.projectId) {
      await sendToProject(cached, options.projectId);

      // If the project has no requirements yet, generate them now.
      // This happens when analyzeNewProject() ran before, saved the cache,
      // but requirements generation failed or was interrupted.
      try {
        const api = getApiClient();
        const projectRes = await api.get(`/dark-factory/projects/${options.projectId}`);
        const project = projectRes.data;
        const reqRes = await api.get(`/dark-factory/analyst/requirements/${options.projectId}`);
        const existingCount = reqRes.data?.total ?? reqRes.data?.requirements?.length ?? (Array.isArray(reqRes.data) ? reqRes.data.length : 0);

        if (existingCount === 0 && (project.status === 'intake' || project.currentPhase === 'analyst_understanding')) {
          logInfo(`Sem requisitos no projeto — gerando agora...`);
          const generatedCount = await generateRequirementsWithCLI(project, targetPath, options.projectId);
          await api.post(`/dark-factory/projects/${options.projectId}/notify-analysis-complete`, {
            requirementsCreated: generatedCount,
          });
          if (generatedCount > 0) {
            logSuccess(`${generatedCount} requisito(s) gerado(s). Pipeline avançado.`);
          }
        }
      } catch (err: any) {
        logWarning(`Não foi possível verificar/gerar requisitos: ${err.message}`);
      }
    } else {
      // Cache resume: only update existing project, never create a new one.
      // If the user deleted the project, respect that decision.
      await importProjectUpdateOnly(cached, targetPath);
    }
    return true;
  }
}
  return false;
}

/**
 * Run the analysis pipeline (combo mode = deep + audit, or single
 * deep / audit / standard) and surface results. Save cache + send to
 * backend at the end.
 */
async function runAnalysisPipeline(
  targetPath: string,
  options: { deep?: boolean; audit?: boolean; projectId?: string; cli?: string },
  isCombo: boolean,
  cliInfo: { name: string; version: string },
  startTime: number,
): Promise<void> {

// Combo mode: run two sequential passes instead of one combined prompt
if (isCombo) {
  logInfo(chalk.bold('Passada 1/2 — Análise estrutural...'));
  console.log(chalk.hex('#FBBF24')('  Detectando entities, endpoints, componentes e padrões.\n'));
  const deepResult = await runSinglePass(targetPath, DEEP_ANALYZE_PROMPT, '30', cliInfo, options);
  let analysisJson: CodebaseAnalysis | null = null;
  try {
    analysisJson = extractJson(deepResult.output, deepResult.startTime);
    console.log();
    console.log(chalk.hex('#22D3EE').bold('  ─── ANALYSIS RESULTS ───'));
    console.log();
    logSuccess(`Projeto: ${chalk.bold(analysisJson.name || 'Unknown')}`);
    if (analysisJson.stack) {
      const parts: string[] = [];
      if (analysisJson.stack.backend?.length) parts.push(`Backend: ${analysisJson.stack.backend.join(', ')}`);
      if (analysisJson.stack.frontend?.length) parts.push(`Frontend: ${analysisJson.stack.frontend.join(', ')}`);
      if (analysisJson.stack.database?.length) parts.push(`Database: ${analysisJson.stack.database.join(', ')}`);
      if (analysisJson.stack.mobile?.length) parts.push(`Mobile: ${analysisJson.stack.mobile.join(', ')}`);
      if (analysisJson.stack.infra?.length) parts.push(`Infra: ${analysisJson.stack.infra.join(', ')}`);
      for (const p of parts) logInfo(p);
    }
    console.log();
    if (analysisJson.entities?.length) logInfo(`${chalk.bold(String(analysisJson.entities.length))} entities detectadas`);
    if (analysisJson.endpoints?.length) logInfo(`${chalk.bold(String(analysisJson.endpoints.length))} endpoints detectados`);
    if (analysisJson.components?.length) logInfo(`${chalk.bold(String(analysisJson.components.length))} componentes detectados`);
  } catch (err: any) {
    logError(`Falha ao parsear análise estrutural: ${err.message}`);
  }

  console.log();
  logInfo(chalk.bold('Passada 2/2 — Auditoria de segurança e qualidade...'));
  console.log(chalk.hex('#FBBF24')('  Segurança, qualidade, testes, performance, arquitetura.\n'));
  const auditResult = await runSinglePass(targetPath, AUDIT_PROMPT, '50', cliInfo, options);
  let auditJson: any = null;
  try {
    auditJson = extractJson(auditResult.output, auditResult.startTime);
    showAuditResults(auditJson);
  } catch (err: any) {
    logError(`Falha ao parsear auditoria: ${err.message}`);
  }

  // Save cache and send to backend
  if (analysisJson) {
    saveCache(targetPath, analysisJson);
    if (options.projectId) {
      await sendToProject(analysisJson, options.projectId);
    } else {
      await importProject(analysisJson, targetPath);
    }
  }
  if (auditJson) {
    // Find project ID (either explicit or just created)
    let targetProjectId = options.projectId;
    if (!targetProjectId) {
      try {
        await ensureAuthenticated();
        const api = getApiClient();
        const res = await api.get('/dark-factory/projects');
        const projects = Array.isArray(res.data) ? res.data : res.data?.data || [];
        const existing = projects.find((p: any) => p.metadata?.localPath === targetPath);
        if (existing) targetProjectId = existing.id;
      } catch (err) { swallow(err); }
    }
    if (targetProjectId) {
      await sendAuditToProject(auditJson, targetProjectId);
    }
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const totalCost = (deepResult.cost + auditResult.cost).toFixed(4);
  console.log();
  logSuccess(`Completo em ${totalElapsed}s (${deepResult.toolCalls + auditResult.toolCalls} tool calls, $${totalCost})`);
  return;
}

// Single mode: deep OR audit OR standard
const prompt = options.audit ? AUDIT_PROMPT : options.deep ? DEEP_ANALYZE_PROMPT : ANALYZE_PROMPT;
const maxTurns = options.audit ? '50' : '30';
const cliCmd = getCLICommand(cliInfo.name);

const args: string[] = [];
// claude stream-json AND makestudio jsonl both need line-buffered parsing.
// Without this, the parent shows nothing during the multi-minute tool loop
// and the user thinks it's stuck.
const isStreamJson = cliInfo.name === 'claude' || cliInfo.name === 'makestudio'
  || cliInfo.name === 'self' || cliInfo.name === 'ms';
// makestudio reads its prompt from argv (positional), not stdin — appended below.
const isMakestudio = cliInfo.name === 'makestudio' || cliInfo.name === 'self' || cliInfo.name === 'ms';

if (cliInfo.name === 'claude') {
  // Use stream-json for real-time progress
  args.push('-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-turns', maxTurns);
} else if (cliInfo.name === 'codex') {
  args.push('exec', '--full-auto');
} else if (cliInfo.name === 'gemini') {
  args.push('-y');
} else if (isMakestudio) {
  // makestudio self-spawn: --json gives JSONL stream of every tool call,
  // info, log, and the final assistant text. Without -p the binary opens
  // the Ink REPL and hangs forever waiting for a TTY that doesn't exist
  // here (stdio is `pipe`). No --max-turns — inner runHeadless defaults
  // to 200, which is what the analysis prompt actually needs to finish.
  // Earlier `--max-turns N` (mirroring claude's cap) cut the loop short
  // and the produced output regressed from 25-35KB DUMs to 8KB stubs.
  args.push('-p', '--yes', '--json');
}

console.log();
if (options.audit) {
  logInfo(chalk.bold('Iniciando AUDITORIA da codebase...'));
  console.log(chalk.hex('#FBBF24')('  Segurança, qualidade, testes, performance, arquitetura.\n'));
} else {
  logInfo(chalk.bold('Iniciando análise da codebase...'));
  console.log(chalk.hex('#FBBF24')('  O progresso será exibido conforme a IA lê o código.\n'));
}

let toolCallCount = 0;
let singleCost = 0;

const heartbeat = startHeartbeat(startTime, () => ({ toolCalls: toolCallCount, cost: singleCost }));

const analysis = await new Promise<string>((resolve, reject) => {
  let allOutput = '';
  let resultText = '';
  let errorOutput = '';
  let lineBuffer = '';

  // makestudio: prompt goes on argv (positional), stdin stays empty.
  // claude/codex/gemini: prompt goes on stdin.
  const finalArgs = isMakestudio ? [...args, prompt] : args;
  const proc = spawn(cliCmd, finalArgs, {
    cwd: targetPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    allOutput += chunk;
    heartbeat.markActivity();

    if (isStreamJson) {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const result = parseStreamLine(line, startTime, (cost) => { singleCost = cost; });
        if (result?.resultText) resultText = result.resultText;
        if (line.includes('"tool_use"') || line.includes('"[tool]"')) toolCallCount++;
      }
    } else {
      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 3 && trimmed.length < 300) logInfo(trimmed);
      }
    }
  });

  // makestudio --json puts info/log/error on STDERR. Parse it to surface
  // tool calls + progress in real time.
  let stderrBuffer = '';
  proc.stderr.on('data', (data: Buffer) => {
    const chunk = data.toString();
    errorOutput += chunk;
    if (!isStreamJson) return;
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      const result = parseStreamLine(line, startTime, (cost) => { singleCost = cost; });
      if (result?.hadActivity) heartbeat.markActivity();
      if (line.includes('"tool_use"') || line.includes('[tool]')) toolCallCount++;
    }
  });

  proc.on('close', (code) => {
    heartbeat.stop();
    if (stderrBuffer.trim()) {
      parseStreamLine(stderrBuffer, startTime, (cost) => { singleCost = cost; });
    }
    if (lineBuffer.trim()) {
      const result = parseStreamLine(lineBuffer, startTime, (cost) => { singleCost = cost; });
      if (result?.resultText) resultText = result.resultText;
    }
    if (code !== 0) {
      reject(new Error(`CLI exited with code ${code}: ${errorOutput.slice(0, 500)}`));
    } else {
      resolve(resultText || allOutput);
    }
  });

  proc.on('error', (err) => { heartbeat.stop(); reject(err); });

  if (!isMakestudio) {
    proc.stdin.write(prompt);
  }
  proc.stdin.end();
});

console.log();
const elapsed = Math.round((Date.now() - startTime) / 1000);
logInfo(`Completed in ${elapsed}s with ${toolCallCount} tool calls`);

// Extract JSON from output
let resultJson: any;
try {
  resultJson = extractJson(analysis, startTime);
} catch (err: any) {
  logError(`Failed to parse JSON: ${err.message}`);
  logError('Raw output (first 2000 chars):');
  console.log(chalk.gray(analysis.slice(0, 2000)));
  process.exit(1);
}

// ── AUDIT MODE: show audit results ──
if (options.audit) {
  showAuditResults(resultJson);

  // Send to backend
  if (options.projectId) {
    await sendAuditToProject(resultJson, options.projectId);
  } else {
    await importAudit(resultJson, targetPath);
  }
  return;
}

// ── STANDARD MODE: show structural analysis ──
const analysisJson: CodebaseAnalysis = resultJson;

// Show summary
console.log();
console.log(chalk.cyan.bold('  ─── ANALYSIS RESULTS ───'));
console.log();
logSuccess(`Project: ${chalk.bold(analysisJson.name)}`);

if (analysisJson.stack) {
  const parts: string[] = [];
  if (analysisJson.stack.backend?.length) parts.push(`Backend: ${analysisJson.stack.backend.join(', ')}`);
  if (analysisJson.stack.frontend?.length) parts.push(`Frontend: ${analysisJson.stack.frontend.join(', ')}`);
  if (analysisJson.stack.database?.length) parts.push(`Database: ${analysisJson.stack.database.join(', ')}`);
  if (analysisJson.stack.mobile?.length) parts.push(`Mobile: ${analysisJson.stack.mobile.join(', ')}`);
  if (analysisJson.stack.infra?.length) parts.push(`Infra: ${analysisJson.stack.infra.join(', ')}`);
  for (const p of parts) logInfo(p);
}

console.log();
if (analysisJson.entities?.length) logInfo(`${chalk.bold(String(analysisJson.entities.length))} entities detected`);
if (analysisJson.endpoints?.length) logInfo(`${chalk.bold(String(analysisJson.endpoints.length))} endpoints detected`);
if (analysisJson.components?.length) logInfo(`${chalk.bold(String(analysisJson.components.length))} components detected`);
if (analysisJson.patterns?.length) logInfo(`Patterns: ${analysisJson.patterns.join(', ')}`);

if (analysisJson.description) {
  console.log();
  console.log(chalk.gray(`  ${analysisJson.description}`));
}

console.log();

// Save cache
saveCache(targetPath, analysisJson);

// If --project-id provided, send to existing project
if (options.projectId) {
  await sendToProject(analysisJson, options.projectId);
  return;
}

// Otherwise, create new project via import endpoint
await importProject(analysisJson, targetPath);
}

// ── Audit display ────────────────────────────────────────

// ── Send audit to existing project ───────────────────────

// ── Import audit — find existing project by localPath or create new ──


// Used on cache-resume: only updates if project already exists, never creates new.



// ── Single pass executor (used by combo mode) ───────────
// ── Helpers ──────────────────────────────────────────────



import { getConfigDir } from '../config/config';
import { ANALYZE_PROMPT, DEEP_ANALYZE_PROMPT, AUDIT_PROMPT } from './analyze-prompts';
import { startHeartbeat, parseStreamLine, runSinglePass } from './analyze-cli';
import { getCachePath, readCache, saveCache } from './analyze-cache';
import { buildRequirementsPrompt, extractRequirementsFromOutput, generateRequirementsWithCLI, analyzeNewProject } from './analyze-requirements';
import { showAuditResults } from './analyze-display';
import { sendToProject, importProject, importProjectUpdateOnly, sendAuditToProject, importAudit, isNetworkError, saveResultLocally } from './analyze-import';
import { extractJson } from './analyze-extract';

