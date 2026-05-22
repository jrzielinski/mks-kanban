import { swallow } from '../utils/log';
/**
 * project-prep.ts
 *
 * Automatic project preparation when `makestudio start` runs in a project directory.
 * Checks if the linked MakeStudio project has all context it needs and fills any gaps.
 *
 * Preparation steps (each is idempotent — safe to re-run):
 *   1. Find or link the MakeStudio project for this directory
 *   2. Check if codebase analysis exists → run `makestudio analyze --deep` if missing
 *   3. Check if boilerplateId is set → auto-detect from package.json/pubspec.yaml if missing
 *   4. Save project link to .makestudio/project.json for subsequent runs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logSuccess, logWarning, logError } from '../ui/terminal';
import { getRepoRemoteUrl } from './git-ops';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => { rl.question(question, a => { rl.close(); resolve(a.trim()); }); });
}

// ── ANSI helpers ──────────────────────────────────────────────────
function c(text: string, code: number) { return `\x1b[${code}m${text}\x1b[0m`; }
const bold  = (t: string) => c(t, 1);
const dim   = (t: string) => c(t, 2);
const green = (t: string) => c(t, 32);
const cyan  = (t: string) => c(t, 36);
const yellow = (t: string) => c(t, 33);

const PROJECT_LINK_FILE = '.makestudio/project.json';

// ── Local project link (persisted in repo dir) ────────────────────

export interface ProjectLink {
  projectId: string;
  projectName: string;
  linkedAt: string;
  serverUrl?: string;
}

export function readProjectLink(repoPath: string): ProjectLink | null {
  try {
    const file = path.join(repoPath, PROJECT_LINK_FILE);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectLink;
  } catch { return null; }
}

export function saveProjectLink(repoPath: string, link: ProjectLink): void {
  try {
    const dir = path.join(repoPath, '.makestudio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(link, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

// ── Boilerplate auto-detection from project structure ─────────────

export function detectBoilerplateFromStructure(repoPath: string): string | null {
  const has = (p: string) => fs.existsSync(path.join(repoPath, p));

  const hasBackend = has('api') || has('backend') || has('server');
  const hasFrontend = has('web') || has('frontend') || has('client');
  const hasMobile = has('app') || has('mobile') || has('flutter');
  const hasPubspec = has('app/pubspec.yaml') || has('mobile/pubspec.yaml') || has('pubspec.yaml');
  const hasNestBackend = has('api/src/main.ts') || has('backend/src/main.ts') || has('src/main.ts');
  const hasReactFrontend = has('web/src') || has('frontend/src') || has('src/App.tsx') || has('src/App.jsx');
  const hasDockerCompose = has('docker-compose.yml') || has('docker-compose.yaml');

  // Detect from package.json
  let pkgName = '';
  for (const pkgPath of ['api/package.json', 'backend/package.json', 'package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, pkgPath), 'utf8'));
      pkgName = pkg.name || '';
      break;
    } catch (err) { swallow(err); }
  }

  // Level 13: backend + frontend + mobile (our fullstack-mobile boilerplate)
  if (hasBackend && hasFrontend && (hasMobile || hasPubspec)) return 'fullstack-mobile';
  // Level 10-12: enterprise/ecommerce/marketplace with separate repos
  if (hasBackend && hasFrontend && hasDockerCompose && hasNestBackend) {
    if (pkgName.includes('enterprise') || has('api/src/tenants')) return 'saas-enterprise';
    if (pkgName.includes('ecommerce') || pkgName.includes('marketplace')) return 'e-commerce';
    return 'saas-multitenant';
  }
  // Level 9: mobile only
  if (hasMobile && hasPubspec && !hasBackend && !hasFrontend) return 'mobile-app';
  // Level 7-8: saas
  if (hasBackend && hasFrontend) return 'saas-starter';
  // Level 5: fullstack simple
  if (hasBackend && hasReactFrontend) return 'fullstack-simple';
  // Level 4: api only
  if (hasNestBackend && !hasFrontend) return 'api-minimal';
  // Level 2: SPA
  if (hasReactFrontend && !hasBackend) return 'spa-frontend';

  return null;
}

// ── Run analysis subprocess ───────────────────────────────────────

async function runDeepAnalysis(repoPath: string, projectId: string, cliName: string): Promise<void> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const ticker = setInterval(() => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      process.stdout.write(`\r  ${dim('⏳')} Analisando codebase com ${cyan(cliName.toUpperCase())}... ${dim(`${s}s`)}   `);
    }, 2_000);

    // Spawn `makestudio analyze --deep --project-id <id> --cli <cli>`
    const agentBin = process.argv[1]; // path to current makestudio script
    const args = ['analyze', '--deep', '--project-id', projectId, '--cli', cliName];

    const proc = spawn(process.execPath, [agentBin, ...args], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        process.stdout.write(`\r  ${dim('·')} ${dim(line.substring(0, 100))}\n`);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        process.stdout.write(`\r  ${yellow('!')} ${dim(line.substring(0, 100))}\n`);
      }
    });

    proc.on('close', (code) => {
      clearInterval(ticker);
      process.stdout.write('\n');
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (code === 0 || code === null) {
        logSuccess(`Análise concluída em ${elapsed}s`);
      } else {
        logWarning(`Análise encerrou com código ${code} — continuando sem análise completa`);
      }
      resolve();
    });

    proc.on('error', (err) => {
      clearInterval(ticker);
      process.stdout.write('\n');
      logWarning(`Não foi possível executar análise: ${err.message}`);
      resolve();
    });
  });
}

// ── Main preparation entry point ──────────────────────────────────

export interface PrepResult {
  projectId: string | null;
  projectName: string | null;
  analysisRan: boolean;
  boilerplateDetected: string | null;
  ready: boolean;
}

export async function runProjectPreparation(
  repoPath: string,
  cliName?: string,
): Promise<PrepResult> {
  const result: PrepResult = { projectId: null, projectName: null, analysisRan: false, boilerplateDetected: null, ready: false };

  console.log('');
  console.log(bold('◆  Preparando projeto...'));
  console.log(dim('│'));

  try {
    await ensureAuthenticated();
    const api = getApiClient();

    // ── Step 1: Find project link ──────────────────────────────

    let link = readProjectLink(repoPath);
    let project: any = null;

    if (link?.projectId) {
      console.log(`${dim('│')}  ${dim('→')} Projeto vinculado: ${cyan(link.projectName || link.projectId.slice(0, 8))}`);
      try {
        const res = await api.get(`/dark-factory/projects/${link.projectId}`, { timeout: 8_000 });
        project = res.data;
      } catch (err) { swallow(err); }
    }

    // Try to find by localPath or repoUrl
    if (!project) {
      const remoteUrl = getRepoRemoteUrl(repoPath);
      console.log(`${dim('│')}  ${dim('→')} Buscando projeto no servidor...`);

      try {
        // Try by localPath first
        const byPath = await api.get('/dark-factory/projects/by-path', {
          params: { path: repoPath },
          timeout: 8_000,
        });
        if (byPath.data?.id) project = byPath.data;
      } catch (err) { swallow(err); }

      if (!project && remoteUrl) {
        try {
          // Try by repoUrl
          const all = await api.get('/dark-factory/projects', { timeout: 8_000 });
          const projects: any[] = all.data?.data || all.data || [];
          project = projects.find((p: any) =>
            p.repoUrl === remoteUrl ||
            p.repos?.backend?.url === remoteUrl ||
            p.repos?.frontend?.url === remoteUrl ||
            p.repos?.mobile?.url === remoteUrl ||
            p.metadata?.localPath === repoPath,
          ) || null;
        } catch (err) { swallow(err); }
      }
    }

    if (!project) {
      // ── No project found — list all projects and let user select ──
      console.log(`${dim('│')}  ${yellow('⚠')}  Projeto não encontrado automaticamente.`);
      console.log(`${dim('│')}  ${dim('→')} Buscando projetos disponíveis...')}`);

      let projects: any[] = [];
      try {
        const res = await api.get('/dark-factory/projects', { params: { limit: 50 }, timeout: 8_000 });
        projects = res.data?.data || res.data || [];
      } catch (err) { swallow(err); }

      if (projects.length === 0) {
        console.log(`${dim('│')}  ${yellow('⚠')}  Sem projetos na plataforma. Crie um em https://www.zielinski.dev.br/dark-factory`);
        console.log(dim('│'));
        return result;
      }

      console.log(dim('│'));
      console.log(`${dim('│')}  Projetos disponíveis:`);
      projects.slice(0, 20).forEach((p: any, i: number) => {
        const status = p.status ? dim(` · ${p.status}`) : '';
        console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(p.name)} ${dim(`(${p.id.slice(0, 8)})`)}${status}`);
      });
      if (projects.length > 20) {
        console.log(`${dim('│')}    ${dim(`... e mais ${projects.length - 20} projetos`)}`);
      }
      console.log(dim('│'));

      const answer = await ask(`  Qual projeto vincular a ${cyan(path.basename(repoPath))}? ${dim('[número ou Enter para pular]')}: `);
      const idx = parseInt(answer, 10) - 1;

      if (idx >= 0 && idx < projects.length) {
        project = projects[idx];
        console.log(`${dim('│')}  ${green('✓')} Vinculado: ${cyan(project.name)}`);
      } else {
        console.log(`${dim('│')}  ${dim('→ Pulado. Execute: makestudio analyze --deep para criar o vínculo automaticamente.')}`);
        console.log(dim('│'));
        return result;
      }
    }

    result.projectId = project.id;
    result.projectName = project.name;

    // Save link for future runs
    saveProjectLink(repoPath, {
      projectId: project.id,
      projectName: project.name,
      linkedAt: new Date().toISOString(),
    });

    console.log(`${dim('│')}  ${green('✓')} Projeto: ${cyan(project.name)} ${dim(`(${project.id.slice(0, 8)})`)}`);

    // ── Step 1.5: Persist this agent's repoPath to backend ─────
    //
    // The orchestrator dispatches `decomposition:dispatch` over WS with
    // `repoPath: project.metadata?.localPath`. If that field is empty,
    // the agent falls back to `os.tmpdir()` and writes context files
    // there — losing the per-project workspace and breaking two-pass
    // (the CLI subprocess can't find QUALITY_CONTRACT.md / TEMPIDS.md).
    //
    // We push our resolved local path back to the backend so future
    // dispatches arrive with the correct cwd. Best-effort: a 4xx/5xx
    // here doesn't abort startup.
    const persistedPath = project.metadata?.localPath;
    if (persistedPath !== repoPath) {
      try {
        await api.put(
          `/dark-factory/projects/${project.id}`,
          { metadata: { ...(project.metadata || {}), localPath: repoPath } },
          { timeout: 8_000 },
        );
        project.metadata = { ...(project.metadata || {}), localPath: repoPath };
      } catch (err: any) {
        console.log(`${dim('│')}  ${yellow('⚠')} ${dim(`Falha ao registrar localPath no servidor: ${err.message}`)}`);
      }
    }

    // ── Step 2: Check codebase analysis ───────────────────────

    const hasAnalysis = !!(project.metadata?.codebaseAnalysis?.entities?.length ||
                           project.metadata?.codebaseAnalysis?.endpoints?.length);

    if (!hasAnalysis) {
      console.log(`${dim('│')}  ${yellow('⚠')}  Sem análise do codebase — iniciando análise profunda...`);
      console.log(dim('│'));

      if (cliName) {
        await runDeepAnalysis(repoPath, project.id, cliName);
        result.analysisRan = true;
      } else {
        console.log(`${dim('│')}  ${dim('→')} Sem CLI disponível para análise. Execute: ${cyan('makestudio analyze --deep --project-id ' + project.id)}`);
      }
    } else {
      const entityCount = project.metadata.codebaseAnalysis.entities?.length || 0;
      const endpointCount = project.metadata.codebaseAnalysis.endpoints?.length || 0;
      console.log(`${dim('│')}  ${green('✓')} Análise: ${dim(`${entityCount} entities, ${endpointCount} endpoints`)}`);
    }

    // ── Step 3: Check boilerplate ID ──────────────────────────

    if (!project.boilerplateId) {
      const detected = detectBoilerplateFromStructure(repoPath);
      if (detected) {
        console.log(`${dim('│')}  ${dim('→')} Boilerplate detectado: ${cyan(detected)} — atualizando projeto...`);
        try {
          await api.patch(`/dark-factory/projects/${project.id}`, { boilerplateId: detected }, { timeout: 8_000 });
          logSuccess(`Boilerplate ${detected} vinculado ao projeto`);
          result.boilerplateDetected = detected;
        } catch (err) { swallow(err); }
      } else {
        console.log(`${dim('│')}  ${dim('→')} Boilerplate não identificado automaticamente (sem impacto na execução)`);
      }
    } else {
      console.log(`${dim('│')}  ${green('✓')} Boilerplate: ${cyan(project.boilerplateId)}`);
    }

    console.log(dim('│'));
    result.ready = true;
    return result;

  } catch (err: any) {
    console.log(`${dim('│')}  ${yellow('⚠')}  Preparação ignorada: ${dim(err.message || 'erro de conexão')}`);
    console.log(dim('│'));
    return result;
  }
}
